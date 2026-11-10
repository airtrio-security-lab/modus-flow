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
| `#/meeting` Разбор совещания | everyone | Owner's pain «идеи теряются в WhatsApp, на совещаниях, в почте»: all questions from one meeting, chat or e-mail at once; each becomes its own item with its own raiser, topic, owner and deadline; source note «встреча, дата». Each row has its own Idempotency-Key, so a retry never duplicates and one failure does not lose the others |
| `/share?text=…` | Android | PWA share target: «Поделиться» from WhatsApp → the submission form opens with the message text, source «Мессенджер», «записываю со слов коллеги» preset. iOS does not support share targets for web apps: copy and paste there |
| `#/items/:n` Обращение | everyone | Title, status, five-stop signal line (registration → review → decision → implementation → result), what happens now and who is next, the current text, contextual actions, full history, passport (people, source, deadlines, credit, files) |
| `#/work` Рабочее место | maintainers, decision owners | Queues: assigned to me, without an owner, overdue, no movement |
| `#/all` Все обращения | everyone | Russian full-text search and filters (status, topic, department, source) |
| `#/overview` Обзор | leads, admins | One-sentence verdict of what needs attention; totals; needs-attention list; recurring questions; sources; by department and topic |
| `#/inbox` Уведомления | everyone | Only items the person takes part in (enforced by `app_notify`) |
| `#/settings` Настройки | org admins | Deadlines and escalation contact; routing rules; topics; departments (switched off, never deleted) |

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

## Checks

* `npm --prefix web run build` — TypeScript (strict) + production build.
* `npm run demo:e2e` — Playwright drives the real UI against the seeded demo: submit → question to the
  author → new version → question closed → decision with implementer → progress → implemented → the
  author sees the result; a phone question recorded on behalf of an engineer; a meeting review with two
  questions from different people; a WhatsApp message shared into the form; Kanban take-over by drag and drop and an explained forbidden move;
  owner overview. Needs
  Playwright installed locally; it is not in CI yet.

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
