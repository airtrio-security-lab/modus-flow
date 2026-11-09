import { createServer } from 'node:http';
import { createDatabase } from './db/pool.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './http/app.ts';
import { assertSecret } from './http/auth.ts';

/**
 * MODUS FLOW platform API (v1). Runs alongside the legacy prototype
 * (src/server.js, port 3000) until the UI moves over.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const authSecret = assertSecret(process.env.MODUS_AUTH_SECRET);
const port = Number(process.env.PLATFORM_PORT ?? 3100);
const host = process.env.PLATFORM_HOST ?? '127.0.0.1';

const db = createDatabase(databaseUrl);
if (process.env.MODUS_MIGRATE_ON_START === 'true') {
  const r = await migrate(db);
  console.log(JSON.stringify({ level: 'info', migrations: r }));
}
const handler = createApp({ db, authSecret, log: (e) => console.log(JSON.stringify(e)) });
const server = createServer((req, res) => void handler(req, res));
server.listen(port, host, () => console.log(JSON.stringify({ level: 'info', msg: `MODUS FLOW platform API on ${host}:${port}` })));

const shutdown = () => server.close(() => void db.close().then(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
