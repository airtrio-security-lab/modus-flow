import { createServer } from 'node:http';
import { assertUnprivilegedConnection, createDatabase } from './db/pool.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './http/app.ts';
import { demoConfigFromEnv } from './http/demo.ts';
import { authenticatorFromEnv } from './http/authn.ts';
import { isRemote, modelConfigFromEnv } from './modules/advisor-model.ts';
import { transcribeConfigFromEnv } from './modules/transcribe.ts';

/**
 * MODUS FLOW platform API (v1). Runs alongside the legacy prototype
 * (src/server.js, port 3000) until the UI moves over.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const authenticator = authenticatorFromEnv(process.env);
const port = Number(process.env.PLATFORM_PORT ?? 3100);
const host = process.env.PLATFORM_HOST ?? '127.0.0.1';

const db = createDatabase(databaseUrl);
if (process.env.MIGRATION_DATABASE_URL && process.env.MODUS_MIGRATE_ON_START === 'true') {
  const owner = createDatabase(process.env.MIGRATION_DATABASE_URL, 1);
  try {
    console.log(JSON.stringify({ level: 'info', migrations: await migrate(owner) }));
  } finally {
    await owner.close();
  }
}
if (process.env.MODUS_ALLOW_PRIVILEGED_DB === 'true') {
  console.warn(JSON.stringify({ level: 'warn', msg: 'MODUS_ALLOW_PRIVILEGED_DB=true: RLS can be bypassed. Local development only.' }));
} else {
  await assertUnprivilegedConnection(db);
}
if (!authenticator.productionReady) {
  console.warn(JSON.stringify({ level: 'warn', msg: `auth mode ${authenticator.mode} is for development only (ADR-0009)` }));
}
// Demo login: only with an explicit flag, dev tokens, and never in production.
const demo = demoConfigFromEnv(process.env, authenticator);
if (demo) {
  console.warn(JSON.stringify({ level: 'warn', msg: 'DEMO LOGIN ENABLED: anyone can sign in as a demo persona. Never use with real data.' }));
}
const staticDir = process.env.MODUS_WEB_DIR ?? (process.env.MODUS_SERVE_WEB === 'true' ? 'web/dist' : undefined);
// MODUS ADVISOR: rules by default; a local model only when configured explicitly (ADR-0013).
const advisorModel = modelConfigFromEnv(process.env);
console.log(JSON.stringify({ level: 'info', advisor: advisorModel ? `${isRemote(advisorModel) ? 'CLOUD' : 'local'} model ${advisorModel.model} at ${advisorModel.url}${isRemote(advisorModel) ? ' — texts sent for analysis leave the company (ADR-0028)' : ''}` : 'rules only (no AI model connected)' }));
const transcribeEngine = transcribeConfigFromEnv(process.env);
console.log(JSON.stringify({ level: 'info', transcription: transcribeEngine ? `local engine ${transcribeEngine.model} at ${transcribeEngine.url}` : 'no engine (manual or prepared transcripts only)' }));
const handler = createApp({ db, authenticator, staticDir, demo, advisorModel, transcribeEngine, log: (e) => console.log(JSON.stringify(e)) });
const server = createServer((req, res) => void handler(req, res));
server.listen(port, host, () => console.log(JSON.stringify({ level: 'info', msg: `MODUS FLOW platform API on ${host}:${port}` })));

const shutdown = () => server.close(() => void db.close().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
