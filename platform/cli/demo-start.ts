import { randomBytes } from 'node:crypto';

/**
 * Starts the hackathon demo: API + built web app on one port, demo sign-in
 * (an imitation of SSO, ADR-0009). Defaults suit docker compose; anything set
 * in the environment wins. Refuses to run with NODE_ENV=production.
 *
 *   npm run demo:seed && npm run web:build && npm run demo:start
 */
if (process.env.NODE_ENV === 'production') throw new Error('demo-start is for local demos only');
const defaults: Record<string, string> = {
  DATABASE_URL: 'postgres://modus_api:modus-api-local-only@127.0.0.1:5432/modus',
  MODUS_AUTH_MODE: 'dev-token',
  // A fresh secret per start: demo sessions end when the demo server restarts.
  MODUS_AUTH_SECRET: randomBytes(32).toString('hex'),
  MODUS_DEMO_LOGIN: 'true',
  MODUS_DEMO_PERSONAS: '.demo/personas.json',
  MODUS_SERVE_WEB: 'true',
};
for (const [k, v] of Object.entries(defaults)) process.env[k] ??= v;
await import('../main.ts');
