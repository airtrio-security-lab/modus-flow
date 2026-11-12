# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-evolve-alongside-prototype.md) | Build the platform alongside the prototype; base on `main`, not on the PR stack | Accepted |
| [0002](0002-postgresql-rls-tenant-isolation.md) | PostgreSQL with RLS and composite foreign keys for tenant isolation | Accepted |
| [0003](0003-personal-lab-and-publication.md) | Personal Lab is user-owned; publication is an explicit three-field snapshot | Accepted |
| [0004](0004-interim-authentication.md) | Interim signed tokens until SSO; no demo tokens | Accepted |
| [0005](0005-typescript-without-build.md) | TypeScript via Node type stripping; zod at the boundary | Accepted |
| [0006](0006-lifecycle-separate-from-subprocess-state.md) | Lifecycle stage is separate from review/verification/decision state; merge ≠ proven impact | Accepted |
| [0007](0007-authorship-and-conflict-of-interest.md) | Authorship, right of reply and conflict-of-interest rules | Accepted — confirmed by owner 2026-11-09 |
| [0008](0008-notifications.md) | Targeted notifications without free-text payload | Accepted |
| [0009](0009-authentication-boundary-oidc.md) | Authentication boundary; OIDC planned; dev tokens never production | Accepted (owner decision) |
| [0010](0010-workflow-invariants.md) | Workflow invariants in the database; invited independent reviewers; truthful chronology | Accepted |
| [0011](0011-kingdom-map.md) | «Королевство»: department castles grow only from implemented items; no personal scores | Accepted (owner decision 2026-11-11) |
| [0012](0012-castle-progress-and-council.md) | Castle XP and levels only from confirmed events; department rating; the Council advises, the decision owner decides | Accepted (owner brief 2026-11-11) |
| [0016](0016-royal-messages.md) | «Королевские послания»: address by title and own choice, business text always, council invitations with facts and actions, reschedule/cancel, mandatory messages, on the existing notification mechanism | Accepted (owner brief 2026-11-11) |
| [0015](0015-meeting-governance.md) | Personal consent or a written protocol; retention 30/90 days per organization; admin-only purge with reason; legal hold; immutable log; re-purge after restore | Accepted (owner decisions 2026-11-11) |
| [0014](0014-living-kingdom-meetings.md) | Game titles separate from rights; council meetings with personal consent, recording, labelled transcripts, findings with evidence confirmed by a person; local engines only | Accepted (owner master prompt 2026-11-11) |
| [0013](0013-modus-advisor-minimal.md) | MODUS ADVISOR: protocol → candidates with exact quotes → human confirmation; executor suggestions from questionnaires; rules labelled «без ИИ», optional local model only | Accepted (owner brief 2026-11-11) |
| [0017](0017-legacy-knowledge.md) | «Наследие Королевства»: one knowledge model in three halls (Летопись, Библиотека решений, Высший Архив) with provenance, versions and transitions; the archivist role curates and opens nothing; manual, two-person transitions; no transcript copies; helper without AI | Accepted (owner brief 2026-11-11) |
| [0018](0018-knowledge-personal-data.md) | Personal data in knowledge: pattern checks at any length on every write and before opening; admin-only erasure and pseudonymization with a legal basis; content-free log; legal hold; re-applied after restore and from an external ledger | Accepted (owner brief 2026-11-11) |
| [0019](0019-living-city.md) | «Живое Королевство»: SVG city with a viewBox camera (measured, no PixiJS); district screen over existing facts; four equal architectural styles chosen by the head or admin, logged, no rights; staff groups from roles and confirmed results; skills to self and leads, preferences to self only; «Нет данных» instead of 0 | Accepted (owner master prompt 2026-11-11) |
| [0020](0020-civilizations-councils.md) | Civilizations & councils: a registry of styles, halls, titles and invitation words; titles from functions and personal choices, never rights; Камелот as a full civilization; small councils and one Great Round Table with a once-only, reasoned hand-over by those with authority; agenda; scenes | Accepted (owner brief 2026-11-11) |
| [0021](0021-commonwealth-model.md) | Game world model: one organization = one configurable commonwealth («Великое Содружество»); departments are districts that choose civilizations (styles, not tenants); the Great Round Table belongs to the whole commonwealth; real company name kept for administration | Accepted (owner clarification 2026-11-11) |
| [0022](0022-royal-audience-shortcut.md) | Королевская аудиенция: короткий путь обращения к Королю поверх существующих маршрутов | Draft (owner branch) |
| [0023](0023-warrior-hall.md) | «Зал воинов»: личные мысли и заметки района | Draft (owner branch) |
| [0024](0024-interactive-city.md) | Нарисованная панорама города отдела с восемью зданиями-ссылками (Камелот) | Prototype (owner branch) |
| [0025](0025-russian-tsardom.md) | Русское царство — пятая цивилизация: звания, Боярская дума, панорама, миграция 0018 | Draft (owner branch) |
| [0026](0026-world3d.md) | 3D-город на Three.js из данных `GET /kingdom`, цитадель отдела, импорт набора организатора, запасная схема | Accepted (owner brief 2026-11-12) |
| [0027](0027-envoy-cards-defer-ai.md) | Карточки над гонцами, «Отложить решение» со сроком на паузе, «Оценка ИИ» только от подключённой модели | Accepted (owner decisions 2026-11-12) |
| [0028](0028-cloud-model.md) | Облачная языковая модель за явным согласием, AI-Архивариус; ключ только из окружения | Accepted (owner decision 2026-11-12) |
| [0029](0029-town3d.md) | Город отдела в 3D как второй вид панорамы, Русское царство в 3D, сведение веток, двойные номера миграций | Accepted (owner request 2026-11-12) |
| [0030](0030-response-layer-diagnostics.md) | Отклик 3D-города: движение только на реальные изменения данных, всегда кончается в покое, выключено при «уменьшить движение»; память прошлого визита на устройстве; диагностика на устройстве с бюджетом отрисовки; правила для Claude по путям и ворота показа | Accepted (owner request 2026-11-12) |
| [0031](0031-project-context-effect.md) | От инициативы к измеримому результату: контекст проекта, затронутые подразделения отдельно от ответственного, измеренный эффект на существующих доказательствах, предложение в Библиотеку | Draft PR (owner brief 2026-11-12) |
