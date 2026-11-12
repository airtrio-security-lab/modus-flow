import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createStaticHandler, parseRange } from '../../platform/http/static.ts';

/**
 * Same-origin static hosting of media for cinematic notifications (ADR-0031), without a database:
 * real video type, byte ranges (iOS Safari plays video only with 206 answers), 404 instead of the
 * client-side routing page for a missing media file. Pages and scripts keep their old behaviour.
 */
let root: string;
let server: Server;
let base: string;
const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'modus-static-'));
  await mkdir(join(root, 'cinematics'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>app</title>');
  await writeFile(join(root, 'cinematics', 'scene.mp4'), video);
  await writeFile(join(root, 'assets', 'app-1.js'), 'export {}');
  const serve = createStaticHandler(root);
  server = createServer((req, res) => void serve(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

test('a video is served with its type, its length and an offer of byte ranges', async () => {
  const r = await fetch(`${base}/cinematics/scene.mp4`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await r.arrayBuffer()).length, 1000);
});

test('byte ranges answer 206 with exactly the asked bytes (iOS Safari asks for 0-1 first)', async () => {
  for (const [range, start, end] of [['bytes=0-1', 0, 1], ['bytes=100-199', 100, 199], ['bytes=900-', 900, 999], ['bytes=-10', 990, 999], ['bytes=950-5000', 950, 999]] as const) {
    const r = await fetch(`${base}/cinematics/scene.mp4`, { headers: { range } });
    assert.equal(r.status, 206, range);
    assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/1000`, range);
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.length, end - start + 1, range);
    assert.deepEqual(body, video.subarray(start, end + 1), range);
  }
});

test('a range past the end is 416; several ranges or another unit get the whole file', async () => {
  const past = await fetch(`${base}/cinematics/scene.mp4`, { headers: { range: 'bytes=1000-1001' } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), 'bytes */1000');
  await past.arrayBuffer();
  for (const range of ['bytes=0-1,5-6', 'items=0-1', 'bytes=-']) {
    const r = await fetch(`${base}/cinematics/scene.mp4`, { headers: { range } });
    assert.equal(r.status, 200, range);
    await r.arrayBuffer();
  }
  assert.equal(parseRange('bytes=-0', 1000), null);
  assert.equal(parseRange('bytes=5-2', 1000), null);
  assert.equal(parseRange(undefined, 1000), undefined);
});

test('a missing video is a 404, not the application page', async () => {
  const r = await fetch(`${base}/cinematics/missing.mp4`);
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type') ?? '', /^text\/plain/);
  await r.arrayBuffer();
  const traversal = await fetch(`${base}/cinematics/..%2F..%2Fetc%2Fpasswd.mp4`);
  assert.notEqual(traversal.status, 206);
  assert.ok(!(await traversal.text()).includes('root:'), 'nothing outside the root is served');
});

test('pages and scripts keep their behaviour: routing fallback, immutable hashed assets', async () => {
  const page = await fetch(`${base}/some/route`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  assert.ok(page.headers.get('content-security-policy'));
  assert.match(await page.text(), /<title>app<\/title>/);
  const asset = await fetch(`${base}/assets/app-1.js`);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(asset.headers.get('accept-ranges'), null);
  await asset.arrayBuffer();
});
