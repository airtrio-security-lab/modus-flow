import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serves the built web app (web/dist) from the same origin as the API, so the
 * demo runs as one process without CORS. Path traversal is impossible: every
 * path is resolved and must stay inside the root; unknown paths fall back to
 * index.html (client-side routing).
 *
 * Media (cinematic notifications, ADR-0037): a video is served with its real type and
 * answers byte ranges (206), which iOS Safari requires to play it. A missing media file
 * is a 404, never index.html, so the player falls back to its text notification at once.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
};
/** Files that must exist: no client-side routing fallback for them. */
const MEDIA = new Set(['.mp4', '.vtt']);

/** One byte range of `bytes=a-b`, `bytes=a-` or `bytes=-n`; null = not satisfiable; undefined = no usable range. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges or another unit: answer with the whole file, which is always allowed.
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
  return { start, end };
}

export const PAGE_CSP = [
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
    if (!isFile && MEDIA.has(extname(file))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end('Не найдено');
      return;
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
    if (MEDIA.has(ext)) {
      const common = {
        'Content-Type': TYPES[ext]!,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      };
      const range = parseRange(req.headers.range, body.length);
      if (range === null) {
        res.writeHead(416, { ...common, 'Content-Range': `bytes */${body.length}` }).end();
        return;
      }
      if (range) {
        const part = body.subarray(range.start, range.end + 1);
        res.writeHead(206, { ...common, 'Content-Range': `bytes ${range.start}-${range.end}/${body.length}`, 'Content-Length': String(part.length) });
        res.end(req.method === 'HEAD' ? undefined : part);
        return;
      }
      res.writeHead(200, { ...common, 'Content-Length': String(body.length) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
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
