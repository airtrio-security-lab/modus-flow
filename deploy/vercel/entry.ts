import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertUnprivilegedConnection, createDatabase } from '../../platform/db/pool.ts';
import { createApp } from '../../platform/http/app.ts';
import { demoConfigFromEnv } from '../../platform/http/demo.ts';
import { authenticatorFromEnv } from '../../platform/http/authn.ts';
// Bundled at build time (deploy/vercel/build.mjs): the personas of the seeded hosted demo database.
import personas from 'virtual:personas';

/**
 * The hosted demo on Vercel (ADR-0033): the same API as `platform/main.ts`, as one Vercel Function.
 * Static files are served by Vercel itself; this function answers `/api/*` only.
 *
 * Demo data only. The guards of ADR-0009 stay in place: Vercel runs functions with NODE_ENV=production,
 * so the hosted demo is enabled by an explicit MODUS_HOSTED_DEMO=true, and only then is the demo
 * environment handed to the same guards as on a laptop. Without that flag the function refuses to start.
 */
if (process.env.MODUS_HOSTED_DEMO !== 'true') throw new Error('MODUS_HOSTED_DEMO=true is required: this entry is for the hosted demo with demo data only');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!process.env.MODUS_AUTH_SECRET) throw new Error('MODUS_AUTH_SECRET is required (a fixed secret: several function instances must accept one token)');

const env = { ...process.env, NODE_ENV: 'development', MODUS_AUTH_MODE: 'dev-token', MODUS_DEMO_LOGIN: 'true' };
const authenticator = authenticatorFromEnv(env);
const demo = demoConfigFromEnv(env, authenticator, () => JSON.stringify(personas));
// One small pool per function instance; Neon's pooler (PgBouncer, transaction mode) sits behind it.
const db = createDatabase(databaseUrl, 3);
const checked = assertUnprivilegedConnection(db);
const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
log({ level: 'warn', msg: 'HOSTED DEMO: demo login is open to anyone with the link. Demo data only (ADR-0033).' });
const app = createApp({ db, authenticator, demo, advisorModel: null, transcribeEngine: null, log });

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await checked;
  await app(req, res);
}
