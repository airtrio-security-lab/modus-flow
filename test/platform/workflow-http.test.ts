import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '../../platform/db/pool.ts';
import { createApp } from '../../platform/http/app.ts';
import { issueToken } from '../../platform/http/auth.ts';
import { freshDatabase, fullDraft, world } from './support/db.ts';

/** The Phase 2 vertical slice over the public HTTP API, exactly as a UI would drive it. */
const SECRET = 'workflow-http-secret-'.padEnd(48, 'z');
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let server: Server;
let base: string;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  server = createServer(createApp({ db, authSecret: SECRET }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await drop();
});

let keySeq = 0;
async function as(p: { userId: string }, method: string, path: string, body?: unknown, key = `k-${++keySeq}-${Date.now()}`) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${issueToken(SECRET, p.userId)}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true', json: text ? JSON.parse(text) : undefined };
}

test('vertical slice over HTTP: idea → review → change request → objection → revision → verification (+/-) → decision', async () => {
  const draft = await as(w.author, 'POST', '/api/v1/lab/drafts', fullDraft);
  const pub = await as(w.author, 'POST', `/api/v1/lab/drafts/${draft.json.id}/publish`, { organization: 'acme' });
  const idea = `/api/v1/orgs/acme/ideas/${pub.json.idea.number}`;

  const assign = await as(w.maintainer, 'POST', `${idea}/assignments`, { maintainer: w.maintainer.membershipId, decisionOwner: w.decider.membershipId });
  assert.equal(assign.status, 201);
  assert.equal(assign.json.stage, 'review');

  const cr = await as(w.maintainer, 'POST', `${idea}/reviews`, { kind: 'request_changes', body: 'Как быть с опоздавшими поставщиками?' });
  assert.equal(cr.json.stage, 'development');

  const objKey = 'objection-key-0001';
  const obj = await as(w.author, 'POST', `${idea}/reviews`, { kind: 'objection', parentReviewId: cr.json.id, body: 'Резервный слот это покрывает' }, objKey);
  const objAgain = await as(w.author, 'POST', `${idea}/reviews`, { kind: 'objection', parentReviewId: cr.json.id, body: 'Резервный слот это покрывает' }, objKey);
  assert.equal(objAgain.replayed, true);
  assert.equal(objAgain.json.id, obj.json.id);

  assert.equal((await as(w.maintainer, 'POST', `${idea}/revisions`, { baseRevision: 1, title: 'Чужая правка', problem: 'x'.repeat(30), proposal: 'y'.repeat(30) })).status, 403);
  const rev = await as(w.author, 'POST', `${idea}/revisions`, {
    baseRevision: 1,
    title: 'Слоты разгрузки с резервом',
    problem: 'Фуры ждут разгрузки около двух часов каждое утро',
    proposal: 'Слоты по 30 минут и резервный слот для опоздавших',
    successCriteria: 'Среднее ожидание меньше 40 минут',
    rationale: 'Учёл замечание про опоздания',
  });
  assert.deepEqual(rev.json, { revision: 2, stage: 'review' });
  assert.equal((await as(w.author, 'POST', `${idea}/reviews/${cr.json.id}/resolve`, { outcome: 'resolved', note: 'сам себе' })).status, 403);
  assert.equal((await as(w.maintainer, 'POST', `${idea}/reviews/${cr.json.id}/resolve`, { outcome: 'resolved', note: 'Резерв снимает вопрос' })).status, 201);

  const v = await as(w.maintainer, 'POST', `${idea}/verifications`, {
    plan: 'Две недели на рампе №2',
    successCriteria: 'Среднее ожидание меньше 40 минут',
    owner: w.colleague.membershipId,
  });
  assert.equal(v.status, 201);
  const ev = `${idea}/verifications/${v.json.id}/evidence`;
  assert.equal((await as(w.colleague, 'POST', ev, { kind: 'result', body: 'Ожидание 34 минуты', metric: 'ожидание', value: 34, unit: 'мин' })).status, 201);
  assert.equal((await as(w.colleague, 'POST', ev, { kind: 'negative_observation', body: 'Сбой записи в пятницу' })).status, 201);
  assert.equal((await as(w.colleague, 'POST', ev, { kind: 'result', body: 'без метрики', value: 5 })).status, 422);

  const concl = await as(w.maintainer, 'POST', `${idea}/verifications/${v.json.id}/conclusion`, { outcome: 'positive', conclusion: 'Критерий достигнут, сбой записи исправить' });
  assert.equal(concl.json.stage, 'decision');

  assert.equal((await as(w.author, 'POST', `${idea}/decision`, { outcome: 'merge', rationale: 'Автор хочет внедрить' })).status, 403);
  const decision = await as(w.decider, 'POST', `${idea}/decision`, { outcome: 'merge', rationale: 'Внедряем с исправлением записи' });
  assert.equal(decision.status, 201);
  assert.equal(decision.json.stage, 'adoption');
  assert.equal((await as(w.decider, 'POST', `${idea}/decision`, { outcome: 'reject', rationale: 'Передумал задним числом' })).status, 409, 'one decision per idea');

  const page = await as(w.colleague, 'GET', idea);
  assert.equal(page.json.stage, 'adoption');
  assert.equal(page.json.revisions.length, 2);
  assert.equal(page.json.reviews.filter((r: { kind: string }) => r.kind === 'objection').length, 1);
  assert.deepEqual(page.json.verifications[0].evidence.map((e: { kind: string }) => e.kind), ['result', 'negative_observation']);
  assert.equal(page.json.decisions[0].verification_summary[0].negativeEvidence, 1);
  assert.doesNotMatch(JSON.stringify(page.json), /ЛИЧНОЕ/);
});

test('HTTP: checks_failed carries the failing checks for the UI', async () => {
  const draft = await as(w.author, 'POST', '/api/v1/lab/drafts', { ...fullDraft, content: { observation: fullDraft.content.observation, proposal: fullDraft.content.proposal } });
  const pub = await as(w.author, 'POST', `/api/v1/lab/drafts/${draft.json.id}/publish`, { organization: 'acme' });
  const idea = `/api/v1/orgs/acme/ideas/${pub.json.idea.number}`;
  await as(w.maintainer, 'POST', `${idea}/assignments`, { maintainer: w.maintainer.membershipId, decisionOwner: w.decider.membershipId });
  const r = await as(w.maintainer, 'POST', `${idea}/verifications`, { plan: 'Пилот две недели', successCriteria: 'Ожидание меньше 40 минут', owner: w.colleague.membershipId });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'checks_failed');
  assert.ok(r.json.details.failing.some((f: { id: string }) => f.id === 'success_criteria'));
});

test('HTTP: another organization cannot act on the idea', async () => {
  const r = await as(w.outsider, 'POST', '/api/v1/orgs/acme/ideas/1/reviews', { kind: 'comment', body: 'чужой' });
  assert.equal(r.status, 404);
});
