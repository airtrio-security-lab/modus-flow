import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serves the built web app (web/dist) from the same origin as the API, so the
 * demo runs as one process without CORS. Path traversal is impossible: every
 * path is resolved and must stay inside the root; unknown paths fall back to
 * index.html (client-side routing).
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function createStaticHandler(rootDir: string) {
  const root = resolve(rootDir);
  return async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = '/';
    }
    let file = resolve(root, `.${decoded}`);
    if (file !== root && !file.startsWith(root + sep)) file = resolve(root, 'index.html');
    let isFile = false;
    try {
      isFile = (await stat(file)).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) file = resolve(root, 'index.html');
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Интерфейс не собран: выполните npm run web:build');
      return;
    }
    const ext = extname(file);
    const hashedAsset = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(body.length),
      'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(ext === '.html' ? { 'Content-Security-Policy': PAGE_CSP, 'X-Frame-Options': 'DENY' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
