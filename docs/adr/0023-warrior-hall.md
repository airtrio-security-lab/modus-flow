# ADR-0023 · Зал воинов: личные мысли и реальные обсуждения

Status: working UI on an isolated branch; not merged or field-tested.

The Hall is a district entry point for ideas. It does not change who can decide, grant extra permissions, award XP or create an independent voting mechanism.

- Private thoughts use the existing Personal Lab (lab_drafts / lab_draft_versions). Owner-only RLS, version history, conflict checking and idempotent publication remain enforced on the server.
- All private idea drafts of the viewer appear in the Hall, independent of their organization; this is explicitly indicated in the UI. A draft becomes associated with a department only when the user explicitly publishes it to that department.
- Save may contain a title and private notes alone. Publishing requires title, observation (20+ characters) and proposal (20+ characters), all saved on the current version.
- Publishing uses the existing Lab publish endpoint with an explicit organization and department. A successful request creates a normal numbered item, revision, authorship contribution, audit entry and appropriate notifications.
- Personal notes are NOT included in the published snapshot. Only title, observation and proposal are published from this Hall.
- Discussion itself happens through the existing item and Council workflows. The Hall lists already visible Council items from the department endpoint.
- The Hall tab is functional now; an image-backed town building hotspot and panoramic city art are separate follow-up presentation work.

Verification before merge:
1. Private drafts invisible to other users, retrievable after restart.
2. Concurrent edit returns conflict without overwriting another version.
3. Publishing creates one authored item for the current department without leaking private notes.
4. Retrying does not duplicate the published item or XP.
5. Council discussions and formal decisions retain their existing server permissions.
6. Check keyboard, mobile, light mode and reduced-motion behavior.
