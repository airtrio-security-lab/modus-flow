import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '../../platform/db/pool.ts';
import { createApp } from '../../platform/http/app.ts';
import { issueToken } from '../../platform/http/auth.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, problemText } from './support/feedback.ts';

/** Feedback MVP over the public HTTP API, as the UI will drive it. */
const SECRET = 'feedback-http-secret-'.padEnd(48, 'q');
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let server: Server;
let base: string;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  server = createServer(createApp({ db, authSecret: SECRET }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await drop();
});

type Who = { userId: string };
async function call(who: Who, method: string, path: string, init: { json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${issueToken(SECRET, who.userId)}`, ...init.headers };
  let body: string | Uint8Array | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.body) body = new Uint8Array(init.body);
  const res = await fetch(base + path, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json');
  return { status: res.status, headers: res.headers, json: isJson && buf.length ? JSON.parse(buf.toString('utf8')) : undefined, buf };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
const upload = (who: Who, n: number, data: Buffer, type: string, name = 'фото склада.png') =>
  call(who, 'POST', `/api/v1/orgs/acme/ideas/${n}/attachments`, {
    body: data,
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
  });

let itemNumber = 0;

test('submit → routed → visible in "my items" with a human status', async () => {
  const r = await call(w.author, 'POST', '/api/v1/orgs/acme/ideas', {
    json: { kind: 'problem', title: 'Сканеры зависают при приёмке', problem: problemText, categoryId: f.categories.it },
    headers: { 'idempotency-key': 'submit-http-0001' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.item.status, 'in_review');
  itemNumber = r.json.item.number;
  const again = await call(w.author, 'POST', '/api/v1/orgs/acme/ideas', {
    json: { kind: 'problem', title: 'Сканеры зависают при приёмке', problem: problemText, categoryId: f.categories.it },
    headers: { 'idempotency-key': 'submit-http-0001' },
  });
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(again.json.item.number, itemNumber);

  const mine = await call(w.author, 'GET', '/api/v1/orgs/acme/ideas?mine=true');
  const row = mine.json.find((x: { number: number }) => x.number === itemNumber);
  assert.equal(row.status, 'in_review');
  assert.equal(row.maintainer, 'Мария Ведущая');
  assert.ok(row.firstResponseDueAt);
});

test('list filters are validated; unknown parameters are rejected', async () => {
  assert.equal((await call(w.author, 'GET', '/api/v1/orgs/acme/ideas?status=bogus')).status, 422);
  assert.equal((await call(w.author, 'GET', '/api/v1/orgs/acme/ideas?hack=1')).status, 422);
  assert.equal((await call(w.author, 'GET', '/api/v1/orgs/acme/ideas?q=скане&open=true')).status, 200);
  const sim = await call(w.colleague, 'GET', `/api/v1/orgs/acme/ideas/similar?q=${encodeURIComponent('зависают сканеры')}`);
  assert.ok(sim.json.some((x: { number: number }) => x.number === itemNumber));
});

test('attachments: upload, list on the item page, exact download with safe headers', async () => {
  const up = await upload(w.author, itemNumber, PNG, 'image/png');
  assert.equal(up.status, 201);
  assert.equal(up.json.sizeBytes, PNG.length);
  const page = await call(w.maintainer, 'GET', `/api/v1/orgs/acme/ideas/${itemNumber}`);
  assert.equal(page.json.attachments[0].fileName, 'фото склада.png');
  assert.equal(page.json.attachments[0].data, undefined, 'item page never inlines file bytes');
  const dl = await call(w.maintainer, 'GET', `/api/v1/orgs/acme/ideas/${itemNumber}/attachments/${up.json.id}`);
  assert.equal(dl.status, 200);
  assert.ok(dl.buf.equals(PNG));
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''/);
  assert.match(dl.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
});

test('attachments: type allow-list, real signature, size and count limits', async () => {
  assert.equal((await upload(w.author, itemNumber, Buffer.from('<script>alert(1)</script>'), 'text/html', 'x.html')).status, 415);
  assert.equal((await upload(w.author, itemNumber, Buffer.from('not a png at all'), 'image/png')).status, 422, 'declared type must match content');
  assert.equal((await upload(w.author, itemNumber, Buffer.alloc(5 * 1024 * 1024 + 1, 1), 'text/plain', 'big.txt')).status, 413);
  assert.equal((await upload(w.author, itemNumber, PNG, 'image/png', '../../etc/passwd')).status, 422);
  for (let i = 0; i < 9; i++) assert.equal((await upload(w.author, itemNumber, Buffer.from(`заметка ${i}`), 'text/plain', `n${i}.txt`)).status, 201);
  assert.equal((await upload(w.author, itemNumber, Buffer.from('одиннадцатый'), 'text/plain', 'n11.txt')).status, 422, 'at most 10 per item');
});

test('attachments: invisible to other organizations and to unassigned guests; immutable', async () => {
  const id = (await ownerQuery<{ id: string }>(db, 'SELECT a.id FROM attachments a JOIN ideas i ON i.id = a.idea_id WHERE i.number = $1 LIMIT 1', [itemNumber]))[0]!.id;
  assert.equal((await call(w.outsider, 'GET', `/api/v1/orgs/acme/ideas/${itemNumber}/attachments/${id}`)).status, 404);
  const guest = await person(db, w.acmeId, 'Гость Файлов', ['maintainer'], 'Внешний', 'guest');
  assert.equal((await call(guest, 'GET', `/api/v1/orgs/acme/ideas/${itemNumber}/attachments/${id}`)).status, 404);
  await assert.rejects(ownerQuery(db, 'DELETE FROM attachments WHERE id = $1', [id]));
});

test('directory serves the submission form; admin endpoints need org_admin', async () => {
  const dir = await call(w.author, 'GET', '/api/v1/orgs/acme/directory');
  assert.ok(dir.json.categories.some((c: { name: string }) => c.name === 'ИТ и инструменты'));
  assert.ok(dir.json.departments.some((d: { name: string; head: string }) => d.name === 'Склад' && d.head === 'Начальник Склада'));
  assert.equal((await call(w.maintainer, 'POST', '/api/v1/orgs/acme/categories', { json: { name: 'Не админ' } })).status, 403);
  const created = await call(w.admin, 'POST', '/api/v1/orgs/acme/categories', { json: { name: 'Клиенты и заказчики' } });
  assert.equal(created.status, 201);
  assert.equal((await call(w.admin, 'PATCH', `/api/v1/orgs/acme/categories/${created.json.id}`, { json: { active: false } })).status, 200);
  const rules = await call(w.admin, 'GET', '/api/v1/orgs/acme/routing-rules');
  assert.ok(rules.json.some((r: { category: string; maintainerName: string }) => r.category === 'ИТ и инструменты' && r.maintainerName === 'Мария Ведущая'));
  assert.equal((await call(w.admin, 'PATCH', '/api/v1/orgs/acme/settings', { json: { staleDays: 5 } })).status, 200);
});

test('implementation over HTTP: implementer reports completion', async () => {
  const r = await call(w.author, 'POST', '/api/v1/orgs/acme/ideas', {
    json: {
      kind: 'idea',
      title: 'Таблички на стеллажах',
      problem: problemText,
      proposal: 'Повесить таблички с номерами рядов, чтобы новички не путались',
      departmentId: f.departments.sklad,
    },
  });
  const n = r.json.item.number;
  const idea = `/api/v1/orgs/acme/ideas/${n}`;
  assert.equal((await call(f.head, 'POST', `${idea}/decision`, { json: { outcome: 'merge', rationale: 'Дёшево и полезно, делаем', implementer: w.colleague.membershipId } })).status, 201);
  assert.equal((await call(w.colleague, 'POST', `${idea}/implementation`, { json: { report: 'Таблички повешены на всех 12 рядах' } })).status, 201);
  const page = await call(w.author, 'GET', idea);
  assert.equal(page.json.status, 'implemented');
  assert.equal(page.json.implementer, 'Анна Коллега');
});

test('analytics endpoint: leads only, period filter validated', async () => {
  assert.equal((await call(w.colleague, 'GET', '/api/v1/orgs/acme/analytics')).status, 403);
  assert.equal((await call(f.escalation, 'GET', '/api/v1/orgs/acme/analytics?from=2026-13-40')).status, 422);
  const a = await call(f.escalation, 'GET', '/api/v1/orgs/acme/analytics?from=2026-01-01');
  assert.equal(a.status, 200);
  assert.ok(a.json.totals.total >= 2);
  assert.ok(Array.isArray(a.json.byCategory) && Array.isArray(a.json.needsAttention));
});
