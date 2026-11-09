import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Interim session tokens: `v1.<payload>.<hmac-sha256>` signed with
 * MODUS_AUTH_SECRET. They are issued only by the operator CLI
 * (platform/cli/issue-token.ts) and carry the user id and expiry — no roles:
 * roles are always read from the database per request.
 *
 * This is a stand-in until SSO/OIDC (docs/adr/0004). It is NOT the prototype's
 * public demo tokens: there is no default secret and the server refuses to
 * start without a strong one.
 */
export interface TokenClaims {
  sub: string;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function assertSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) {
    throw new Error('MODUS_AUTH_SECRET must be set to at least 32 characters');
  }
  return secret;
}

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`v1.${payload}`).digest();
}

export function issueToken(secret: string, userId: string, ttlSeconds = 8 * 3600, now = Date.now()): string {
  const payload = b64(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + ttlSeconds } satisfies TokenClaims));
  return `v1.${payload}.${b64(sign(secret, payload))}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function verifyToken(secret: string, token: string, now = Date.now()): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, mac] = parts as [string, string, string];
  const expected = sign(secret, payload);
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TokenClaims>;
    if (typeof claims.sub !== 'string' || !UUID.test(claims.sub)) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    return { sub: claims.sub, exp: claims.exp };
  } catch {
    return null;
  }
}
