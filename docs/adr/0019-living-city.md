# ADR-0019 · «Живое Королевство»: the city of departments, the district screen, architectural styles

**Status.** Accepted (owner master prompt 2026-11-11 «Живое Королевство: интерактивный город…»). Amended by ADR-0020: «Средневековая Европа» is now Камелот; titles come from the civilization registry.
Migration `0014_city.sql`; domain `platform/domain/civilizations.ts`; module `platform/modules/district.ts`;
web `web/src/lib/camera.ts`, `web/src/components/civ.tsx`, `web/src/screens/Kingdom.tsx`,
`web/src/screens/District.tsx`, `web/src/screens/Person.tsx`. Tests: `test/platform/city.test.ts` (4),
`web/e2e/city-flow.mjs` (`npm run demo:city`, 12 steps).

The game world draws real activity; it does not replace business logic. Every number on the city and the
district screen is read from existing facts (items, decisions, XP awards, questionnaires, meetings, knowledge)
under the caller's row-level security. One new fact is stored: the architectural style of a district.

## Audit (before the change)

| Area | Found | Decision |
|---|---|---|
| Map engine | SVG + React, about 10 castles and up to 300 envoys, accessible buttons and links, Playwright selectors, no WebGL | keep SVG; add a camera (see below) |
| Castle levels | XP only from `xp_awards` (implementation +100, confirmed effect ≤ +50, unique per event); thresholds 0/100/250/500/900 configurable by the admin | unchanged |
| People | `employees` view, questionnaires `employee_profiles` (RLS: self and leads), titles (ADR-0014), address forms (ADR-0016) | reused; no new person data |
| Assignment | `POST /ideas/:n/implementer` — maintainer or decision owner after «внедрять» | the card uses this rule, nothing new |
| Meetings | participants only (RLS, ADR-0015) | the Council tab shows only the caller's meetings |
| Load in hours, vacancies, required skills | not recorded anywhere | shown as «Нет данных», never 0 |

## Decisions

* **Engine: SVG with a viewBox camera, not PixiJS.** Measured on the demo city (8 districts, 13 envoys, ~750 SVG
  nodes), headless Chromium, during a mouse pan after zooming in:

  | Profile | First draw of the map | Frame time p50 / p95 / max |
  |---|---|---|
  | desktop 1440×950 | 302 ms | 16.7 / 16.7 / 16.8 ms |
  | desktop, CPU slowed ×4 | 470 ms | 16.7 / 16.8 / 16.8 ms |
  | phone 390×844, CPU ×4, light graphics | 455 ms | 16.7 / 16.7 / 16.8 ms |

  The scene is memoized; moving the camera only rewrites the `viewBox`, so a pan re-renders nothing else.
  PixiJS would add weight, a WebGL dependency and a second accessibility layer without a measured gain at this
  size. Reconsider beyond a few hundred animated sprites. Headless measurement uses software rendering; a real
  weak phone was not measured.
* **Camera.** Wheel zoom at the pointer (page scroll is kept at the whole-city view), mouse and finger drag,
  two-finger pinch, keyboard (arrows, + / −, 0), buttons «Весь город», «К Совету», «К Библиотеке». The view is
  clamped to the world, so the city cannot be lost. Flights take 0.5–1.1 s and are instant in light graphics or
  with reduced motion. A drag never clicks the building under the pointer. The view is remembered per tab and
  per layout (desktop / phone).
* **Centre of the city:** the Council palace with the Round Table (→ «Совет»), the Great Library (→ library),
  the Higher Archive (→ library, archive hall), the achievements plaza (one pedestal per achievement the castles
  really earned, same rules as the castle page; → rating). A click flies the camera there, then opens the page;
  Ctrl/⌘-click opens it as a plain link.
* **Castle click → district.** The camera flies to the castle and `#/castles/:id` opens. The list under the map
  keeps the quick summary in the side panel (with «Войти в замок»).
* **Styles («цивилизации»): Средневековая Европа, Япония, Монголия, Казахское ханство.** Original drawings from
  the same isometric primitives, no borrowed game art; each style has its own drawing for each of the five
  levels and the same number of houses per level, so no style is «stronger». The head of the department or an
  org admin chooses (`app_set_civilization`, SECURITY DEFINER, other heads and members get 403); the choice is
  logged (`castle.civilization_changed`, from → to, actor) and shown in «Развитие». It changes no XP, level,
  rating or right (tested). The catalog is a check constraint plus `CIVILIZATIONS`; adding a style is one
  migration line, one catalog entry and one drawing. The style is chosen by the department and says nothing
  about the people in it.
* **District screen** (`#/castles/:id/:tab`): header (style, head with title, level, XP to the next level, rank,
  people, tasks in progress, items in review, implemented, last achievements) and six tabs — Состав, Задачи
  (Kanban by status, cards lead to item pages where statuses really change), Инициативы (search and status
  filter), Совет (items at the Round Table, decisions with author and date, meetings — participants only, call a
  small council), Наследие (knowledge from the department's items), Развитие (five levels in the district's
  style, XP history, achievements, style history, a person's contribution). The last tab is remembered per
  viewer.
* **Staff groups without personal judgement:** Командование — the head and those with maintainer / decision
  owner roles; Специалисты — confirmed results (implemented as implementer, or confirmed as executor);
  Основной состав — everyone else; Потребности отдела — «Нет данных» with the reason. No rarity, no «низшие».
* **Cards and privacy.** A card shows name, job, game title, specialization (first skill from the questionnaire),
  load «Нет данных» (task hours are not recorded), capacity from the questionnaire, active tasks, confirmed
  results. Skills and hours are visible to the person and to leads; preferences never appear on cards — only on
  the person's own page. Avatars are initials on a colour derived from the membership id, never from the name.
* **Card actions are real:** Профиль, Задачи, Инициативы (person page sections), Вклад в замок (XP history
  filtered to the person), Пригласить в Совет (leads; opens the meeting call with the person preselected —
  consent rules of ADR-0015 unchanged), Назначить задачу (only items where the caller is maintainer or decision
  owner after «внедрять»; the same endpoint and rule as the item page).
* **«Войти в Совет»** from a royal message passes through the city: the camera flies to the palace, then the
  meeting or Round Table opens; «Пропустить» goes at once; light graphics skip the flight; the workspace view
  goes straight in.
* **Residents:** one walking figure per five people of the department (recorded headcount), at most four per
  district and 24 in the city, none in light graphics. Decoration of size only.
* **«Рабочее пространство»:** the same departments as a table without the map or animations, remembered per
  viewer; every work function stays reachable without the map.
* **Titles** stay as in ADR-0014/0016: King, Regent, head of castle, guild titles set by the admin (Commander,
  Master, Keeper… are guild titles), Milord/Milady and the neutral form chosen by the person. Titles give no
  rights.

## Not done / limitations

* Load in hours, vacancies, required competencies and capacity shortage are not tracked — shown as «Нет данных».
* «Специализация» is self-declared in the questionnaire; «Специалисты» are confirmed results only.
* No AI: the MODUS ADVISOR slot is unchanged (rules without a model, ADR-0013); nothing on the city is AI.
* Envoys and construction use the existing animations (ADR-0011/0012); no new art for the Round Table hall.
* Performance is measured headless; atlases and sprite caching are not needed at this size and not built.
