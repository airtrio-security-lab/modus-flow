# ADR-0011 · «Королевство»: a game view without personal scores

**Context.** The owner asked for a less standard design and for gamification: castles that grow with
ideas, an envoy that carries an idea and waits for approval — «то же самое, только в живой игре».
On 2026-11-11 the owner chose, from the options offered:

* a **separate screen** over the same data — the workflow screens, rules and tests stay as they are;
* castles grow **only from implemented items**;
* castles belong to **departments**, not people;
* an **illustrated map** style (top-down, parchment).

**Decision.** `GET /api/v1/orgs/:org/kingdom` returns, under the caller's row-level security:
one castle per active department with `towers` (implemented items), `building` (in progress),
`envoys` (open items), `waiting` (first response overdue) and `returned` (rejected or closed);
open items as envoys with a `mine` flag (author or the person credited); and the number of open items
without a department («Вольные земли»). The screen draws an envoy's position from its real status only.

**Consequences.**
+ Submitting many items does not grow a castle, so the game does not reward noise.
+ No ranking of people: the earlier rule «без рейтингов людей» holds. A late answer shows as an envoy
  waiting at the gates with a red pennant — pressure on response time, not on employees.
+ Members see nothing new: «Все обращения» already lists every published item; guests are refused.
− Castles of departments with more people grow faster; the map compares activity, not efficiency.
− A department switched off loses its castle (its items count in no castle until reassigned).
− Polling every 15 s while the page is visible; push updates would need a server channel (planned with
  notifications delivery).
