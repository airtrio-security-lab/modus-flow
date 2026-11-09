# Phase 2 — Review → Verification → Decision (vertical slice)

Status: implemented on `feat/phase2-workflow` (stacked on Phase 1, PR #8). Principle: **no decision may
destroy a person's contribution history or hide evidence of mistakes.** Rules: ADR-0007, ADR-0010.

## Scenario

```
Lab draft ──publish──▶ #N published
  assignments ─────────▶ review        (org maintainer/decision owner, not the author; guests allowed as assignees)
  request_changes ─────▶ development   (assigned maintainer / decision owner)
  objection ───────────  (author's reply to that change request; stays in history)
  revision ────────────▶ review        (author only; baseRevision guards against stale edits)
  resolve ─────────────  resolved | withdrawn (by requester or maintainer; final)
  verifications ───────▶ verification  (gate: automated checks; pinned to the current revision)
  evidence ────────────  baseline | result | positive_observation | negative_observation | reference
  conclusion ──────────▶ decision      (positive / negative / inconclusive; needs supporting evidence)
  decision ────────────▶ adoption | closed  (assigned decision owner, never the author; one per idea;
                                            server snapshot of all verifications incl. negative evidence)
```

## API (all `POST`, all accept `Idempotency-Key`, all return 201 with the new state)

Base: `/api/v1/orgs/:org/ideas/:number`

| Path | Body | Who |
|---|---|---|
| `/assignments` | `{maintainer?, decisionOwner?}` (membership ids) | member with maintainer/decision_owner role, not the author |
| `/reviews` | `{kind: comment\|approval\|request_changes\|objection, body, parentReviewId?}` | comment: any; approval: non-author; request_changes: review lead; objection: author → change request |
| `/reviews/:id/resolve` | `{outcome: resolved\|withdrawn, note}` | requester or maintainer, never the author |
| `/revisions` | `{baseRevision, title, problem, proposal, successCriteria?, rationale?}` | author |
| `/suggestions` | same + `rationale` (required) | anyone but the author |
| `/suggestions/:rev/decision` | `{accept, note?}` | author |
| `/verifications` | `{plan, successCriteria, owner}` | assigned maintainer / decision owner, not the author |
| `/verifications/:id/evidence` | `{kind, body, metric?, value?, unit?}` | verification owner, maintainer, decision owner |
| `/verifications/:id/conclusion` | `{outcome, conclusion}` | assigned maintainer / decision owner, not the author |
| `/decision` | `{outcome: merge\|reject\|close, rationale}` | assigned decision owner, not the author |

`GET /ideas/:number` returns everything the idea page needs: revisions (with origin, status, author),
reviews (incl. objections, resolutions), verifications with **all** evidence, decisions with their
`verification_summary`, contributions, and automated `checks`.

Errors: `403 forbidden` (policy), `404` (invisible: other org, guest scope), `409 conflict` (stale base,
wrong stage, already decided/concluded), `409 checks_failed` with `details.failing[]`, `409
idempotency_mismatch`, `422 validation_failed`.

## Tests

Totals on PostgreSQL 16 / Node 22: **platform 91** (Phase 1: 54 incl. updated fixtures, Phase 2: 36,
auth selection: 1), **legacy prototype 8**. Phase 2 tests:

#### test/platform/workflow.test.ts
- scenario: review → change request → objection → revision → verification (+/- evidence) → merge
- scenario: negative verification → reject; the negative result is credited and kept
- scenario: the author objects, the maintainer withdraws the request, the idea returns to review
- only the review lead requests changes; the author cannot resolve them
- objections: only the author, only to a change request
- nobody but the author edits the text; others suggest with their own authorship
- stale suggestions and stale revisions are rejected, not merged silently
- assignment: only org leads who are not the author; assignees must hold the role
- decisions: only the assigned decision owner; never by the author; never twice
- merge is gated: no open change requests, no unfinished verification
- verification start is gated by automated checks
- conclusions need supporting evidence and are final; evidence only while running
- idempotent workflow steps: a retried request creates one record
- guest decision owner: sees only assigned ideas, can decide them, has no other powers
- guests cannot publish into the organization
- a guest membership cannot carry employee or admin roles

#### test/platform/concurrency.test.ts
- regression (prototype lost update): 20 parallel comments → 20 stored
- 5 parallel revisions on the same base → exactly one wins, the rest get 409
- parallel decisions → exactly one decision is recorded
- change request racing a merge: never merged over an open change request
- evidence racing the conclusion: nothing is attached after the verdict
- parallel conclusions → one verdict, never overwritten
- the same idempotency key in parallel → one effect, identical responses

#### test/platform/workflow-db.test.ts
- stage: no skipping, no unauthorized movers, the author only hands back to review
- stage: adoption needs a merge decision; closing needs a reject/close decision
- assignment cannot be changed by the author or by plain members
- revisions: only the author writes author updates; suggestions never by the author
- revisions: accepting a suggestion is the author\
- reviews: authors cannot request changes on their own idea; objections only by the author
- verification: no verdict without evidence, no evidence after the verdict — even for the owner
- decisions: snapshot is server-computed; one per idea; merge never over open change requests
- guest scope holds at the database level
- history timestamps follow write order under contention

#### test/platform/workflow-http.test.ts
- vertical slice over HTTP: idea → review → change request → objection → revision → verification (+/-) → decision
- HTTP: checks_failed carries the failing checks for the UI
- HTTP: another organization cannot act on the idea

## Remaining limitations

* **CI not yet confirmed on GitHub** (billing). All results above are local runs.
* **Authentication** is still the development token mode; OIDC is designed (ADR-0009) but not
  implemented. Not deployable to real users yet.
* **Adoption → impact verification** (stage `impact_verification`, purpose `impact`) is supported by
  the schema and invariants but has no endpoints yet; neither does contribution **confirmation**.
* **Return to review from decision** (e.g. after an inconclusive verdict, without a new change request)
  has no dedicated endpoint; today the route is a change request → revision.
* Checks that depend on the actor are skipped for operator transactions without a bound identity;
  identity variables remain trusted session settings (see security review residual risks).
* Guests can see the organization's member directory names (needed to render authorship).
* No pagination on idea detail lists; acceptable for pilot volumes.

## Connecting the UI (Phase 3 plan)

```
PWA (React + TS)
 ├─ api/client.ts       fetch wrapper: bearer from Authenticator (OIDC later), Idempotency-Key per user action
 │                      (uuid generated when the button is pressed, reused on retry), maps error codes
 ├─ api/types.ts        generated from zod schemas in platform/modules/*.ts (single source of truth)
 ├─ screens/
 │   ├─ Lab (mobile chat-first)  ⇄ /lab/drafts, /versions (baseVersion), /publish
 │   ├─ Ideas list               ⇄ GET /ideas?stage=
 │   └─ Idea page (PR-like)      ⇄ GET /ideas/:n
 │        tabs: Conversation (reviews + objections) · Versions (revisions, suggestions, diff)
 │              Checks (automated) · Verification (runs + evidence, positive and negative side by side)
 │              Decision (rationale + frozen verification snapshot) · History (audit)
 │        actions shown from GET data + the same policy rules (server stays authoritative)
 └─ inbox                ⇄ /notifications, /notifications/read
```

UI rules: never hide negative evidence or declined suggestions; show "merge ≠ proven impact";
on 409 `conflict` with `currentRevision`, reload and show the newer text; on `checks_failed`, render
`details.failing` as a checklist.
