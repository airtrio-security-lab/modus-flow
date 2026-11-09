# ADR-0006 · Lifecycle stage vs. process state; merge is not proof

**Decision.** `ideas.stage` only records *where* the idea is (published, review, development,
verification, decision, adoption, impact_verification, closed). Each process keeps its own state in
its own table: change requests (open/resolved), verification runs (planned/running/completed with
outcome positive/negative/inconclusive), decisions (merge/reject/close with rationale), impact
verification (a verification with purpose `impact`). A `merge` decision records the decision to adopt;
proven usefulness exists only as a completed `impact` verification with evidence and a reviewer.
Negative and inconclusive results are first-class, immutable outcomes.

**Consequences.** + No status that silently means two things. + "Not proven" is representable.
− The UI must compose the picture from several records (the idea page does exactly that).
