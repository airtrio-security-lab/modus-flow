# ADR-0021 · The game world model: one organization = one commonwealth; civilizations are department styles

**Status.** Accepted (owner clarification 2026-11-11). Migration `0016_commonwealth.sql` (additive: one column).
Changed: `admin.ts` (setting), `context.ts` (`realmName` in `/me`), `domain/civilizations.ts` (model note,
names), web wording. Tests: `test/platform/commonwealth.test.ts` (3), `web/e2e/city-flow.mjs` (rename step).

## Model

| Real world | Game world | Where it lives |
|---|---|---|
| Organization (tenant), e.g. ГК «Модус Трейд» | one **commonwealth**, «Великое Содружество» by default | `organizations` row; `organizations.realm_name` |
| Department | a district of the commonwealth | `departments` (unchanged) |
| — | the district's **civilization** (Камелот, Японский сёгунат, Казахское ханство, Монгольская держава) | `departments.civilization` — a style, never a tenant |
| Company council | **Большой Круглый стол** of the whole commonwealth, owned by no civilization | `meetings.scope = 'royal'`, escalations (ADR-0020) |
| Department council | the district's small council in its civilization's hall | `meetings.scope = 'castle'` |

* The real company name (`organizations.name`) stays where identification matters: the frame of the app,
  administration, documents. The game interface uses the commonwealth name: the city page, the map cartouche,
  the councils page, the menu item.
* Each organization names its own commonwealth (admin only, 3–60 characters, logged as `admin.settings_updated`),
  defines its departments and lets them choose civilizations. Data and rights stay isolated per organization by
  row-level security, as before; tested with two organizations.
* Civilizations never create organizations, memberships or rights; switching them keeps XP, tasks, councils and
  decision history (tested).
* Nothing destructive: no table was dropped or renamed; existing data receives the default name.

## Not changed (open for the owner)

* The admin-assigned titles «Король» and «Регент» are kept as they were (existing data and wording in messages).
  If the commonwealth should use other words for its head (for example «Глава Содружества»), it is a registry
  change, not a data change.
* Internal identifiers (`kingdom` routes, `scope = 'royal'`) keep their names to avoid destructive renames;
  they are not shown to people.
