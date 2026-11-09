# Independent adversarial review of Phase 2

Date: 2026-11-10 (Asia/Almaty). Reviewer: separate agent, no part in writing the code; attacked the
services and the database directly as `modus_app`. All findings were fixed before the PR was opened
(migration `0003_review_hardening.sql` + service changes). Each is replayed by
`test/platform/phase2-review.test.ts`; **all 14 tests fail on the pre-fix code and pass after**.

| # | Finding (severity) | Fix |
|---|---|---|
| 1 | One person as maintainer **and** decision owner could verify and merge alone (critical) | Maintainer ≠ decision owner (TS + DB). Verification is started/concluded only by the maintainer; the decision owner never owns, runs or concludes a verification they judge |
| 2 | Author could own the verification and record evidence (critical) | Owner ≠ author, ≠ decision owner; evidence never by the author (TS + RLS) |
| 3 | Contributions revocable/forgeable; running verification rewritable or cancellable by anyone (critical) | Contributions must be backed by a workflow record; system facts never revoked; forward-only transitions. Plan/criteria/owner/revision frozen once running; cancel only by the maintainer, with a reason, and never after evidence exists |
| 4 | Cancelling bypassed the verdict and lost the negative result (high) | Leaving `verification` requires no active run; `verification → decision` requires a completed run of the current text |
| 5 | Text swapped after a positive verdict; unassigned leads could move stages (high) | No author updates or suggestion acceptance after `development`; checks count only verifications of the current revision; only assigned leads move stages |
| 6 | A non-author could retire the current text (high) | Only the author supersedes; deferred constraint: exactly one current revision, the one the idea points to |
| 7 | Anyone could close a change request via SQL (high) | Only the requester or the assigned maintainer |
| 8 | DB-level race: uncommitted change request vs merge (high) | Gate triggers lock the idea row (`a00_lock_idea`) |
| 9 | Suspended maintainer bricked the idea; revision number squatting → 500 (medium) | Assignment guard runs only when assignments change; gap-free revision numbers |
| 10 | Guest saw whole directory and org counters; FK probing; spoofed notifications; invisible guest owner (medium) | Guest-scoped memberships/users/subscriptions; column grants on organizations; notifications only through `app_notify()` which requires a backing record by the actor and recipients who can see the idea |
| m | Snapshot counted `result` as positive (minor) | Snapshot counts `results`, `positiveObservations`, `negativeObservations` separately |

Suspected and adopted: assignments are frozen while a verification is active.

**Owner decision needed.** Spec §5 allowed one person to be maintainer and decision owner in a small
organization. This review showed that it lets one person verify and approve their own process. The
fix follows the latest owner priority ("независимые полномочия"); small teams use an invited guest
decision owner (ADR-0007). Please confirm.
