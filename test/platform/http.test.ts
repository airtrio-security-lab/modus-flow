import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '../../platform/db/pool.ts';
import { createApp } from '../../platform/http/app.ts';
import { issueToken } from '../../platform/http/auth.ts';
import { freshDatabase, fullDraft, world } from './support/db.ts';

const SECRET = 'test-secret-'.padEnd(48, 'x');
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let server: Server;
let base: string;
const logs: Record<string, unknown>[] = [];

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  server = createServer(createApp({ db, authSecret: SECRET, log: (e) => logs.push(e) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await drop();
});

const tokenFor = (p: { userId: string }) => issueToken(SECRET, p.userId);

async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(base + path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

test('health is public, everything else needs a valid token', async () => {
  assert.equal((await call('GET', '/api/v1/health')).status, 200);
  assert.equal((await call('GET', '/api/v1/me')).status, 401);
  assert.equal((await call('GET', '/api/v1/me', { token: 'demo-employee' })).status, 401, 'prototype demo tokens are not accepted');
  const forged = issueToken('another-secret'.padEnd(40, 'y'), w.author.userId);
  assert.equal((await call('GET', '/api/v1/me', { token: forged })).status, 401);
  const expired = issueToken(SECRET, w.author.userId, 1, Date.now() - 10_000);
  assert.equal((await call('GET', '/api/v1/me', { token: expired })).status, 401);
});

test('me lists memberships with roles from the database', async () => {
  const r = await call('GET', '/api/v1/me', { token: tokenFor(w.maintainer) });
  assert.equal(r.status, 200);
  assert.equal(r.json.displayName, 'Мария Ведущая');
  assert.deepEqual(r.json.memberships.map((m: { organization: string }) => m.organization), ['acme']);
  assert.deepEqual(r.json.memberships[0].roles, ['employee', 'maintainer']);
});

test('end-to-end: capture privately, revise, publish once, see it in the organization', async () => {
  const token = tokenFor(w.author);
  const created = await call('POST', '/api/v1/lab/drafts', { token, body: { title: 'Улучшение ✓ «склад»', content: { observation: 'Фуры ждут разгрузки по два часа' } } });
  assert.equal(created.status, 201);
  assert.equal(created.json.title, 'Улучшение ✓ «склад»', 'multi-byte UTF-8 survives the round trip');

  const v2 = await call('POST', `/api/v1/lab/drafts/${created.json.id}/versions`, {
    token,
    body: { baseVersion: 1, title: created.json.title, content: { ...fullDraft.content } },
  });
  assert.equal(v2.status, 201);
  assert.equal(v2.json.version, 2);

  const headers = { 'idempotency-key': 'http-publish-0001' };
  const pub = await call('POST', `/api/v1/lab/drafts/${created.json.id}/publish`, { token, body: { organization: 'acme' }, headers });
  assert.equal(pub.status, 201);
  const replay = await call('POST', `/api/v1/lab/drafts/${created.json.id}/publish`, { token, body: { organization: 'acme' }, headers });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(replay.json.idea.number, pub.json.idea.number);

  const idea = await call('GET', `/api/v1/orgs/acme/ideas/${pub.json.idea.number}`, { token: tokenFor(w.colleague) });
  assert.equal(idea.status, 200);
  assert.doesNotMatch(JSON.stringify(idea.json), /ЛИЧНОЕ/);
  const checks = Object.fromEntries(idea.json.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
  assert.equal(checks.maintainer_assigned, 'fail');
  assert.equal(checks.success_criteria, 'pass');
  assert.equal(checks.field_verification, 'warn');

  const inbox = await call('GET', '/api/v1/orgs/acme/notifications', { token: tokenFor(w.maintainer) });
  const n = inbox.json.find((x: { ideaNumber: number }) => x.ideaNumber === pub.json.idea.number);
  assert.match(n.message, /^Кирилл Демо предлагает на обсуждение новую идею/);
  const read = await call('POST', '/api/v1/orgs/acme/notifications/read', { token: tokenFor(w.maintainer), body: { ids: [n.id] } });
  assert.equal(read.json.updated, 1);
  const stolen = await call('POST', '/api/v1/orgs/acme/notifications/read', { token: tokenFor(w.decider), body: { ids: [n.id] } });
  assert.equal(stolen.json.updated, 0, 'cannot touch someone else\'s inbox');
});

test('cross-organization access looks exactly like a missing organization', async () => {
  const token = tokenFor(w.outsider);
  const a = await call('GET', '/api/v1/orgs/acme/ideas', { token });
  const b = await call('GET', '/api/v1/orgs/does-not-exist/ideas', { token });
  assert.equal(a.status, 404);
  assert.deepEqual(a.json, b.json);
  assert.equal((await call('GET', '/api/v1/orgs/beta/ideas', { token })).status, 200);
});

test('another user\'s draft id is indistinguishable from a missing one', async () => {
  const mine = await call('POST', '/api/v1/lab/drafts', { token: tokenFor(w.author), body: { title: 'Моя тайна', content: {} } });
  const theirs = await call('GET', `/api/v1/lab/drafts/${mine.json.id}`, { token: tokenFor(w.admin) });
  const none = await call('GET', '/api/v1/lab/drafts/00000000-0000-4000-8000-000000000000', { token: tokenFor(w.admin) });
  assert.equal(theirs.status, 404);
  assert.deepEqual(theirs.json, none.json);
});

test('input validation: content type, JSON, unknown fields, size', async () => {
  const token = tokenFor(w.author);
  assert.equal((await call('POST', '/api/v1/lab/drafts', { token, raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('POST', '/api/v1/lab/drafts', { token, raw: '{bad', headers: { 'content-type': 'application/json' } })).status, 422);
  const extra = await call('POST', '/api/v1/lab/drafts', { token, body: { title: 'Норм заголовок', content: {}, authorId: 'someone-else' } });
  assert.equal(extra.status, 422, 'clients cannot smuggle authorship fields');
  const big = await call('POST', '/api/v1/lab/drafts', { token, body: { title: 'Большой', content: { notes: 'я'.repeat(200_000) } } });
  assert.equal(big.status, 413);
  assert.equal((await call('GET', '/api/v1/orgs/acme/ideas?stage=bogus', { token })).status, 422);
  assert.equal((await call('DELETE', '/api/v1/me', { token })).status, 405);
});

test('errors do not leak database internals', async () => {
  const r = await call('GET', '/api/v1/orgs/acme/ideas/999999', { token: tokenFor(w.author) });
  assert.equal(r.status, 404);
  assert.doesNotMatch(JSON.stringify(r.json), /SELECT|relation|policy|pg_/i);
  assert.ok(logs.some((l) => l.status === 404 && typeof l.requestId === 'string'));
});

test('a validly signed token for a non-existent user is rejected, without schema details', async () => {
  const ghost = issueToken(SECRET, '00000000-0000-4000-8000-00000000dead');
  const r = await call('POST', '/api/v1/lab/drafts', { token: ghost, body: { title: 'Призрак', content: {} } });
  assert.equal(r.status, 401);
  assert.doesNotMatch(JSON.stringify(r.json), /constraint|fkey|_id/);
});
