# MODUS FLOW Platform — target architecture

Status: **Phase 1 foundation implemented** (this document describes what exists and what is planned;
planned parts are marked). Decisions are recorded in [`docs/adr/`](../adr/).

## Spaces

```
┌──────────────── PERSONAL LAB (user-owned) ────────────────┐
│ lab_drafts ─< lab_draft_versions (append-only)            │   visible to owner only (RLS)
│ six guided steps; private notes; future AI dialogue       │
└──────────────┬────────────────────────────────────────────┘
               │ explicit publish (one transaction, idempotent)
               │ snapshot of exactly: title, observation→problem,
               │ proposal→proposal, pilot→success criteria
┌──────────────▼──────────── ORGANIZATION (tenant) ─────────┐
│ ideas #N ─< idea_revisions (content frozen)               │   visible to active members
│        ─< reviews (body frozen; change requests, objections)│   of that organization only
│        ─< verifications ─< verification_evidence (append) │   (RLS + composite FKs)
│        ─< decisions (append-only; merge ≠ proven impact)  │
│        ─< contributions (evidence-linked, no points)      │
│ notifications (targeted, deduplicated, no free text)      │
│ audit_events (append-only)                                │
└───────────────────────────────────────────────────────────┘
  COMMUNITY (planned): voluntary cross-organization publication — separate explicit act,
  never automatic, never including Lab content.
```

## Runtime

```
browser / PWA (Phase 3) ──HTTP JSON──▶ platform/http/app.ts ──▶ platform/modules/* ──▶ PostgreSQL
                                        │ auth (HMAC token → user id)      │ withTx(): BEGIN
                                        │ zod validation                   │  set_config(app.user_id/org_id/membership_id)
                                        │ error mapping, request ids       │  SET LOCAL ROLE modus_app  ← RLS applies
                                        └ no permission logic here         └ COMMIT / ROLLBACK
```

The legacy prototype (`src/`, `public/`, port 3000) is untouched and keeps working. The platform API
runs separately (`npm run platform:start`, port 3100).

## Module boundaries

| Layer | Path | Responsibility | Depends on |
|---|---|---|---|
| Domain | `platform/domain/` | Vocabulary, lifecycle, authorization policy, automated checks, Lab projection. Pure, no I/O. | zod |
| Data | `platform/db/` | Pool, transactions with identity binding, migrations, PG error mapping. | pg |
| Modules | `platform/modules/` | Use cases: `lab`, `ideas`, `context`, `notifications`, `idempotency`, `audit`, `provisioning`. | domain, db |
| HTTP | `platform/http/` | Routing, authentication, validation, response shaping. | modules |
| CLI | `platform/cli/` | Migrate, seed fictional demo org, issue tokens. Operator-only. | modules |

Rules: domain never imports db/http; HTTP never queries SQL; provisioning (privileged) is reachable
only from CLI and tests.

## Data model (Phase 1)

| Model | Table | Key constraints |
|---|---|---|
| Organization | `organizations` | unique slug; per-org idea counter |
| Membership / Employee | `memberships`, view `employees` | unique (org, user); roles ⊆ {employee, maintainer, decision_owner, org_admin}; Employee is a projection, not a copy |
| Personal draft | `lab_drafts`, `lab_draft_versions` | owner-only; versions immutable; published ⇔ linked idea |
| Idea | `ideas` | unique (org, number); stage enum; no delete; author not updatable |
| Revision | `idea_revisions` | content frozen by trigger + column grants; one `current`; origin publication/author_update/suggestion; suggestions require rationale |
| Review | `reviews` | body frozen; objection must reply to a review; only change requests carry open/resolved state |
| Verification | `verifications`, `verification_evidence` | purpose hypothesis/impact; completed ⇒ outcome + conclusion + reviewer; concluded runs immutable; evidence append-only |
| Decision | `decisions` | append-only; rationale ≥ 10 chars; outcome merge/reject/close |
| Contribution | `contributions` | linked to a source record; no self-confirmation; revocation needs reason; idempotent per (member, kind, source) |
| Notification | `notifications`, `notification_subscriptions` | (recipient, dedupe key) unique; actor ≠ recipient; subscriptions honoured |
| Audit | `audit_events` | append-only for every role |
| Idempotency | `idempotency_keys` | per (user, scope, key); stored in the operation's transaction |

Every organization-scoped foreign key is composite `(organization_id, id)`: a row from tenant A can
never reference a row of tenant B, even through a buggy service or an operator script.

## Security model

* **Tenant isolation in the database.** RLS on every table; policies require
  `organization_id = app.org_id` **and** active membership of the caller. Forging `app.org_id`
  without membership returns nothing (tested).
* **Unprivileged API login.** The API connects as a non-owner, non-superuser member of `modus_app`
  (startup check), so `RESET ROLE` cannot escape RLS. Migrations use a separate owner connection.
* **Bound actor.** Policies require the bound membership to belong to the bound user (`app_actor_ok()`).
* **Workflow invariants in the database.** Rows are born in initial states; decisions only by the
  assigned, non-author decision owner; no self-assignment, self-verification or self-confirmation;
  resolved change requests and published drafts are final.
* **Authorship cannot be forged.** Restrictive policies force `author/decided_by/recorded_by/
  created_by = app.membership_id` on insert.
* **Least privilege.** The application role has column-level `UPDATE` only on workflow state columns;
  revision text, review bodies, decisions, evidence and audit are not updatable by it at all.
* **Private Lab.** Owner-only RLS; organization audit and notifications carry no draft content or id.
* **Uniform 404s.** Foreign organization = missing organization; foreign draft = missing draft.
* **Auth.** Interim HMAC tokens with expiry; no default secret; roles never in the token.
* **Inputs.** zod with `.strict()` (no smuggled fields such as `authorId`), 256 KB body limit,
  `application/json` only, UTF-8 decoded once.

## Idea lifecycle

`Private draft (Lab)` → `published` → `review` ⇄ `development` → `verification` → `decision` →
`adoption` → `impact_verification` → `closed`; reject/close from any open stage. Stage is only the
position; review threads, verification runs, decisions and impact results keep their own state
(ADR-0006). Implemented in `platform/domain/lifecycle.ts`; workflow endpoints arrive in Phase 2.

## Idea Verification Engine

1. **Automated checks** (`platform/domain/checks.ts`, exposed on `GET …/ideas/:n` as `checks`):
   completeness, success criteria, maintainer independent of author, decision owner independent of
   author, no open blocking change requests, revision consistency, field-verification presence
   (warning — absence is never a pass). Gates: `start_verification`, `decide`.
2. **Human / field verification** (`verifications` + `verification_evidence`): plan, owner, success
   criteria, baseline/result, positive and negative observations, references, reviewer conclusion with
   outcome positive / negative / inconclusive. Schema in place; workflow in Phase 2.

AI may later summarize evidence; it never writes outcomes, decisions or contributions.

## API v1 (implemented)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/health` | public |
| GET | `/api/v1/me` | user + memberships |
| GET/POST | `/api/v1/lab/drafts` | own drafts |
| GET/DELETE | `/api/v1/lab/drafts/:id` | own draft with version list |
| POST | `/api/v1/lab/drafts/:id/versions` | `{baseVersion,title,content}`; stale base → 409 |
| POST | `/api/v1/lab/drafts/:id/publish` | `{organization}`; `Idempotency-Key` supported |
| GET | `/api/v1/orgs/:org/ideas[?stage=]` | list |
| GET | `/api/v1/orgs/:org/ideas/:number` | revisions, reviews, verifications, decisions, checks |
| GET | `/api/v1/orgs/:org/notifications` | own inbox, rendered messages |
| POST | `/api/v1/orgs/:org/notifications/read` | `{ids}`; own inbox only |

## API v1 — workflow (Phase 2)

See [`PHASE2-WORKFLOW.md`](PHASE2-WORKFLOW.md) for the review, revision, suggestion, verification,
evidence and decision endpoints and the UI integration plan.

## API v1 — feedback MVP (Phase 2.5)

Hackathon brief «обратная связь и предложения сотрудников» + the owner's requirements: nothing gets
lost, everyone sees the stage, the owner sees what needs attention. Migrations 0004 + 0005.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/orgs/:org/ideas` | quick submission: `{kind: idea\|problem, title, problem, proposal?, categoryId?, departmentId?, sourceChannel, sourceNote?, raisedBy?}`; routed by the database (rule → head of department → unrouted queue); `Idempotency-Key` |
| GET | `/api/v1/orgs/:org/ideas?q=&status=&kind=&category=&department=&channel=&mine=&assigned=&overdue=&stale=&open=` | search over `idea_overview` (Russian full text + substring) |
| GET | `/api/v1/orgs/:org/ideas/similar?q=` | up to 5 similar items before creating a duplicate |
| POST | `…/ideas/:number/implementer` | after a merge decision, by the leads |
| POST | `…/ideas/:number/implementation` | `{report}`; implementer (not an originator) or a lead → `implemented` |
| POST | `…/ideas/:number/attribution/decline` | the person recorded as "raised by" declines the credit |
| POST/GET | `…/ideas/:number/attachments[/:id]` | raw body, `Content-Type`, `X-File-Name` (URL-encoded); ≤ 5 MB, ≤ 10 per item; signature must match type |
| GET | `/api/v1/orgs/:org/directory` | departments, categories, active members, settings (full members only) |
| GET/POST | `/api/v1/orgs/:org/routing-rules`, `POST …/:id/active` | org_admin writes; rules are deactivated, never deleted |
| POST/PATCH | `/api/v1/orgs/:org/departments[/:id]`, `/categories[/:id]` | org_admin |
| PATCH | `/api/v1/orgs/:org/settings` | first-response hours, resolution days, stale days, escalation contact |
| GET | `/api/v1/orgs/:org/analytics?from=&to=` | leads and admins; counts and shares from recorded facts only |
| GET | `/api/v1/orgs/:org/kingdom` | full members; castles per active department (`towers` = implemented, `building`, `envoys`, `waiting`, `returned`), open items as envoys with a `mine` flag, `wildlands` = open items without a department. Computed under RLS (ADR-0011) |

Escalation of overdue / stale items: `node platform/cli/escalate.ts` (schema owner, run by a
scheduler; none is bundled). Audit: [`../audit/2026-11-10-feedback-review.md`](../audit/2026-11-10-feedback-review.md).

### Local demo (hackathon only)

`platform/cli/seed-modus-demo.ts` creates the fictional organization «Модус Трейд — демо» (invented
people, 15 items in every status) and writes `.demo/personas.json`. With
`MODUS_AUTH_MODE=dev-token MODUS_DEMO_LOGIN=true` the API offers `GET /api/v1/demo/personas` and
`POST /api/v1/demo/login {userId}` — an **imitation of SSO** for the demo; refused at startup in
production or with OIDC. `MODUS_SERVE_WEB=true` (or `MODUS_WEB_DIR`) serves the built web app from the
same origin with a strict CSP.

## Planned (next phases)

* **Phase 2 (done):** see `PHASE2-WORKFLOW.md`. Still open: impact verification and contribution
  confirmation endpoints.
* **Phase 3:** React + TypeScript PWA (Quiet Intelligence tokens, mobile chat-first capture, desktop
  workspace, PR-like idea page) over API v1.
* Employee Contribution Profile and Honor Board as read models over confirmed contributions
  (categories, links to evidence, no counts-based ranking).
* SSO/OIDC, rate limiting, outbox delivery to e-mail/messengers, backups/restore rehearsal.
