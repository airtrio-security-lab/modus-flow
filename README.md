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

**Status:** Phase 1 (foundation) and Phase 2 (review → change request → objection → revision →
verification with positive/negative evidence → decision, see
[`docs/architecture/PHASE2-WORKFLOW.md`](docs/architecture/PHASE2-WORKFLOW.md)). The UI is Phase 3.
Not production-ready: authentication is development-only until OIDC lands (ADR-0009).

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

### Feedback MVP demo (fictional «Модус Трейд — демо»)
One process serves the API and the web app on http://127.0.0.1:3100. Sign-in is a demo imitation of
SSO; all people and items are invented. Details: [`docs/architecture/PHASE3-UI.md`](docs/architecture/PHASE3-UI.md).
```bash
npm ci
docker compose up -d postgres
export MIGRATION_DATABASE_URL=postgres://modus:modus-local-only@127.0.0.1:5432/modus
npm run demo:seed        # fresh database only: 16 items in every status, castles, a Council session; writes .demo/personas.json
npm run web:build        # builds web/dist
npm run demo:start       # API as modus_api + web app + demo sign-in; refuses NODE_ENV=production
npm run demo:e2e         # optional: Playwright walks through the main scenario
npm run demo:kingdom     # optional, on a fresh seed: the 90-second kingdom scenario (Council → XP → level → rating)
npm run demo:advisor     # optional, on a fresh seed: protocol → confirmed items → executor suggestion (rules, no AI; ADR-0013)
npm run demo:meeting     # optional, on a fresh seed: council meeting with consent, recording, prepared transcript, findings, confirmation (ADR-0014)
npm run demo:messages    # optional, on a fresh seed: the King calls the council → personal messages → decision → XP (ADR-0016)
npm run demo:legacy      # optional, on a fresh seed: meeting → Летопись → Библиотека → re-application → Высший Архив (ADR-0017)
npm run demo:final       # the final story: idea → envoy → council → decision → implementation → XP → castle → Летопись → Библиотека → Высший Архив
RECORD=1 npm run demo:final   # the same at presentation pace, recorded as the fallback video .demo/final-demo.mp4
npm run demo:councils    # optional, on a fresh seed: Japanese IT titles → small council in the Зал даймё → Great Round Table → decision → XP (ADR-0020)
npm run platform:import-dataset -- --demo-confirm A-004,A-008   # the organizer's official synthetic set A-001—A-020, idempotent (ADR-0026)
npm run demo:world3d     # optional, on a fresh seed WITH the set: the 3D city, camera, picking, citadel, search, fallback, phone (ADR-0026)
npm run demo:city        # optional, on a fresh seed: «Живое Королевство» — city camera, district screen, staff cards and privacy, style picker, workspace, phone (ADR-0019)
npm run demo:record      # optional, on a fresh seed: records the kingdom scenario as a fallback video (.demo/kingdom-demo.mp4)
```
The final 3-minute story inside a 5-minute talk: [`docs/demo/final-3min.md`](docs/demo/final-3min.md); readiness for the pilot: [`docs/audit/2026-11-11-final-readiness.md`](docs/audit/2026-11-11-final-readiness.md).
The city and the district screen: [`docs/demo/city-demo.md`](docs/demo/city-demo.md) (a 90–120 s version and the extended one); civilizations and councils: [`docs/demo/councils-demo.md`](docs/demo/councils-demo.md) (12 steps and a 90 s version). The 3D city and the organizer's set: [`docs/demo/world3d-demo.md`](docs/demo/world3d-demo.md); art direction: [`docs/3d/art-direction.md`](docs/3d/art-direction.md); decision and limitations: [`docs/adr/0026-world3d.md`](docs/adr/0026-world3d.md).
The 90-second click paths for a live demo: [`docs/demo/meeting-90s.md`](docs/demo/meeting-90s.md) (meeting → work → XP) and [`docs/demo/kingdom-90s.md`](docs/demo/kingdom-90s.md) (idea → council → XP).
Or all of it in one command (Docker + Node ≥ 22.18): `./scripts/demo-local.sh`. With the organizer's set for the 3D demo: `./scripts/demo-local.sh --fresh --dataset`.

A language model is optional and off by default. Local (Ollama): `MODUS_ADVISOR_PROVIDER=ollama MODUS_ADVISOR_MODEL=…`. Cloud (paid, the text leaves the company — the owner's decision, ADR-0028): `ANTHROPIC_API_KEY=… MODUS_ADVISOR_PROVIDER=anthropic MODUS_ADVISOR_MODEL=claude-haiku-5-5 MODUS_ADVISOR_ALLOW_REMOTE=true`; outside the demo sign-in it also needs `MODUS_ADVISOR_ALLOW_REAL_DATA=true`. Never commit a key. The shortest way on a laptop: `./scripts/demo-local.sh --dataset --ai` asks for the Anthropic key in the terminal.

### Platform tests
Integration tests use a real PostgreSQL; each test file creates and drops its own database.
They fail (never skip) when `TEST_DATABASE_URL` is missing.
```bash
export TEST_DATABASE_URL=postgres://modus:modus-local-only@127.0.0.1:5432/postgres
npm run check          # syntax + TypeScript
npm test               # legacy prototype tests + platform tests
```

## Local release gate (GitHub CI does not run while the account has a billing problem)

```bash
npm run hooks:install     # once: pre-commit (typecheck + unit + staged tests), pre-push (full gate)
npm run verify            # full gate: typecheck, prototype tests, PostgreSQL tests, web build — stops at the first failure
npm run gate:selftest     # proves in a throw-away clone that a commit with a failing test is refused
```

All of these checks are **local**; a green local run is not a green CI run.

## Scheduled jobs (schema-owner connection)

```bash
npm run platform:escalate    # every 15 min: overdue items and «Приближается срок» (once per deadline)
npm run platform:retention   # daily: purge meeting audio after 30 days and transcripts after 90 (org settings), re-apply purges after a backup restore
```
