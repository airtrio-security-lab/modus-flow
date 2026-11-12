# Independent adversarial review of Phase 2.5 (feedback MVP)

Date: 2026-11-10 (Asia/Almaty). Scope: migration `0004_feedback_mvp.sql` and the Phase 2.5 services
(intake, routing, SLA/escalation, search, analytics, attachments, implementation). The reviewer was a
separate agent with no part in writing the code; it attacked the services and the database directly as
`modus_app`. Fixes: migration `0005_feedback_hardening.sql` plus service changes.

Regression tests: `test/platform/feedback-review.test.ts` (14 tests). Checked against the pre-fix code
(0005 removed): **13 of 14 fail**. The one that passes there guards a NULL-handling bug that 0005
itself introduced while fixing C1 (see "Found while fixing"), so it cannot fail on the old code.

The labels (C1…) are those used in the migration comments. The table is grouped by fix, not by the
reviewer's original order.

| Ref | Finding | Fix (0005 unless noted) | Test |
|---|---|---|---|
| C1 | Naming a rule's maintainer as "raised by" made routing skip that rule and pick another one — the author could steer who handles the item. A wrong attribution also blocked that person from ever being assigned | The rule is chosen as if no raiser were given (only the author is excluded). If the chosen rule names the raiser, the item falls back to the head of department or the unrouted queue — never to another rule. The named person can decline the attribution (`POST …/attribution/decline`): the `issue_found` credit is revoked with a reason, not deleted | C1 ×3 |
| C2/C3 | Escalation contact, head of department and a rule's escalation contact could be a suspended member or a guest, so escalations went nowhere | Triggers require an active full member when these are set or changed. `escalate_overdue()` records and notifies only active members and falls back to org admins. Unrouted items always also go to admins (they fix the rules) | C2/C3 ×2 |
| C4/C5 | Clients could write `updated_at`, back-date `published_at` (and so the deadlines), and anyone's comment reset the "stale" timer | `UPDATE(updated_at)` revoked; trigger sets it from `clock_timestamp()`. `published_at` and deadlines are set by the route trigger from the database clock. New `responsible_activity_at` is written only by `mark_activity()` (definer) for the maintainer / decision owner / implementer and running checks; `stale` is computed from it | C4/C5 ×2 |
| C7 | The person who raised the item could approve it or request changes on it | Restrictive RLS policy `reviews_not_judged_by_raiser` | C7 |
| C8/C9 | An organization lead who raised the item could assign it; leads could appoint the implementer before any decision; an implementer who was also the author or raiser could confirm completion alone | `ideas_guard_update` revised: the raiser cannot assign; implementer only after a merge decision; `adoption → impact_verification` only by a non-originator implementer or a lead who is not the author or raiser. Service policy mirrors this (`idea.complete_implementation`) | C8 ×2, C9 |
| C10 | Any member could attach files to any item; file names could carry bidi control characters (`отчёт‮txt.exe`) | Restrictive RLS policy `attachments_from_participants`; `attachments_no_bidi` check constraint (the service already rejected `\p{Cf}`) | C10 |
| — | `app_has_member_role()` answered for memberships of other organizations and was callable by PUBLIC | Scoped to the current organization; `EXECUTE` revoked from PUBLIC | role probe |
| — | A recorded fact let its author send that notification to anyone in the organization (spam / phishing inside the app) | `app_notify()` limits recipients to the item's participants; a new item is announced only to its assignees, or to leads and the escalation contact when unrouted | notifications |

Service-level changes that go with these: the idempotency scope of quick submission includes the
organization; `getIdea` counts only verifications of the current revision; no service writes
`updated_at` any more.

## Found while fixing (not in the review)

1. **0005 introduced a routing bug.** `raiser IS DISTINCT FROM rule.decision_owner` is false when both
   are NULL, so any rule without a separate decision owner was skipped for items without a raiser.
   Caught by the existing routing test; fixed with an explicit `raiser IS NULL` branch. The same
   pattern in `implementer_is_originator` was made NULL-safe.
2. **A rule could not be deactivated once its escalation contact was suspended** — the validation
   trigger fired on every update. It now fires only when the contact is set or changed. Caught by the
   C2/C3 regression test.
3. **Demo seed relied on the old rule** (the author completing their own item); the seed now has the
   head of department confirm completion.

## Behaviour changes visible to users

- A colleague recorded as "raised by" sees the item in "Мои обращения", gets credit for spotting it,
  and can decline that credit.
- Whoever raised or wrote an item reports progress on it but does not confirm it as done; the
  responsible head does.
- Escalations of unrouted items reach organization admins as well as the escalation contact.

## Remaining limitations

- GitHub Actions has not run on this branch: every run is refused before start with the account
  billing error. Results above are from local runs (PostgreSQL 16, Node 22): `npm run test:platform`
  149/149, `npm run test:legacy` 8/8, `tsc --noEmit` clean. Not claimed merge-ready until CI runs.
- Escalation runs as a job (`platform/cli/escalate.ts`); no scheduler is bundled.
- Attachments live in PostgreSQL (≤ 5 MB, ≤ 10 per item); no antivirus scanning.
