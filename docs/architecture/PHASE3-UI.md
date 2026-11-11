# Phase 3 — web interface (PWA)

React 18 + TypeScript + Vite, in `web/`. Built into `web/dist` and served by the platform server from
the same origin (`MODUS_SERVE_WEB=true`), so the demo is one process with no CORS. Installable PWA:
the service worker caches the shell only, never API responses.

## Screens

| Route | Who | What it answers |
|---|---|---|
| sign-in | everyone | Demo only: pick a fictional employee. **Imitation of SSO**; production uses OIDC (ADR-0009) |
| `#/` Мои обращения | everyone | What I raised (or what was recorded from my words), its stage, and what is waiting for my answer |
| `#/new` Новое обращение | everyone | Problem or idea in plain words; topic and department; similar existing items while typing; «записываю со слов коллеги» (channel, colleague, note); files |
| `#/board` Доска (канбан) | everyone | Columns are the five author-facing stages (Новые, Рассмотрение, Решение, Реализация, Итог). Dragging a card (or «Перевести» on touch / keyboard) opens the workflow step that move means: take over, decide with a reason and implementer, reject / close with a reason, confirm implementation. Backward moves and moves the rules forbid are explained, never applied silently. «Мне / Все», topic filter; finished items older than 14 days folded |
| `#/kingdom` Королевство | members | The same items as a living strategy map (ADR-0011, ADR-0012). Each active department is an **isometric castle** whose level comes from XP the database awards only for confirmed events: 1 Поселение (timber palisade) → 2 Крепость (stone keep and walls) → 3 Цитадель (corner towers) → 4 Королевский замок (roofs, rear tower, more banners) → 5 Легендарная крепость (golden spire, glow). Nothing grows at random: when a refresh shows a higher level, the new parts rise in a short construction animation, a notice names the castle and level, and the castle's history records which item brought it. Open items are envoys labelled «Обращение №…» standing where the item really is. The side panel shows level, XP bar, achievements, XP history (item, author, date) and the department's open items. Labels sit on solid plates; parchment is only a decorative cartouche. Phones get a two-column layout. «Облегчённая графика» removes textures and animation (automatic on slow devices or with reduced motion) |
| `#/rating` Рейтинг | members | Departments, never people: XP for a period (30 days, quarter, year) and all time, implemented items, confirmed effect, and — separately — XP per 10 employees where the admin entered the department size. Table on desktop, cards on phones |
| `#/council` Совет | members | Sessions grouped by stage (ждут решения, пилот, рассмотрение, уточнение) with initiator, decision owner, argument counts and deadline. «Мне решать» / «Я веду» filters for leads |
| `#/council/:n` Круглый стол | members (guests: their items) | A wooden round table with the real participants: initiator (gold ring), recorder, maintainer, decision owner (crown), implementer, pilot owner, department heads and anyone who spoke. Selecting a seat opens that person's position. The right panel holds the subject, status, decision owner and deadline, arguments for/against, recommendations and dissent, the person's own form, and the real actions of those the rules name: ask the author, start a pilot, hand off to the decision owner, decide. «Рекомендации Совета — это совет, а не решение». Journal with times and authors. More than 10 participants or a narrow screen: a compact list instead of the circle. Similar items come from text search (labelled «это поиск, не ИИ»). **Помощник Совета** (ADR-0013): a dashed seat below the table «без права голоса» and a panel with executor suggestions from questionnaires and load, each with reasons, labelled «Правила, без ИИ»; the item's maintainer or decision owner confirms one, the decision form then preselects that person |
| `#/me` Мой профиль | everyone | «Королевские послания» settings (style, form of address, grouping, optional messages, channels). Four separate lines: job (directory), rights (roles), game title («прав не даёт»), achievements. Questionnaire for the advisor (skills, preferences, hours a week; seen by the person and leads only). Roles, quick links (submit, my items, notifications, overview and settings for leads/admins), what each of my implemented ideas brought to its castle — credit, no personal total — and device settings (theme, lite graphics, sign out) |
| `#/meeting` Разбор совещания | everyone | Owner's pain «идеи теряются в WhatsApp, на совещаниях, в почте»: all questions from one meeting, chat or e-mail at once; each becomes its own item with its own raiser, topic, owner and deadline; source note «встреча, дата». Each row has its own Idempotency-Key, so a retry never duplicates and one failure does not lose the others |
| `#/meeting/protocol` Протокол целиком | leads, admins | Paste a whole protocol (or a fictional sample). Method: «Разбор по шаблону (без ИИ)», or a local model when connected and reachable (otherwise disabled with the reason). The detail page shows the source text with numbered marks, the SHA-256, and one card per candidate: exact quote with character positions, kind, title, wording, who raised it (preselected when the name matches the directory), topic, department → «Подтвердить и зарегистрировать» or «Не задача». Nothing is created and nobody is notified until a person confirms |
| `#/meetings` Заседания с записью | participants | Tab next to «Обращения на Совете». My meetings: royal or a castle's small council, organizer, consents «N из M», recording state, «ждёт вашего ответа» (ADR-0014) |
| `#/meetings/new` Созвать заседание | leads, admins | From the council (`?idea=`), from a castle (`?department=`, its people preselected) or the list. Topic, council, participants, the organizer's own consent checkbox |
| `#/meetings/:id` Заседание | participants only | Time; cancelled banner; my attendance; organizer panel (reschedule, add / remove participants, cancel with reason — until recording); without everyone's consent: «письменный протокол без записи» (ADR-0015); a purged recording shows when and why. Participants with consent states and my «Согласен(на) / Не согласен(на)»; recorder with a sticky red «Идёт запись мм:сс», pause, stop, save (retry keeps the recording), or file upload; player; transcript with a source label (engine / manual / **prepared**, yellow); findings by template «без ИИ» or local model with type, ▶ timestamp, quote, speaker (or «не сопоставлен»), confidence, basis; lead participants confirm into an item, keep in memory or dismiss |
| `/share?text=…` | Android | PWA share target: «Поделиться» from WhatsApp → the submission form opens with the message text, source «Мессенджер», «записываю со слов коллеги» preset. iOS does not support share targets for web apps: copy and paste there |
| `#/items/:n` Обращение | everyone | Title, status, five-stop signal line (registration → review → decision → implementation → result), what happens now and who is next, the current text, contextual actions, full history, passport (people, source, deadlines, credit, files) |
| `#/work` Рабочее место | maintainers, decision owners | Queues: assigned to me, without an owner, overdue, no movement |
| `#/all` Все обращения | everyone | Russian full-text search and filters (status, topic, department, source) |
| `#/overview` Обзор | leads, admins | One-sentence verdict of what needs attention; totals; needs-attention list; recurring questions; sources; by department and topic |
| `#/inbox` Королевские послания | everyone | Only what the person takes part in (enforced by the database). Seal icon by category, headline (game or business per the person's choice), the game sentence addressed by title or chosen form, the plain business sentence always, meeting facts (topic, organizer, time, item, why you, required or optional, what to do), time, read state, grouped repeats, filters; actions «Войти в Совет», «Подтвердить участие», «Не могу присутствовать», «Ознакомиться с вопросом». Urgent unread messages unfold once (ADR-0016) |
| `#/settings` Настройки | org admins | Retention of meeting material: days for audio and transcripts, per-meeting expiry, legal hold, deletion with a reason, the immutable log (ADR-0015). Deadlines and escalation contact; routing rules; topics; departments (switched off, never deleted) |

## How the UI connects to the API

```
web/src/lib/api.ts ──fetch /api/v1/…──▶ platform/http/app.ts ──▶ modules ──▶ PostgreSQL (RLS)
  token: sessionStorage (demo)          Authorization: Bearer
  Idempotency-Key on every mutation     replay-safe workflow steps
  errors → plain Russian text           {error, message, issues}
```

* **Permissions:** `web/src/lib/can.ts` is a copy of `platform/domain/policy.ts`, used only to decide
  which buttons to show. The server and the database enforce the rules again; when they disagree, the
  user sees the server's message.
* **Statuses:** computed by the database view `idea_overview`; labels and tones are in `lib/status.ts`
  (mirror of `platform/domain/status.ts`).
* **History:** `screens/timeline.ts` merges stored revisions, reviews, checks, evidence, decisions,
  files and escalations by time. Nothing is synthesised; negative evidence is shown like any other.

## Design

«Quiet Intelligence»: paper `#f6f7f6`, graphite ink, one teal accent `#0e7469`; amber, red and green
only for state. One typeface (IBM Plex Sans, bundled so the demo runs offline). The signature element
is the signal line; everything else stays quiet. Mobile: bottom tab bar around a central «Подать»;
stop names collapse to the status chip and the «what happens now» line.

## Navigation (2026-11-11)

Three views over the same data: **Королевство** (map and rating), **Совет** (discussion and decisions),
**Работа** (Обращения with tabs Мои / Все / Мне на рассмотрение / Доска / Разбор совещания). The rail
lists Королевство, Совет, Обращения, Доска, Рейтинг, Мой профиль; then Уведомления, Обзор (leads),
Настройки (admins). Phones: Королевство, Обращения, «+», Совет, Профиль; the bell sits in the header.
Fantasy words never replace the business ones: every envoy is «Обращение №…», every decision is named.
A «Как это работает» strip (hideable) answers where to submit, where the status is, where it is
discussed, who decides and what grows the castle.

## Checks

* `npm --prefix web run build` — TypeScript (strict) + production build.
* `npm run demo:e2e` — Playwright drives the real UI against the seeded demo: submit → question to the
  author → new version → question closed → decision with implementer → progress → implemented → the
  author sees the result; a phone question recorded on behalf of an engineer; a meeting review with two
  questions from different people; a WhatsApp message shared into the form; Kanban take-over by drag and drop and an explained forbidden move;
  owner overview. Needs
  Playwright installed locally; it is not in CI yet.
* `npm run demo:kingdom` — the 90-second kingdom scenario on a fresh demo database: a warehouse idea →
  envoy on the map → Council (argument for, argument against, recommendation, hand-off) → the operations
  director decides → progress and confirmation → the warehouse castle goes 150 → 250 XP and becomes
  «Цитадель» → effect +50 → the rating shows 300. Every number is read from the screen.

## Known limitations

* No offline submission queue: without a connection the form shows an error and keeps the text.
* The completion report appears in the history as a progress report (the API does not mark which one
  completed the item).
* Suggested revisions by colleagues, verification cancel and contribution confirmation have API
  support but no screens yet.
* Share target works only after the PWA is installed on Android (Chrome «Установить приложение»); it was checked
  with a direct `/share?text=` request, not on a real phone.
* No WhatsApp / e-mail intake bot: WhatsApp Business API is a paid service and needs the owner's approval;
  a Telegram bot or an `ideas@` mailbox are the free alternatives (plan).
* Accessibility: keyboard focus, labels and reduced motion are handled; no screen-reader audit yet.
* Kingdom refreshes by polling every 15 s while visible; there is no push channel.
* MODUS ADVISOR works without AI by default (template parsing, questionnaire matching) and says so; an
  optional local Ollama model is supported but was tested only with a stub. Summaries, risks and questions
  for the Council by a model are not implemented. Paid AI APIs are not connected (owner approval needed).
