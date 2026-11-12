# ADR-0010 · Workflow invariants in the database

**Context.** Principle: no decision may destroy a person's contribution history or hide evidence of
mistakes. The prototype lost concurrent writes; Phase 1 enforced isolation and authorship but left
workflow rules to the service.

**Decision** (migration `0002_workflow_invariants.sql`, mirrored by `platform/domain/policy.ts`):
1. **Serialization.** Every workflow step locks the idea row first (`SELECT … FOR UPDATE`) inside one
   transaction, so steps on one idea are applied one at a time; history rows are only ever inserted.
2. **Stage transitions** follow one table in SQL and TS. The author may only hand a revised idea back
   to review; development needs an open change request; verification needs a running verification;
   adoption needs a merge decision; closing needs a reject/close decision (or completed impact stage).
3. **Authorship.** Only the author writes `author_update` revisions and switches the current text;
   others write `suggestion` revisions (status `proposed`) under their own name; only the author accepts
   or declines them; `superseded`/`declined` are final. Accepted suggestions credit their author
   (`co_authorship`).
4. **Right of reply.** `objection` reviews exist only as the author's reply to a change request; the
   author can never request changes or approve their own idea. Resolutions are final.
5. **Evidence.** A positive verdict needs results or positive observations; a negative one needs
   results or negative observations; evidence only while running; concluded verifications immutable;
   one active verification per purpose. Negative verdicts credit the verification owner
   (`negative_result`).
6. **Decisions.** One per idea, on the current revision, only at review/decision stage; merge blocked
   by open change requests or unfinished verification; each decision stores a **server-computed
   snapshot** of all verifications and their positive/negative evidence counts, so the record of what
   the decider knew cannot be edited or omitted.
7. **Invited reviewers.** `memberships.access = 'guest'`; restrictive RLS limits guests to assigned
   ideas and their records.
8. **Chronology.** History timestamps use `clock_timestamp()` (time of write under the lock), not
   `now()` (transaction start), so the timeline matches the real order of events.

**Hardening (migration 0003, after adversarial review):** maintainer ≠ decision owner; decision owner
never owns/starts/concludes a verification; author never owns a verification or records evidence;
contributions require a backing record and system facts cannot be revoked; running verifications are
frozen and cannot be cancelled once evidence exists; text frozen from verification on; exactly one
current revision per idea (deferred constraint); resolution only by requester/maintainer; gate
triggers lock the idea row; notifications only via `app_notify()`; guest scope on people, counters and
subscriptions.

**Consequences.** + Rules hold even for a buggy service (tested with direct SQL as `modus_app`).
− Rules exist twice (TS + SQL); both are covered by tests so drift fails CI. − Checks that depend on
"who acts" are skipped for operator transactions without a bound identity (owner provisioning).
