import { assertSecret, verifyToken } from './auth.ts';

/**
 * Authentication boundary (ADR-0009). The HTTP layer only ever asks an
 * Authenticator "who is this bearer?" and receives a local user id; roles and
 * memberships always come from the database.
 *
 * Implementations:
 *  - DevTokenAuthenticator — HMAC tokens from the operator CLI. NOT a production
 *    solution: refused when NODE_ENV=production.
 *  - OIDC (planned) — validates an ID/access token from the organization's
 *    identity provider (issuer, audience, signature via JWKS, expiry), then maps
 *    the `sub` claim to users.external_subject. Provider is chosen after the
 *    Modus Trade infrastructure review; the interface does not change.
 */
export interface Authenticator {
  readonly mode: 'dev-token' | 'oidc';
  readonly productionReady: boolean;
  /** Returns the local user id for a bearer token, or null. Never throws for bad tokens. */
  authenticate(bearer: string): Promise<{ userId: string } | null>;
}

export class DevTokenAuthenticator implements Authenticator {
  readonly mode = 'dev-token' as const;
  readonly productionReady = false;
  readonly #secret: string;
  constructor(secret: string | undefined) {
    this.#secret = assertSecret(secret);
  }
  async authenticate(bearer: string) {
    const claims = verifyToken(this.#secret, bearer);
    return claims ? { userId: claims.sub } : null;
  }
}

/** Selects the authenticator from configuration and refuses unsafe combinations. */
export function authenticatorFromEnv(env: NodeJS.ProcessEnv): Authenticator {
  const mode = env.MODUS_AUTH_MODE;
  if (mode === 'dev-token') {
    if (env.NODE_ENV === 'production') {
      throw new Error('MODUS_AUTH_MODE=dev-token is not allowed when NODE_ENV=production; configure OIDC');
    }
    return new DevTokenAuthenticator(env.MODUS_AUTH_SECRET);
  }
  if (mode === 'oidc') {
    throw new Error('MODUS_AUTH_MODE=oidc: provider integration is not implemented yet (ADR-0009)');
  }
  throw new Error('MODUS_AUTH_MODE must be set explicitly ("dev-token" for local development)');
}
