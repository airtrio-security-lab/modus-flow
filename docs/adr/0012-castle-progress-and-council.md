# ADR-0012 · Castle progress and the round-table Council

**Context.** Owner brief 2026-11-11: the kingdom must look like a quality game and work like the
corporate system it sits on — castle levels with XP, achievements and a department rating, and an
interactive «Совет королевства» at a round table. Constraints from the brief: no reward for the number
of submissions; never award twice; no game-only source of truth for business statuses; do not mix the
department rating with personal evaluation; recommendations of the Council are not the decision when
the rules name a responsible person; everything is logged.

**Decision.**

* **XP is a ledger written only by database triggers** (`xp_awards`, migration 0007):
  `implementation` when an item reaches `impact_verification` (completion confirmed by the implementer
  or a lead), and `effect` when the decision owner — not an originator — approves the documented effect
  (`effect_approvals`, 0..`xp_effect_max`, rationale required, once per item). `(idea_id, kind)` is unique;
  the ledger is append-only; the application role cannot insert or change it. Items implemented before
  the migration are backfilled once at their confirmation time.
* **Levels are configuration**: `level_thresholds` (starting 0 / 100 / 250 / 500 / 900, validated:
  five values, first 0, strictly increasing), `level_names`, `xp_per_implementation` (100),
  `xp_effect_max` (50) per organization; changed by org admins. A level-up is computed in the same
  transaction as the award, written to the audit log with the item that caused it, and the item's
  originators get a `castle_level_up` notification.
* **Rating** is per department: period and all time, implemented items and confirmed effect shown next
  to XP; XP per 10 employees is a separate column and only where the admin entered `headcount`.
  No personal totals anywhere; «Мой профиль» shows what each of my implemented ideas brought (credit).
* **Council** (`council_entries`, append-only): arguments for/against by any member who sees the item;
  recommendations (implement, pilot, clarify, reject, rework) and dissent with a reason by anyone except
  the originators; hand-off to the decision owner only by the maintainer (stage `review → decision`).
  Entries never change a status. Asking the author, starting a pilot and deciding remain the existing
  workflow steps with their existing rights. The page states who decides.
* **AI advisor: superseded by ADR-0013** (minimal advisor, rules labelled «без ИИ», optional local model). Original note: No AI service is connected and none was approved (paid services need
  the owner's consent). The Council shows similar items from text search and says that the advisor is
  not connected. If added later, its output is labelled as a recommendation and it may not close items,
  award XP, assign credit or decide.

**Consequences.**
+ The game cannot be gamed by volume, and a replayed or re-saved step cannot add XP.
+ The map, the Council and the rating read the same tables as the business screens.
− Larger departments still collect more XP in total; the normalized column needs `headcount`.
− Changing thresholds re-levels castles immediately (levels are computed, not stored); awarded XP
  amounts stay as awarded.
− Level-ups appear on the map after the next refresh (≤ 15 s); there is no push channel.
