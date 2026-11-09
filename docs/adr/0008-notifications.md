# ADR-0008 · Notifications

**Decision.** Notifications are rows with recipient, actor, event type, idea and a dedupe key — no
free text. Messages ("Кирилл Демо предлагает на обсуждение новую идею «…»") are rendered at read time
from organization-visible data. Recipients are chosen by the workflow (e.g. new idea → members with
maintainer/decision_owner roles), never "everyone"; the actor is never notified; per-event and per-idea
subscriptions are honoured; retries do not duplicate.

**Consequences.** + Private drafts cannot leak through notifications; no mass mailing.
− External delivery (e-mail, messengers) needs an outbox consumer (planned), with digesting.
