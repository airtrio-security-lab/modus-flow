# ADR-0009 · Authentication boundary; OIDC planned, dev tokens never production

**Context.** Owner decision (2026-11-09): SSO via an OIDC abstraction; provider chosen after reviewing
Modus Trade infrastructure; interim tokens are not a production solution.

**Decision.** The HTTP layer depends only on `Authenticator.authenticate(bearer) → { userId } | null`
(`platform/http/authn.ts`). Mode is selected explicitly with `MODUS_AUTH_MODE`:
* `dev-token` — HMAC tokens from the operator CLI (ADR-0004); `productionReady = false`; refused when
  `NODE_ENV=production`; the server logs a warning on start.
* `oidc` — planned: discovery of the issuer, JWKS signature check, `iss`/`aud`/`exp`/`nbf` validation,
  `sub` → `users.external_subject`, just-in-time user creation only through an explicit provisioning
  rule. Selecting it today fails at startup instead of silently degrading.
No mode is implied; an unset mode refuses to start. Roles never come from the token.

**Consequences.** Swapping the provider touches one module. ADR-0004 is now "development only".
