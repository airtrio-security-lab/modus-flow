# ADR-0020 · Civilizations, titles and councils: one data model, four looks, one Great Round Table

**Status.** Accepted (owner brief «MODUS FLOW — CIVILIZATIONS & COUNCILS», 2026-11-11). Amended by ADR-0021: the game world is the organization's commonwealth; «Японское княжество» is now «Японский сёгунат», Камелот is a civilization of knighthood (not a kingdom).
Migration `0015_civilizations_councils.sql`; registry `platform/domain/civilizations.ts`; modules `titles.ts`,
`council.ts` (escalation, council place), `meetings.ts` (agenda, place), `notifications.ts` (wording by civilization);
web `components/civ.tsx` (Camelot, council halls), `components/scenes.tsx`, `components/TitlesAdmin.tsx`, `District.tsx`,
`Council.tsx`, `Meetings.tsx`, `Inbox.tsx`, `Profile.tsx`, `Kingdom.tsx`. Tests: `test/platform/civilizations.test.ts` (5),
`web/e2e/councils-flow.mjs` (`npm run demo:councils`, 8 steps).

## Audit (before the change)

| Area | Found | Decision |
|---|---|---|
| Styles | 4 styles from 0014; «Средневековая Европа» only as a castle | renamed to **Камелот** (`camelot`) in 0015 with armory, workshop, council hall; old log entries stay readable («europe» → «Средневековая Европа (ныне Камелот)») |
| Titles | King, Regent, guild titles by admin, «Глава замка «X»» | a **registry** per civilization; titles follow real functions and the person's choices |
| Councils | `meetings.scope` already `castle` (department) or `royal` (company); Round Table entries per item | small council = `castle` meeting, Great Round Table = `royal` meeting; added escalation, agenda, entry place |
| Notifications | wording rendered at read time from the event and the reader's title / chosen form | invitation words come from the meeting's civilization; facts unchanged |
| Rights | rules read roles only; no rule reads a title | unchanged, re-tested |

## Decisions

* **Registry, not code per civilization.** `CIVILIZATIONS` holds name, motto, council hall, invitation wording and titles.
  One process, one component set: the civilization chooses pictures and words only. Adding one = a CHECK value, a
  registry entry, drawings.
* **Titles from facts, three properties kept apart** (job, rights, title). First match: neutral choice → King/Regent
  (admin) → head of the district (Даймё / Хан / Лорд·Леди / Хан) → deputy named by an admin (Каро / Султан / Сенешаль /
  Нойон) → an admin-assigned guild title → maintainer or decision owner in the district (Самурай / Би / Рыцарь / Нойон)
  → confirmed results (Такуми / Шебер / Мастер гильдии / Дархан) → novice, only by the person's choice (Оруженосец,
  Camelot) → the department's guild list → the district's neutral title (Житель …). Honors (Батыр, Баатур) only with
  confirmed achievements and only when the person shows them. Historical names are not forced into a ladder.
  The Camelot head form (Лорд / Леди) is a separate, public choice of the person — the private notification address
  form is not read for it, and nothing is guessed from names.
* **Person's choices** (`title_choices`, RLS: everyone reads, only the person writes): neutral title («Сотрудник»),
  novice title, showing an earned honor, Camelot head form. Business-style notifications switch game wording off.
* **Small councils and the Great Round Table.** An item is at the small council of its department until someone with
  authority over it — maintainer, decision owner, head of its department or an admin — passes it to the Great
  council (`app_escalate_council`: once per item, reason kind + text, only items under consideration; append-only
  `council_escalations`; audit `council.escalated`). Council entries record where they were made
  (`council_level`, set by trigger), so the department's history stays visible. The decision owner and the workflow do
  not change; there is no vote with legal force.
* **Who is called to the Great Round Table:** the heads of all active districts (every civilization equally), the item's
  maintainer, decision owner, author and the organization's escalation contact — one message each
  (`app_notify_escalation`, proven by the escalation row, dedupe per escalation). Heads addressed by their title read
  «Главы владений, вас созывают к Большому Круглому столу…»; a person who chose «Милорд/Миледи/Коллега» is addressed so.
* **Invitations by civilization** (rendered at read time): «Даймё/Самурай…, вас ожидают в зале совета: Зал даймё…»,
  «…, в Орде созывается совет: Ханская юрта…», «…, вас призывают в зал Камелота: Зал рыцарей…», «…, вас приглашают на
  совет: Совет нойонов…». The card always shows place, topic, time, organizer, agenda, why the reader, what to do.
  A style change re-words future readings; the facts (topic, time, organizer, agenda, link) are identical — tested.
* **Agenda** (`meeting_agenda`, fixed at the call, visible to participants only).
* **Places and scenes.** Each district has a council hall on the map (click → camera → the district's council tab);
  each council has a flat interior scene (Japanese hall, khan's yurt, knights' stone hall, ger of the noyons, the Great
  hall with four equal banners) above the same working blocks. Representatives «arrive» with a short animation,
  off in light graphics and with reduced motion.
* **Camera.** Calling a small council flies to its hall, passing an item flies from the castle to the palace; both
  have «Пропустить» and are instant in light graphics.
* **Cards.** One information structure; the frame ornament follows the district's style (original CSS patterns); a
  small sign shows what the title stands for (head, deputy, authorized, master, novice) — a function, not a rating.

## Limitations

* Scenes are illustrations, not interactive 3D rooms; arrival animation is decorative and tied to real seats.
* A deputy is named by an admin because the company data has no such position.
* Japan and Camelot have no honor title, only Camelot has a novice title — by design of the registry, not a gap in rights.
* Changing a style re-words already delivered invitations when they are read again (facts stay the same).
