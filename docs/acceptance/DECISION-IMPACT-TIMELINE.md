# Decision & Impact Timeline — acceptance scenarios

These are **proposed scenarios**, not executed automated tests. A later implementing PR should turn each into reproducible domain/API/PostgreSQL regressions.

| ID | Situation | Expected result |
|---|---|---|
| DIT-01 | Minor improvement saves time over 12 independently measured disjoint monthly windows | Show verified cumulative savings for only those windows; unmeasured months excluded |
| DIT-02 | Large initiative granted an award in year 1, rolled back in year 3 due to changed costs | The original award, rationale and date remain; rollback and costs appear as separate facts |
| DIT-03 | Award based on falsified evidence | Independent correction/revocation event references original award; no erasure or silent renaming |
| DIT-04 | Proposal rejected in 2026 but adopted after lower equipment prices in 2028 | New authorized decision round; original 2026 rejection remains with its old rationale |
| DIT-05 | Originally useful proposal later causes verified harm | Positive and negative observations both visible; current applicability reflects rollback |
| DIT-06 | Same idea adopted at two sites with different outcomes | Separate adoption episodes; Site A benefit and Site B harm never conflated |
| DIT-07 | Two independently verified reports cover the same dates, deployment and metric | Aggregation blocked or deduplicated with explicit provenance; no double counting |
| DIT-08 | Only a predicted benefit or a pending review exists | No verified impact badge; recognition evidence type displayed honestly |
| DIT-09 | Later measurement backdated to an earlier effective date | Historic “as known then” view excludes the late report; current view shows both timestamps |
| DIT-10 | Original author has left the organization when benefit is discovered | Proven historic authorship remains; privacy and tenant permissions still enforced |
| DIT-11 | A different employee implements a revised version of an old idea | Distinct credit for original author and implementer only where causal chain is evidenced |
| DIT-12 | Decision owner tries to independently verify their own experiment or award | Authorization denies self-review, including via different memberships linked to one user |
| DIT-13 | Concurrent reconsideration / recognition writes | Exactly one terminal decision per round; no lost append-only events |
| DIT-14 | Paused solution continues to have calendar time elapse | No automatic accrual of unmeasured benefit |
| DIT-15 | Different metrics (tenge, minutes, safety incidents) | No silent numerical addition or scalar global rank |
| DIT-16 | Evidence from private Lab or another tenant is linked to public award | Reject unauthorized access; no leakage in user profiles or notifications |

## Definition of Done for implementation PR

- All scenarios above mapped to automated tests, or any deferred scenario explicitly tracked.
- DB schema validates organization boundaries, references, append-only events and authorized independent verification.
- History can be reconstructed as known at any prior date (both effective and record time).
- Profile view remains correct with no measurements, contradictory measurements and delayed discoveries.
- Tests execute locally *and* in GitHub CI before production merge.
