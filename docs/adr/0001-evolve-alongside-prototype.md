# ADR-0001 · Build the platform alongside the prototype

**Context.** `main` holds an in-memory demo; PRs #3–#7 add features on a JSON file store. CI never ran
(billing), the stack contains a lost-update defect, and merging #3 would revert the approved concept
document (audit P0-1…3). The target needs tenancy, relational integrity and audit — none of which can
be retrofitted into a single JSON document without rewriting it anyway.

**Decision.** Add a new `platform/` application next to the prototype, branched from `main`.
Do not modify, delete or merge the prototype or the PR stack. Reuse its domain knowledge explicitly:
the six guided-reflection steps, "private by default", blocking change requests, evidence-based
contributions.

**Consequences.** + No regressions in the demo; both run side by side (ports 3000/3100).
+ The PR stack stays reviewable as UX reference. − Two code paths until the Phase 3 UI moves over;
the prototype is retired then by an explicit, separate PR. JSON-state import is not provided: that
format exists only in unmerged PR #6 and contains demo data only.
