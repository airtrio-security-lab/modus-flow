# ADR-0022 · Королевская аудиенция посла — Shogun-style shortcut

**Status:** proposal implemented on an isolated feature branch, not merged or field-tested.
**Owner intent (2026-11-11):** an employee sends a messenger requesting an audience; the King sees the incoming envoy; once the King accepts, the sender sees a short cinematic scene; the King can then choose to review the item, record an implementation decision, or call a Council.

## Service first

A messenger is a **visual interpretation of a registered employee issue**. Sending one is opt-in and never bypasses the ordinary route or deadlines. It is **not** an extra submission, vote, approval, assignment, score, meeting, or shortcut through the organization's checks.

One organization = one Great Commonwealth. Only the member actually assigned the game title `king` is the receiver. The title itself does **not** create HR, workflow, or database privileges.

## Flow

```text
Employee publishes an issue → optional "Send envoy to King"
                ↓
royal_audiences: requested (one row per originator + issue)
                ↓
King receives "К вам направили посла с просьбой об аудиенции"
                ↓
King clicks "Принять посла"
                ↓
PostgreSQL: accepted_at, accepted_by, immutable audit record
                ↓
Sender receives: "Король принял вашего посла"
                ↓
Short original faceless animated cutscene / can be skipped
                ↓
King selects one of the existing authorized pathways:
    - "Вынести на рассмотрение" → Council discussion screen
    - "Внедрить — оформить решение" → normal decision form
      (ONLY if actor really is decision owner; mandatory reason/checks)
    - "Созвать Совет" → normal meeting creation form
      (participants, consent, agenda and actual permissions required)
```

### Explicit limitations

* "Accept envoy" **only confirms reception**, not a formal decision or the promise of implementation.
* The cinematic scene is an **original 5.7-second in-browser SVG/CSS animation**, not an MP4 file or actual 3D game footage. No recognizable faces are used. It can later be replaced with licensed 3D-rendered video while retaining the same server events.
* The three buttons are **links into verified workflows**, not shortcuts around decision gates. The meeting is only "convened" after the existing form succeeds.
* Existing inbox notifications remain unchanged; a new separate Audience panel lists only the sender's and King's requests. A dedicated bell counter includes the pending royal request and sender's unseen receipt.
* One audience request per idea and originator, no resend flood; a title transfer does **not** silently redirect older requests. Reassignment/reissue would be a separate, audited workflow.

## API

* `GET /api/v1/orgs/:org/audiences` → `{king, items}`, scoped to participant + organization RLS.
* `POST /api/v1/orgs/:org/ideas/:number/audience` body `{}` → `{id, accepted, replayed}`.
* `POST /api/v1/orgs/:org/audiences/:id/accept` body `{}` → `{id, acceptedAt, replayed}`.

Server verifies active member, originator, assigned King, idea visibility, open stage, and action identity. DB `royal_audiences` enforces participant RLS; only the recipient may mark accepted, and the guard stamps real acceptance time. `UNIQUE(idea_id, requester_membership_id)` and a row lock prevent duplicates and concurrent acceptances. Audit events are `royal_audience.requested` and `royal_audience.accepted`.

## Tests and acceptance

Run `npm run verify` with PostgreSQL 16, plus `node --test test/platform/royal-audience.test.ts`; use demo personas to inspect `#/items/:number` and `#/inbox` at desktop and mobile widths. Prove:
- no other member, guest, or tenant can send, view, or accept;
- duplicate requests and repeated acceptance are harmless;
- the acceptedAt timestamp comes from the database;
- no decision, XP, meeting or stage change occurs from audience acceptance;
- title transfer cannot grant new powers to the former king;
- accepted senders see only their own message;
- video scene is skippable, obeys reduced motion, shows **only faceless silhouettes**, with explanatory business text;
- only the genuine decision owner sees the implementation shortcut.

GitHub Actions are known to be blocked by billing; **do not claim green CI or verified mobile GPU performance** without running actual checks.
