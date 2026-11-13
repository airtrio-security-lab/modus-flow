/**
 * Assembles the hosted demo for Vercel (ADR-0033) into a directory OUTSIDE the repository:
 *   <out>/public/**        the built web app (web/dist), served by Vercel's CDN
 *   <out>/api/index.mjs    the API as one self-contained bundle (pg and zod inlined; no install step)
 *   <out>/vercel.json      routes, region, headers of platform/http/static.ts
 *
 *   git worktree add --detach <tmp> origin/main && cd <tmp>     (only committed code; enforced below)
 *   npm run web:build
 *   MODUS_DEMO_PERSONAS=.demo/personas.json node deploy/vercel/build.mjs <out>
 *   cd <out> && npx vercel deploy --prod
 *
 * The personas must belong to the database the deployment talks to (the seeded hosted demo database).
 * The platform itself stays TypeScript without a build (ADR-0005); this bundle is packaging only.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? '');
if (!process.argv[2] || out.startsWith(resolve(root) + '/')) throw new Error('usage: node deploy/vercel/build.mjs <out dir outside the repository>');
const personasPath = resolve(process.env.MODUS_DEMO_PERSONAS ?? join(root, '.demo/personas.json'));
const personas = JSON.parse(readFileSync(personasPath, 'utf8'));
if (!personas?.personas?.length) throw new Error(`no personas in ${personasPath}`);
if (!existsSync(join(root, 'web/dist/index.html'))) throw new Error('web/dist is missing: npm run web:build');
// Only committed code goes to the hosted demo: uncommitted work may expect a migration the demo database
// does not have (that is how the first deployment broke `/kingdom`). Build from a clean `git worktree`.
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'platform', 'web/src', 'web/index.html', 'web/public', 'deploy'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty && process.env.MODUS_DEPLOY_ALLOW_DIRTY !== 'true') {
  throw new Error(`uncommitted changes would go to the hosted demo; build from a clean worktree:\n${dirty}`);
}

// esbuild comes with the web app's toolchain (vite); no new dependency.
const esbuild = createRequire(join(root, 'web/package.json'))('esbuild');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'api'), { recursive: true });
cpSync(join(root, 'web/dist'), join(out, 'public'), { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'deploy/vercel/entry.ts')],
  outfile: join(out, 'api/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // pg loads its optional native binding lazily; it is never used here.
  external: ['pg-native'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [
    {
      name: 'personas',
      setup(b) {
        b.onResolve({ filter: /^virtual:personas$/ }, () => ({ path: 'personas', namespace: 'virtual' }));
        b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: JSON.stringify(personas), loader: 'json' }));
      },
    },
  ],
  logLevel: 'warning',
});

// The same headers as platform/http/static.ts gives the page and the hashed assets.
const { PAGE_CSP } = await import(join(root, 'platform/http/static.ts'));
const vercel = {
  // Already built: nothing to install or build on Vercel.
  framework: null,
  installCommand: '',
  buildCommand: '',
  outputDirectory: 'public',
  regions: ['fra1'],
  functions: { 'api/index.mjs': { maxDuration: 30, memory: 1024 } },
  rewrites: [{ source: '/api/(.*)', destination: '/api/index' }],
  headers: [
    { source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'no-referrer' }] },
    { source: '/', headers: [{ key: 'Content-Security-Policy', value: PAGE_CSP }, { key: 'X-Frame-Options', value: 'DENY' }, { key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/index.html', headers: [{ key: 'Content-Security-Policy', value: PAGE_CSP }, { key: 'X-Frame-Options', value: 'DENY' }, { key: 'Cache-Control', value: 'no-cache' }] },
    { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
  ],
};
writeFileSync(join(out, 'vercel.json'), JSON.stringify(vercel, null, 2));
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'modus-flow-demo', private: true, type: 'module' }, null, 2));
console.log(`hosted demo assembled in ${out}: ${personas.personas.length} personas`);
