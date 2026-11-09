# Phase 0 — Repository audit

Date: 2026-11-09 · Scope: `main` @ `1628c9a`, open PRs #3–#7 (stacked), GitHub Actions history.
Method: read all code and docs on every branch, ran every branch's tests locally (Node 22.23),
inspected CI job annotations, reproduced suspected defects against a running server.

## Summary

The repository holds a small, carefully documented **demo**: an in-memory feedback workflow on `main`,
and a five-PR stack adding contribution tracking, a private idea lab, guided reflection, file-based
persistence and maintainer review. Product thinking is ahead of the code, and the docs are honest
about it. The prototype is a good source of UX and domain ideas, but not a base to scale: there is no
tenancy, no real identity, no relational storage, and one confirmed data-loss defect.

## Verified facts

| Item | Result |
|---|---|
| CI | **Never executed.** Every run (main and all PRs) failed in 2–4 s with: *"The job was not started because recent account payments have failed or your spending limit needs to be increased."* The red ✗ on PRs is a billing problem, not test failures. |
| Tests, run locally | `main` 8/8 · #3 12/12 · #4 15/15 · #5 17/17 · #6 19/19 · #7 22/22 — all pass |
| Runtime deps | none (Node built-ins only) |
| UI rendering | `textContent` only; no `innerHTML` with user data found |
| PR topology | #3→main, #4→#3, #5→#4, #6→#5, #7→#6. #3 branches from `15899c6`, i.e. **before** the docs merge #2 |

## Findings

### P0 — must be resolved before anything is built on top

1. **CI is not running at all** (billing). No PR has machine verification. *Owner action:* fix
   GitHub billing / spending limit, or use a self-hosted runner. Until then every "green/red" claim
   must come from local runs.
2. **Lost updates in the durable state (PR #6, #7).** Handlers read `store.state` outside the
   transaction, compute the next object, then `transact()` writes that precomputed object back.
   Concurrent requests overwrite each other. *Reproduced:* 10 parallel comments on one request →
   **1 stored**. This silently destroys review history, status changes, adoptions and usage events —
   the opposite of "immutable history".
3. **Merging the stack reverts approved documentation.** Because #3 predates #2, its diff replaces
   `docs/CONTRIBUTION_ENGINE.md` Concept v1.0 (98 lines, approved) with a 10-line v0.2. A blind merge
   erases the approved concept.
4. **No tenant model.** One global space; every manager sees and acts on every request. The
   multi-tenant / strict isolation requirement is unmet by design, not by a bug.
5. **No real authentication.** Static demo bearer tokens (`demo-employee`, `demo-manager`) live in the
   client JS. Correctly gated behind `DEMO_MODE=true` and documented — acceptable for a demo,
   blocking for any real pilot.

### P1 — design gaps that the foundation must close

6. **Roles are global and coarse.** No per-idea maintainer or decision owner; no conflict-of-interest
   rule (a manager can resolve their own idea); the author cannot formally object to a change
   request — only comment.
7. **One status enum mixes processes.** `submitted/in_review/in_progress/resolved` conflates review,
   development, decision and outcome; `resolved` cannot distinguish "decided to adopt" from "proved
   useful". Pilot results are free-text review comments without plan, criteria or evidence.
8. **History is mutable.** Histories are arrays inside JSON records; there is no append-only audit;
   corrections overwrite.
9. **Inconsistent visibility.** `GET /api/contributions` returns every request title to every employee,
   while `GET /api/requests` limits employees to their own. `POST /api/contributions` answers 404 / 403
   / 409 differently, revealing whether a request id exists.
10. **Private drafts stored in plaintext JSON**, single process, no backups or encryption
    (documented as demo-only).
11. **Idempotency only for draft publication.** Request creation, reviews, adoptions are not
    retry-safe.
12. CI workflow still triggers on the stale `feat/mvp-foundation` branch.

### P2 — quality

13. Request bodies are decoded by `text += chunk` — a multi-byte UTF-8 character split across two
    chunks is corrupted (affects Cyrillic text).
14. Every non-403 error becomes 422, including "not found" thrown inside a transaction; internal
    error messages are returned to clients.
15. No request ids, structured logs or rate limiting.
16. Modules are written as single minified lines — hard to review; no HTTP-level tests.
17. `ubuntu-latest` image migration notice (Ubuntu 26 from 2026-10-19).

## What works vs. what is concept

**Works (demo-grade, tested):** feedback submission and role-based transitions; private drafts with
per-step revisions and a publication snapshot that excludes private steps (#4/#5); blocking change
requests that prevent resolution (#7); atomic single-writer file persistence (#6); strict security
headers.

**Concept only:** multi-tenancy, employee profiles, honor board, notifications, verification engine,
decision-owner policy, AI dialogue, Notion/messenger integrations.

## Recommendations

* Do **not** merge PRs #3–#7 as they are (P0-2, P0-3). Keep them open as the UX reference until the
  Phase 3 UI replaces them, then close as superseded. If a demo is needed from that stack before then,
  fix P0-2 (move the read-modify-write into `transact`) and rebase #3 onto `main` first.
* Build the platform **alongside** the prototype (no rewrite, no deletion): PostgreSQL, tenant
  isolation in the database, explicit lifecycle, append-only history — see
  `docs/architecture/PLATFORM.md` and `docs/adr/`.
* The guided-reflection step model (observation, cause, evidence, proposal, risks, pilot) is kept
  verbatim in the platform's Lab content schema so the prototype UX can move over unchanged.
