# ADR-0002 · PostgreSQL, Row Level Security and composite foreign keys

**Context.** Strict isolation between organizations and protection of private drafts must survive
service bugs.

**Decision.** PostgreSQL 16. The app connects through role `modus_app` (non-owner) and binds
`app.user_id`, `app.org_id`, `app.membership_id` with `SET LOCAL` in every transaction
(`platform/db/pool.ts → withTx`). RLS on every table: tenant rows require matching org **and** active
membership (checked by `SECURITY DEFINER` helpers); Lab rows require ownership. Restrictive policies
pin authorship to the caller. Composite FKs `(organization_id, id)` make cross-tenant links impossible.
Append-only triggers and column-level grants protect history. Forward-only, checksummed migrations.

**Deployment rule.** The API logs in as an unprivileged role (not superuser, owns nothing, member of
`modus_app`); migrations and provisioning use the separate schema-owner connection. The server refuses
to start otherwise. Every org policy also checks that the bound membership belongs to the bound user
(`app_actor_ok()`), and workflow invariants (initial states, conflict of interest, final resolutions,
Lab ownership) are enforced by the database — see `docs/audit/2026-11-09-security-review.md`.

**Consequences.** + Isolation is enforced twice (service + database) and tested at both levels.
+ Operators and the app have different powers. − Every query must run inside `withTx`; production
must grant `modus_app` to the login role and run migrations as the schema owner. − `INSERT … ON
CONFLICT (target)` evaluates SELECT policies; notifications use target-less `ON CONFLICT DO NOTHING`.
