# MODUS FLOW

Internal employee feedback and improvement workflow for the Pavlodar Hub × Modus Trade hackathon.

**Stage:** functional, isolated **demo**, not production-ready. Target production review: 14 November 2026.

## Demo (Node.js >=22)
```bash
DEMO_MODE=true npm start
# Open http://localhost:3000
npm test
```

Switch between demo employee and manager in the UI. Create an idea/problem, send for review, change its status, and reopen as the author. Demo access is deliberately limited to `DEMO_MODE=true`; demo bearer tokens are publicly visible in the browser source. **Never expose this process to the public internet or use real employee data.**

## MVP
- Employee submission with validation and assigned author identity
- Role-based state transitions, basic author-only visibility
- Status history and responsive Russian UI
- Built-in Node test suite; no third-party application dependencies

## Architecture
`public/` → browser UI; `src/server.js` → HTTP JSON API; `src/domain.js` → state machine; `test/` → domain regression tests.

## Production blockers
- Persistent PostgreSQL database, migrations and backups
- SSO/real authentication, secure sessions, CSRF mitigation where applicable
- Department/assignee routing, manager authorization scope, confidentiality model
- Durable audit trail, event notifications, monitoring and rate limiting
- Integration/e2e and threat-model tests, TLS and security review
- Separate build/deploy with secret management and controlled demo-data migration

See `docs/SPEC.md` and `docs/DELIVERY.md`.

---

## Platform (v1, in progress)

The scalable MODUS FLOW platform is built **alongside** the prototype in `platform/` (ADR-0001):
PostgreSQL with tenant isolation enforced by Row Level Security, a private Personal Lab, an explicit
idea lifecycle, append-only history and an idempotent, transactional publication flow.

* Audit of the current repository: [`docs/audit/2026-11-09-phase0-audit.md`](docs/audit/2026-11-09-phase0-audit.md)
* Independent security review and fixes: [`docs/audit/2026-11-09-security-review.md`](docs/audit/2026-11-09-security-review.md)
* Architecture: [`docs/architecture/PLATFORM.md`](docs/architecture/PLATFORM.md) · Decisions: [`docs/adr/`](docs/adr/)

**Status:** Phase 1 (foundation) — schema for all core models, access policy, Lab + publication,
idea read API, notifications inbox, automated checks. Review/verification/decision workflows are
Phase 2; the UI is Phase 3. Not production-ready (see ADR-0004 for authentication).

### Run locally (Node ≥ 22.18, PostgreSQL 16)
```bash
npm ci
docker compose up -d postgres            # or any PostgreSQL 16
cp .env.example .env && $EDITOR .env     # set MODUS_AUTH_SECRET (≥ 32 chars)
# The API must use an unprivileged login (modus_api, created by docker compose);
# migrations/seed use MIGRATION_DATABASE_URL. The server refuses to start as a superuser/owner.
set -a && . ./.env && set +a
npm run platform:seed-demo               # migrates, creates a FICTIONAL org, prints tokens
npm run platform:start                   # http://127.0.0.1:3100/api/v1/health
```

### Platform tests
Integration tests use a real PostgreSQL; each test file creates and drops its own database.
They fail (never skip) when `TEST_DATABASE_URL` is missing.
```bash
export TEST_DATABASE_URL=postgres://modus:modus-local-only@127.0.0.1:5432/postgres
npm run check          # syntax + TypeScript
npm test               # legacy prototype tests + platform tests
```
