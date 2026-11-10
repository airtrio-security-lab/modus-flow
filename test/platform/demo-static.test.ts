import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '../../platform/db/pool.ts';
import { createApp, type DemoPersonas } from '../../platform/http/app.ts';
import { issueToken } from '../../platform/http/auth.ts';
import { demoConfigFromEnv } from '../../platform/http/demo.ts';
import { freshDatabase, world } from './support/db.ts';

/** Demo login (SSO imitation for the hackathon demo) and same-origin web hosting. */
const SECRET = 'demo-static-secret-'.padEnd(48, 'z');
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let web: string;
const servers: Server[] = [];

async function serve(config: Parameters<typeof createApp>[0]) {
  const s = createServer(createApp(config));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  web = await mkdtemp(join(tmpdir(), 'modus-web-'));
  await mkdir(join(web, 'assets'));
  await writeFile(join(web, 'index.html'), '<!doctype html><title>MODUS FLOW</title><div id="root"></div>');
  await writeFile(join(web, 'assets', 'app-1a2b.js'), 'console.log(1)');
  await writeFile(join(web, 'manifest.webmanifest'), '{}');
});
after(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await rm(web, { recursive: true, force: true });
  await drop();
});

const personas = (): DemoPersonas => ({
  organization: 'acme',
  organizationName: 'Acme Demo',
  personas: [{ userId: w.author.userId, name: 'Кирилл Демо', title: 'Кладовщик', department: 'Склад', hint: 'Подаёт обращение' }],
});

test('demo login is refused in production, without dev tokens, and without a secret', () => {
  const read = () => JSON.stringify(personas());
  assert.equal(demoConfigFromEnv({}, { mode: 'dev-token' }, read), undefined, 'off unless explicitly enabled');
  assert.throws(() => demoConfigFromEnv({ MODUS_DEMO_LOGIN: 'true', NODE_ENV: 'production', MODUS_AUTH_SECRET: SECRET }, { mode: 'dev-token' }, read), /only allowed/);
  assert.throws(() => demoConfigFromEnv({ MODUS_DEMO_LOGIN: 'true', MODUS_AUTH_SECRET: SECRET }, { mode: 'oidc' }, read), /only allowed/);
  assert.throws(() => demoConfigFromEnv({ MODUS_DEMO_LOGIN: 'true' }, { mode: 'dev-token' }, read), /SECRET/);
  assert.ok(demoConfigFromEnv({ MODUS_DEMO_LOGIN: 'true', MODUS_AUTH_SECRET: SECRET }, { mode: 'dev-token' }, read));
});

test('without demo config the demo endpoints do not exist', async () => {
  const base = await serve({ db, authSecret: SECRET });
  assert.equal((await fetch(`${base}/api/v1/demo/personas`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/demo/login`, { method: 'POST', body: JSON.stringify({ userId: w.author.userId }) })).status, 404);
});

test('demo login issues a working token only for listed personas', async () => {
  const base = await serve({ db, authSecret: SECRET, demo: { personas: personas(), issue: (u) => issueToken(SECRET, u, 3600) } });
  const list = (await (await fetch(`${base}/api/v1/demo/personas`)).json()) as DemoPersonas;
  assert.equal(list.personas.length, 1);
  const post = (userId: string) =>
    fetch(`${base}/api/v1/demo/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) });
  const ok = await post(w.author.userId);
  assert.equal(ok.status, 200);
  const { token } = (await ok.json()) as { token: string };
  const me = await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
  assert.equal((await post(w.admin.userId)).status, 403, 'a real member who is not a demo persona cannot be impersonated');
  assert.equal((await post('not-a-uuid')).status, 422);
});

test('the web app is served from the same origin with a strict CSP; traversal and API paths are not served as files', async () => {
  const base = await serve({ db, authSecret: SECRET, staticDir: web });
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
  assert.match(await index.text(), /MODUS FLOW/);

  const spa = await fetch(`${base}/items/42`);
  assert.match(await spa.text(), /id="root"/, 'client-side routes fall back to index.html');

  const asset = await fetch(`${base}/assets/app-1a2b.js`);
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);

  for (const p of ['/%2e%2e/%2e%2e/package.json', '/..%2fpackage.json', '/assets/..%2f..%2fpackage.json']) {
    const r = await fetch(`${base}${p}`);
    const body = await r.text();
    assert.ok(!body.includes('"name"'), `${p} must not leak files outside the web root`);
  }
  const api = await fetch(`${base}/api/v1/nope`);
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type') ?? '', /json/, 'unknown API paths stay JSON errors');
});
