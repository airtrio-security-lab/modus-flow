# ADR-0004 · Interim authentication

**Decision.** Until SSO/OIDC is chosen, the API accepts `v1.<payload>.<hmac-sha256>` tokens signed
with `MODUS_AUTH_SECRET` (≥ 32 chars, no default; the server refuses to start without it). Tokens carry
only user id and expiry; roles and memberships are read from the database on every request. Tokens are
issued by an operator CLI. The prototype's public demo tokens are not accepted.

**Consequences.** + No secrets in code, no client-chosen roles. − No revocation list or refresh flow;
acceptable for a closed pilot only. `users.external_subject` is reserved for the OIDC `sub`.
**Open:** identity provider for Modus Trade (owner decision).
