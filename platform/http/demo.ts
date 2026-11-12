import { readFileSync } from 'node:fs';
import type { AppConfig, DemoPersonas } from './app.ts';
import { issueToken } from './auth.ts';
import type { Authenticator } from './authn.ts';

/**
 * Demo login (hackathon demo only — an imitation of SSO, ADR-0009).
 * Enabled only by MODUS_DEMO_LOGIN=true together with dev tokens and outside
 * production; any other combination is refused at startup rather than ignored.
 */
export function demoConfigFromEnv(
  env: NodeJS.ProcessEnv,
  authenticator: Pick<Authenticator, 'mode'>,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): AppConfig['demo'] {
  if (env.MODUS_DEMO_LOGIN !== 'true') return undefined;
  if (env.NODE_ENV === 'production' || authenticator.mode !== 'dev-token') {
    throw new Error('MODUS_DEMO_LOGIN is only allowed with MODUS_AUTH_MODE=dev-token outside production');
  }
  const secret = env.MODUS_AUTH_SECRET;
  if (!secret) throw new Error('MODUS_AUTH_SECRET is required for demo login');
  const personas = JSON.parse(read(env.MODUS_DEMO_PERSONAS ?? '.demo/personas.json')) as DemoPersonas;
  if (!personas?.personas?.length) throw new Error('demo personas file is empty');
  return { personas, issue: (userId) => issueToken(secret, userId, 8 * 3600) };
}
