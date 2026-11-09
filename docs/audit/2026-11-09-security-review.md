# Independent security review of the Phase 1 foundation

Date: 2026-11-09. Reviewer: a separate agent with no part in writing the code, attacking a scratch
database directly as `modus_app` and the HTTP API. All confirmed findings were fixed before the PR was
opened; each reproduction is now a regression test in `test/platform/security-review.test.ts`
(verified: 8 of those tests fail against the pre-fix schema and pass after).

| # | Finding (severity) | Fix | Test |
|---|---|---|---|
| 1 | `RESET ROLE` returns to the login role; if that is a superuser/owner, RLS is gone (high) | API must log in as an unprivileged role that is a member of `modus_app`; server refuses to start otherwise (`assertUnprivilegedConnection`). Separate `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (`modus_api`); compose creates both | `#1 startup guard…`, `#1 … cannot escape RLS with RESET ROLE` |
| 2 | `app.membership_id` not bound to `app.user_id` → borrow someone's membership (high) | `app_actor_ok()` requires membership ↔ user ↔ org ↔ active; used by every org policy | `#2` |
| 3 | Rows insertable already confirmed / completed / resolved (high) | Restrictive INSERT policies: initial states only | `#3` |
| 4 | Conflict of interest only in app code (high) | DB: decisions only by the assigned decision owner who is not the author; author cannot start/conclude verification, resolve change requests or be assigned; confirmer must be maintainer/decision owner; assignees must hold the role | `#4` ×2 |
| 5 | Resolved review could be rewritten (medium) | Resolution is final (trigger) | `#5` |
| 6 | Draft ownership: version squatting, id probing, un-publishing, relinking (medium) | Version insert requires same owner + private draft (uniform error); published draft final; publish may link only to an idea the owner authored; column-level grants; no direct version deletes | `#6` ×2 |
| 7 | FK constraint name in API error; tokens for deleted users accepted (low) | No constraint names in responses; token user must exist on every request | `http.test.ts` |
| S | Temp tables could shadow tables in functions (suspected) | `REVOKE TEMPORARY … FROM PUBLIC`; definer/trigger functions use `search_path = pg_catalog, public, pg_temp` and qualified names | `temporary tables…` |
| S | Suspended member could mark notifications read (low) | Covered by `app_actor_ok()` | — |

## Residual risks (accepted for Phase 1, tracked)

* **Identity settings are trusted session variables.** RLS defends against *service bugs* (missing
  WHERE, wrong id passed), not against arbitrary SQL executed by the API login. Mitigations: all SQL is
  static and parameterized; no input reaches SQL text. A stronger design (DB-verified signed request
  context) is a candidate for the SSO work.
* **Stage changes and assignment** are permitted to any active member at the DB level; who may move
  an idea is enforced by the service policy (Phase 2 adds those endpoints with tests).
* No rate limiting; tokens cannot be revoked before expiry (ADR-0004).
* Names of suspended members remain visible in history (intentional: authorship is permanent).
