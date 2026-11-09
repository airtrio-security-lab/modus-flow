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

**Consequences.** In very small organizations a leader cannot merge their own idea; another decision
owner must be assigned. **Owner may revise** this rule (it affects people's rights) — it is
centralized in one function so a change is local.
