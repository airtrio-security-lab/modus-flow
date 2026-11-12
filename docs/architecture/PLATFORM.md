# MODUS FLOW Platform — target architecture

Status: **Phase 1 foundation implemented** (this document describes what exists and what is planned;
planned parts are marked). Decisions are recorded in [`docs/adr/`](../adr/).

## Spaces

```
┌──────────────── PERSONAL LAB (user-owned) ────────────────┐
│ lab_drafts ─< lab_draft_versions (append-only)            │   visible to owner only (RLS)
│ six guided steps; private notes; future AI dialogue       │
└──────────────┬────────────────────────────────────────────┘
               │ explicit publish (one transaction, idempotent)
               │ snapshot of exactly: title, observation→problem,
               │ proposal→proposal, pilot→success criteria
┌──────────────▼──────────── ORGANIZATION (tenant) ─────────┐
│ ideas #N ─< idea_revisions (content frozen)               │   visible to active members
│        ─< reviews (body frozen; change requests, objections)│   of that organization only
│        ─< verifications ─< verification_evidence (append) │   (RLS + composite FKs)
│        ─< decisions (append-only; merge ≠ proven impact)  │
│        ─< contributions (evidence-linked, no points)      │
│ notifications (targeted, deduplicated, no free text)      │
│ audit_events (append-only)                                │
└───────────────────────────────────────────────────────────┘
  COMMUNITY (planned): voluntary cross-organization publication — separate explicit act,
  never automatic, never including Lab content.
```

## Runtime

```
browser / PWA (Phase 3) ──HTTP JSON──▶ platform/http/app.ts ──▶ platform/modules/* ──▶ PostgreSQL
                                        │ auth (HMAC token → user id)      │ withTx(): BEGIN
                                        │ zod validation                   │  set_config(app.user_id/org_id/membership_id)
                                        │ error mapping, request ids       │  SET LOCAL ROLE modus_app  ← RLS applies
                                        └ no permission logic here         └ COMMIT / ROLLBACK
```

The legacy prototype (`src/`, `public/`, port 3000) is untouched and keeps working. The platform API
runs separately (`npm run platform:start`, port 3100).

## Module boundaries

| Layer | Path | Responsibility | Depends on |
|---|---|---|---|
| Domain | `platform/domain/` | Vocabulary, lifecycle, authorization policy, automated checks, Lab projection. Pure, no I/O. | zod |
| Data | `platform/db/` | Pool, transactions with identity binding, migrations, PG error mapping. | pg |
| Modules | `platform/modules/` | Use cases: `lab`, `ideas`, `context`, `notifications`, `idempotency`, `audit`, `provisioning`. | domain, db |
| HTTP | `platform/http/` | Routing, authentication, validation, response shaping. | modules |
| CLI | `platform/cli/` | Migrate, seed fictional demo org, issue tokens. Operator-only. | modules |

Rules: domain never imports db/http; HTTP never queries SQL; provisioning (privileged) is reachable
only from CLI and tests.

## Data model (Phase 1)

| Model | Table | Key constraints |
|---|---|---|
| Organization | `organizations` | unique slug; per-org idea counter |
| Membership / Employee | `memberships`, view `employees` | unique (org, user); roles ⊆ {employee, maintainer, decision_owner, org_admin}; Employee is a projection, not a copy |
| Personal draft | `lab_drafts`, `lab_draft_versions` | owner-only; versions immutable; published ⇔ linked idea |
| Idea | `ideas` | unique (org, number); stage enum; no delete; author not updatable |
| Revision | `idea_revisions` | content frozen by trigger + column grants; one `current`; origin publication/author_update/suggestion; suggestions require rationale |
| Review | `reviews` | body frozen; objection must reply to a review; only change requests carry open/resolved state |
| Verification | `verifications`, `verification_evidence` | purpose hypothesis/impact; completed ⇒ outcome + conclusion + reviewer; concluded runs immutable; evidence append-only |
| Decision | `decisions` | append-only; rationale ≥ 10 chars; outcome merge/reject/close |
| Contribution | `contributions` | linked to a source record; no self-confirmation; revocation needs reason; idempotent per (member, kind, source) |
| Notification | `notifications`, `notification_subscriptions` | (recipient, dedupe key) unique; actor ≠ recipient; subscriptions honoured |
| Audit | `audit_events` | append-only for every role |
| Idempotency | `idempotency_keys` | per (user, scope, key); stored in the operation's transaction |

Every organization-scoped foreign key is composite `(organization_id, id)`: a row from tenant A can
never reference a row of tenant B, even through a buggy service or an operator script.

## Security model

* **Tenant isolation in the database.** RLS on every table; policies require
  `organization_id = app.org_id` **and** active membership of the caller. Forging `app.org_id`
  without membership returns nothing (tested).
* **Unprivileged API login.** The API connects as a non-owner, non-superuser member of `modus_app`
  (startup check), so `RESET ROLE` cannot escape RLS. Migrations use a separate owner connection.
* **Bound actor.** Policies require the bound membership to belong to the bound user (`app_actor_ok()`).
* **Workflow invariants in the database.** Rows are born in initial states; decisions only by the
  assigned, non-author decision owner; no self-assignment, self-verification or self-confirmation;
  resolved change requests and published drafts are final.
* **Authorship cannot be forged.** Restrictive policies force `author/decided_by/recorded_by/
  created_by = app.membership_id` on insert.
* **Least privilege.** The application role has column-level `UPDATE` only on workflow state columns;
  revision text, review bodies, decisions, evidence and audit are not updatable by it at all.
* **Private Lab.** Owner-only RLS; organization audit and notifications carry no draft content or id.
* **Uniform 404s.** Foreign organization = missing organization; foreign draft = missing draft.
* **Auth.** Interim HMAC tokens with expiry; no default secret; roles never in the token.
* **Inputs.** zod with `.strict()` (no smuggled fields such as `authorId`), 256 KB body limit,
  `application/json` only, UTF-8 decoded once.

## Idea lifecycle

`Private draft (Lab)` → `published` → `review` ⇄ `development` → `verification` → `decision` →
`adoption` → `impact_verification` → `closed`; reject/close from any open stage. Stage is only the
position; review threads, verification runs, decisions and impact results keep their own state
(ADR-0006). Implemented in `platform/domain/lifecycle.ts`; workflow endpoints arrive in Phase 2.

## Idea Verification Engine

1. **Automated checks** (`platform/domain/checks.ts`, exposed on `GET …/ideas/:n` as `checks`):
   completeness, success criteria, maintainer independent of author, decision owner independent of
   author, no open blocking change requests, revision consistency, field-verification presence
   (warning — absence is never a pass). Gates: `start_verification`, `decide`.
2. **Human / field verification** (`verifications` + `verification_evidence`): plan, owner, success
   criteria, baseline/result, positive and negative observations, references, reviewer conclusion with
   outcome positive / negative / inconclusive. Schema in place; workflow in Phase 2.

AI may later summarize evidence; it never writes outcomes, decisions or contributions.

## API v1 (implemented)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/health` | public |
| GET | `/api/v1/me` | user + memberships |
| GET/POST | `/api/v1/lab/drafts` | own drafts |
| GET/DELETE | `/api/v1/lab/drafts/:id` | own draft with version list |
| POST | `/api/v1/lab/drafts/:id/versions` | `{baseVersion,title,content}`; stale base → 409 |
| POST | `/api/v1/lab/drafts/:id/publish` | `{organization}`; `Idempotency-Key` supported |
| GET | `/api/v1/orgs/:org/ideas[?stage=]` | list |
| GET | `/api/v1/orgs/:org/ideas/:number` | revisions, reviews, verifications, decisions, checks |
| GET | `/api/v1/orgs/:org/notifications` | own inbox, rendered messages |
| POST | `/api/v1/orgs/:org/notifications/read` | `{ids}`; own inbox only |

## API v1 — workflow (Phase 2)

See [`PHASE2-WORKFLOW.md`](PHASE2-WORKFLOW.md) for the review, revision, suggestion, verification,
evidence and decision endpoints and the UI integration plan.

## API v1 — feedback MVP (Phase 2.5)

Hackathon brief «обратная связь и предложения сотрудников» + the owner's requirements: nothing gets
lost, everyone sees the stage, the owner sees what needs attention. Migrations 0004 + 0005.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/orgs/:org/ideas` | quick submission: `{kind: idea\|problem, title, problem, proposal?, categoryId?, departmentId?, sourceChannel, sourceNote?, raisedBy?}`; routed by the database (rule → head of department → unrouted queue); `Idempotency-Key` |
| GET | `/api/v1/orgs/:org/ideas?q=&status=&kind=&category=&department=&channel=&mine=&assigned=&overdue=&stale=&open=` | search over `idea_overview` (Russian full text + substring) |
| GET | `/api/v1/orgs/:org/ideas/similar?q=` | up to 5 similar items before creating a duplicate |
| POST | `…/ideas/:number/implementer` | after a merge decision, by the leads |
| POST | `…/ideas/:number/implementation` | `{report}`; implementer (not an originator) or a lead → `implemented` |
| POST | `…/ideas/:number/attribution/decline` | the person recorded as "raised by" declines the credit |
| POST/GET | `…/ideas/:number/attachments[/:id]` | raw body, `Content-Type`, `X-File-Name` (URL-encoded); ≤ 5 MB, ≤ 10 per item; signature must match type |
| GET | `/api/v1/orgs/:org/directory` | departments, categories, active members, settings (full members only) |
| GET/POST | `/api/v1/orgs/:org/routing-rules`, `POST …/:id/active` | org_admin writes; rules are deactivated, never deleted |
| POST/PATCH | `/api/v1/orgs/:org/departments[/:id]`, `/categories[/:id]` | org_admin |
| PATCH | `/api/v1/orgs/:org/settings` | first-response hours, resolution days, stale days, escalation contact, `realmName` — the name of the organization's commonwealth in the game (ADR-0021; 3–60 characters; the real company name is not changed) |
| GET | `/api/v1/orgs/:org/analytics?from=&to=` | leads and admins; counts and shares from recorded facts only |
| GET | `/api/v1/orgs/:org/kingdom` | full members; castles per active department (`towers` = implemented, `building`, `envoys`, `waiting`, `returned`), open items as envoys with a `mine` flag, `wildlands` = open items without a department, each castle's `civilization` and `achievements` (count, same rules as the castle page). Computed under RLS (ADR-0011) |
| GET | `/api/v1/orgs/:org/rating?period=30\|90\|365\|all` | full members; per department: `xpPeriod`, `xpTotal`, level, implemented and effect XP for the period and all time, `xpPer10` / `implementedPer10` only when `headcount` is set; rank by period XP. No personal fields (ADR-0012) |
| GET | `/api/v1/orgs/:org/castles/:id` | full members; level, XP, XP history (item, credited author, kind, XP, running total, level-ups), achievements with dates |
| GET | `/api/v1/orgs/:org/castles/:id/district` | full members (guests 403, other orgs 404); the district screen (ADR-0019): style, head, level/XP/rank, counts, staff in groups (command = head or maintainer/decision owner; specialist = confirmed results), questionnaire skills/hours for the person and leads only, preferences never; load and needs `null` («нет данных»); open items, all items, Council (meetings only for participants), knowledge from the department's items, XP history, achievements, style history, items the caller may assign |
| PUT | `/api/v1/orgs/:org/castles/:id/civilization` | head of the department or org admin; `{civilization: camelot\|japan\|mongolia\|kazakh}`; logged as `castle.civilization_changed`; changes no XP, level, rating or right |
| GET | `/api/v1/orgs/:org/people/:id` | full members; the working card: job, department, game title, skills/hours (self or leads), preferences (self only), tasks, initiatives, confirmed results; load `null` |
| GET | `/api/v1/orgs/:org/civilizations` | full members; the registry (ADR-0020): name, motto, council hall, titles of each civilization; the Great Round Table; escalation reasons |
| POST | `/api/v1/orgs/:org/ideas/:n/council/escalate` | maintainer, decision owner, head of the item's department or admin; `{reasonKind, reason}`; once per item, items under consideration only; notifies the heads of all districts and the item's people once; idempotent |
| PUT | `/api/v1/orgs/:org/titles/choices` | the person only: `{neutral, novice, showHonor, headForm: lord\|lady\|null}`; titles grant no rights |
| GET | `/api/v1/orgs/:org/me/contribution` | the caller's items and the XP each implemented one brought to its castle (no personal total) |
| PATCH | `/api/v1/orgs/:org/settings/progress` | org_admin: `xpPerImplementation`, `xpEffectMax`, `levelThresholds` (5, from 0, strictly increasing), `levelNames` |
| GET | `/api/v1/orgs/:org/council` | items under consideration the caller may see, with argument / recommendation / dissent counts |
| GET | `/api/v1/orgs/:org/ideas/:n/council` | the round table: item, seats with real roles and stance, entries, decisions, questions to the author, similar items, `can` flags for the caller |
| POST | `…/ideas/:n/council/entries` | `{kind: argument_for\|argument_against\|recommendation\|dissent, recommendation?, body}`; originators argue but never recommend; open stages only; append-only |
| POST | `…/ideas/:n/council/handoff` | maintainer (not an originator) → stage `decision`, the decision owner is notified |
| GET | `/api/v1/orgs/:org/advisor/status` | members; which method works: rules (always, «без ИИ») and the optional local model (configured, reachable). ADR-0013 |
| GET / PUT | `/api/v1/orgs/:org/me/profile` | own questionnaire: `{skills ≤ 12, preferences?, weeklyHours 0–60}`; leads read others' via suggestions only |
| GET / POST | `/api/v1/orgs/:org/protocols` | leads; POST `{title, text ≤ 20 000, method: rules\|model}` stores the text verbatim + SHA-256 and the candidates with exact quotes; idempotent |
| GET | `/api/v1/orgs/:org/protocols/:id` | source text, method label, candidates with offsets, status, item number, who decided |
| POST | `…/protocols/:id/candidates/:c/accept` | lead confirms `{kind, title, problem, proposal?, categoryId?, departmentId?, raisedBy?}` → ordinary item, `source_channel = meeting`, no XP |
| POST | `…/protocols/:id/candidates/:c/dismiss` | lead; kept as history |
| GET | `…/ideas/:n/executors` | maintainer / decision owner: suggestions from questionnaires with reasons, confirmed people |
| POST | `…/ideas/:n/executors` | `{candidate, reasons[]}`; maintainer or decision owner, not an originator; once per person; does not set the implementer |
| GET | `/api/v1/orgs/:org/titles` | full members: effective game title of everyone (assigned king/regent/guild, castle head, guild default) and guild title lists; «звание не даёт прав». ADR-0014 |
| PUT / DELETE | `…/titles/:membershipId` | admin: `{rank: king\|regent\|guild, title?}`; king and regent are unique (assigning moves the title) |
| PUT | `…/guild-titles/:departmentId` | admin: `{titles[1..8]}`, senior first; the last is the default |
| GET | `/api/v1/orgs/:org/engines` | transcription engine and analysis model: configured / reachable; both off by default |
| GET / POST | `/api/v1/orgs/:org/meetings` | list my meetings; leads call one: `{title, departmentId?, ideaNumber?, participants[], organizerConsent: true}` → participants notified (`meeting_called`) |
| GET | `…/meetings/:id` | participants only: consents, recording meta, transcripts with source, analyses, findings, `can` flags |
| POST | `…/meetings/:id/consent` | `{consent: given\|declined}` — only for oneself; fixed once recording started |
| POST | `…/meetings/:id/recording/start` | organizer; refused unless every participant consented (also enforced by the database) |
| POST / GET | `…/meetings/:id/recording` | upload raw audio (`Content-Type` audio/webm\|ogg\|mpeg\|mp4\|wav, ≤ 25 MB, signature checked, `X-Recording-Source`, `X-Duration-Ms`); download for participants (logged) |
| POST | `…/meetings/:id/transcripts` | lead participant: `{text, source: manual\|prepared}`; same text → same transcript |
| POST | `…/meetings/:id/transcribe` | lead participant; only with a configured local engine |
| POST | `…/meetings/:id/analyses` | `{transcriptId, method: rules\|model}`; the same transcript and method return the stored findings |
| POST | `…/meetings/:id/findings/:f/accept` | lead participant confirms → ordinary item (`source_channel = meeting`, note with timestamp); duplicates refused with the existing number |
| POST | `…/meetings/:id/findings/:f/note` · `/dismiss` | keep in memory without an item / dismiss; once |
| GET | `…/ideas/:n/origin` | the meeting, quote, timestamp, speaker and transcript source of an item — participants only |
| POST | `…/meetings/:id/attendance` | `{attendance: confirmed\|declined}` — only for oneself; not for cancelled meetings (ADR-0016) |
| POST | `…/meetings/:id/reschedule` · `/cancel` · `/participants` | organizer, before recording: `{scheduledAt}` (one message per new time) · `{reason}` · `{membershipId, present}` (removed ⇒ no access, no messages) |
| GET / PUT | `/api/v1/orgs/:org/me/notification-preferences` | `{style: royal\|business, addressForm: title\|milord\|milady\|master\|neutral, groupRepeats, muted[]}`; mandatory events are never muted; channels: app only |
| GET | `/api/v1/orgs/:org/notifications` | now with `headline`, `royal` (addressed to the reader or null), `message` (business, always), `category`, `urgent`, `meeting` facts (only while the reader has access), `meetingClosed` |
| GET / PUT | `/api/v1/orgs/:org/retention` | org admin: retention days (defaults 30 / 90), per-meeting dates/sizes/expiry (no content), the immutable log (ADR-0015) |
| POST | `…/meetings/:id/purge` · `/legal-hold` | org admin: `{what: recording\|transcript\|all, reason}` (refused under legal hold; logged) · `{hold, reason}` |
| — | `npm run platform:retention` | daily with the schema owner: purge expired material, re-apply logged purges after a backup restore |
| — | `npm run platform:escalate` | now also sends «Приближается срок» once per item and deadline |
| GET | `…/ideas/:n/progress` | XP awarded for the item, effect approval, whether the caller may approve it |
| POST | `…/ideas/:n/effect` | decision owner, not an originator, after a confirmed implementation: `{xp ≤ xpEffectMax, rationale ≥ 20}`, once |
| GET | `/api/v1/orgs/:org/knowledge?q=&level=&kind=&status=` | «Великая библиотека» (ADR-0017): knowledge the caller may see (every source visible, or opened to the organization by an approver), with hall, verification label, status, sources, re-applications, `stale` hint. Word search, not AI |
| POST | `…/knowledge` | curator (archivist, maintainer, decision owner, admin): `{kind, title, card, sources[≥1] (idea number / meeting / finding / knowledge), reason?}` → Летопись. Refused if the card repeats ≥ 12 consecutive words of a meeting transcript or a finding quote |
| GET | `…/knowledge/:id` | card, people, provenance (closed meetings shown only as «закрытое заседание»; purged transcripts as «удалена по сроку хранения»), chronicle assembled from source records, versions with reasons, transitions, re-applications, `can` flags |
| POST | `…/knowledge/:id/versions` | curator: `{title, card, reason}` → new version; not while a review is pending; archived knowledge only after `reverify_requested` |
| POST | `…/knowledge/:id/sources` · `/applications` | curator: add a visible source · record a re-application `{ideaNumber, note}` (confirmed once that item is implemented) |
| POST | `…/knowledge/:id/actions` | `{action, reason?}`: library_proposed (curator) → library_accepted/rejected (archivist, not the proposer) → archive_proposed (archivist; proof, applicability, last check, grounds, category; a method needs an implemented re-application, an improvement a confirmed effect, a lesson the negative experience) → archive_approved/rejected (decision owner or admin, not the author of the conclusion); reverify_requested, reconfirmed, outdated, opened_to_organization. Each writes an append-only transition and the royal message |
| GET | `…/knowledge/:id/helper` | «Помощник Архивариуса» without AI: similar knowledge and items by word similarity, possible contradictions, a template note — all labelled; `ai.connected = false` |
| GET | `…/ideas/:n/knowledge-draft` | a draft card from the item's own fields (problem, proposal, council arguments, decision, report, effect); nothing is saved |
| POST | `…/members/:id/archivist` | org admin: `{grant}` — the archivist role; audited; opens no material |
| GET | `/api/v1/orgs/:org/privacy/knowledge` | org admin: scan of every version and note for personal / confidential data by patterns — places and kinds only, no text; titles only of readable knowledge; the erasure log (ADR-0018) |
| POST | `…/knowledge/:id/erasure` | org admin: `{basis, ref, places[]}` → places overwritten with a marker; refused under a legal hold; logged without content |
| POST | `…/members/:id/pseudonymize` | org admin: `{basis, ref}` → references removed from all cards, text places with the surname erased, «Сотрудник (обезличен)» on display; once |
| — | `npm run platform:ledger -- export\|import <file>` | schema owner: the erasure ledger kept outside backups; import after a restore re-applies erasures |

Escalation of overdue / stale items: `node platform/cli/escalate.ts` (schema owner, run by a
scheduler; none is bundled). Audit: [`../audit/2026-11-10-feedback-review.md`](../audit/2026-11-10-feedback-review.md).

### Local demo (hackathon only)

`platform/cli/seed-modus-demo.ts` creates the fictional organization «Модус Трейд — демо» (invented
people, 15 items in every status) and writes `.demo/personas.json`. With
`MODUS_AUTH_MODE=dev-token MODUS_DEMO_LOGIN=true` the API offers `GET /api/v1/demo/personas` and
`POST /api/v1/demo/login {userId}` — an **imitation of SSO** for the demo; refused at startup in
production or with OIDC. `MODUS_SERVE_WEB=true` (or `MODUS_WEB_DIR`) serves the built web app from the
same origin with a strict CSP.

## Planned (next phases)

* **Phase 2 (done):** see `PHASE2-WORKFLOW.md`. Still open: impact verification and contribution
  confirmation endpoints.
* **Phase 3:** React + TypeScript PWA (Quiet Intelligence tokens, mobile chat-first capture, desktop
  workspace, PR-like idea page) over API v1.
* Employee Contribution Profile and Honor Board as read models over confirmed contributions
  (categories, links to evidence, no counts-based ranking).
* SSO/OIDC, rate limiting, outbox delivery to e-mail/messengers, backups/restore rehearsal.

## 3D-город и импорт набора (ADR-0026, миграция 0017)

- **Сцена.** `web/src/world3d/` — Three.js без обёрток: процедурные материалы и геометрия, пять наборов архитектуры × пять уровней (пятый — Русское царство, ADR-0029), рельеф с рекой и мостами, камера с пределами и перелётами, выбор объектов лучом. Данные — только `GET /kingdom`; движок не вызывает API и не знает о правах.
- **Экраны.** `screens/City3D.tsx` — сцена с тёмным HUD (разделы, поиск по отделам, коллегам, обращениям и строкам набора, счётчики, карточка района); `components/Citadel3D.tsx` — замок отдела в 3D и подписанный предпросмотр уровней на экране района. Виды страницы «Город»: 3D / Схема / Рабочее пространство; без WebGL — схема.
- **Новые маршруты.** `GET /people?q=` (поиск коллег: имя, должность, отдел; только участникам), `GET /datasets/:dataset`, `GET /ideas/:n/dataset`.
- **Импорт.** `platform/modules/dataset.ts` + `npm run platform:import-dataset`: 20 строк официального набора проходят обычную подачу, маршрутизацию и решения; `dataset_items` хранит внешний ID и исходные поля; XP из набора не начисляется, демо-подтверждение — отдельный подписанный шаг.
- **Ограничения** перечислены в ADR-0026: визуальный уровень ниже живописного референса; кадры измерены на одной видеокарте (Apple M5, см. ADR-0026), на телефоне и слабых видеокартах — нет.

## Карточки гонцов, «Отложить решение», «Оценка ИИ» (ADR-0027, миграция 0018)

- `POST /ideas/:n/defer` `{until, reason}` и `POST /ideas/:n/resume` — только ответственный за решение; срок решения на паузе (`idea_deferrals`, `app_defer_idea`, `app_resume_idea`); событие уведомления `idea_deferred`.
- `POST /ideas/:n/assessment` — ответ локальной модели или «ИИ не подключён»; не сохраняется.
- `GET /ideas/:n` отдаёт `deferral`; `GET /kingdom` у гонцов — `author` и `deferredUntil`.
- Веб: `components/ItemQuick.tsx` (путь в четыре шага, отложить, оценка ИИ) — на странице обращения и в карточке гонца в 3D-городе.

## Облачная модель и AI-Архивариус (ADR-0028)

- `MODUS_ADVISOR_PROVIDER=none|ollama|anthropic|openai`; облачная — только с `MODUS_ADVISOR_ALLOW_REMOTE=true`, вне демо ещё и `MODUS_ADVISOR_ALLOW_REAL_DATA=true`. Ключ — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.
- `platform/modules/advisor-model.ts`: `modelFetch` — один переходник для всех провайдеров; `isRemote`, `modelLabel`.
- `POST /knowledge/:id/helper/ai` — AI-Архивариус; `GET /advisor/status` отдаёт `model.remote`.

## Город отдела в 3D и сведение веток (ADR-0029)

- **Два вида города.** Вкладка «Город» района: «Панорама» (иллюстрация, `components/CityPanorama.tsx`) и «3D» (`components/Citadel3D.tsx` с параметром `town`). Список зданий общий — `components/town.ts`; каждое здание — ссылка на существующий раздел. Выбор вида — `localStorage 'modus.town.view'`.
- **Метки.** Набор архитектуры помечает здания разделов (`Builder.mark` в `world3d/geo.ts`); `KitView.setPins` ставит метку над крышей, для непостроенных зданий берёт самые заметные свободные крыши; `KitView.look` поворачивает камеру к зданию.
- **Запасной вид.** Без WebGL и в облегчённом режиме — список зданий с объяснением.
- **Миграции.** Номера 0017 и 0018 встречаются дважды (`dataset_import` и `royal_audiences`, `deferral` и `russian_tsardom`); файлы независимы и учитываются по имени и контрольной сумме, переименовывать применённые нельзя.
- **Статика.** `platform/http/static.ts` отдаёт `.webp` и `.jpg` с правильным типом (панорама Камелота — WebP).

## Контекст проекта и измеренный эффект (ADR-0031, миграция 0019)

- **Таблицы.** `idea_contexts` (проект или объект, этап работы; одна запись на обращение, только добавление) и `idea_affected_departments` (затронутые подразделения отдельно от `ideas.department_id`; только добавление). Четыре необязательных столбца в `verification_evidence`: `period`, `source`, `goal`, `comparable`.
- **Маршруты.** `POST /ideas` принимает необязательный `context`; `POST /ideas/:n/context` (один раз), `POST /ideas/:n/affected-departments`, `GET /ideas/:n/specialists`, `POST /ideas/:n/impact-verifications`. `GET /ideas/:n` возвращает `context` и `effect`.
- **Правила эффекта.** `platform/domain/effect.ts`: пара «до/после» по одной метрике; без пары — не измерено; разные единицы или нет отметки сопоставимости — без разницы и процента; метрики не складываются.
- **Права не менялись.** Измерение запускает ведущий, бонус за эффект подтверждает ответственный за решение, записи в Летопись вносит Архивариус или руководитель.
- **Интерфейс.** `web/src/components/ProjectContext.tsx` — блок «Связать с проектом», панель контекста (карточка и Совет), панель «Измеренный эффект».
- **Демо.** `docs/demo/refinement-demo.md`, `npm run demo:refinement`.
