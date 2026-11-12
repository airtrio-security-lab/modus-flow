# ADR-0007 · Authorship, right of reply, conflict of interest

**Decision** (encoded in `platform/domain/policy.ts` and, where possible, in the schema):
* Only the author changes the idea's text. Others submit **suggested revisions** with their own
  authorship and rationale; only the author accepts or declines them. Revision content is immutable.
* Change requests come from the idea's maintainer/decision owner (or any org maintainer before
  assignment). The author may file an **objection** to any change request.
* Nobody decides on their own idea, starts/concludes verification of their own idea, or confirms their
  own contribution (the last is a database CHECK).
* `org_admin` administers; it grants no review or decision power and no access to Lab content.
* Completed verifications and decisions cannot be edited or deleted, so negative results cannot be
  hidden.

**Owner decision (2026-11-09): confirmed.** For small teams an independent decision owner (or
maintainer) may be an **invited guest** — a membership with `access = 'guest'` and only the
`maintainer` and/or `decision_owner` roles. Guests see only the ideas they are assigned to, cannot
publish, assign or join organization-wide triage (enforced by RLS, migration 0002; see ADR-0010).

**Consequences.** A leader never merges their own idea; another decision owner — internal or invited —
must be assigned. Since Phase 2 these rules are enforced by the database as well as the service.
