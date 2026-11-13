# Decision & Impact Timeline — product and data contract (design only)

Linked issue: [#10](https://github.com/airtrio-security-lab/modus-flow/issues/10). ADR: [0045](../adr/0045-historical-fairness-sustained-impact.md). No production implementation in this PR.

## Domain entities and event semantics

| Entity | Core fields / constraints | Purpose |
|---|---|---|
| DecisionRound | id, organization_id, idea_id, round_number, previous_round_id, reopened_reason, opened_at, closed_at; unique (idea_id, round_number) | Reconsider an idea without erasing a rejected/merged decision; authorized start only |
| DecisionEvent | round_id, idea_revision_id, outcome, rationale, decider, evidence_snapshot_id, effective_at, recorded_at; one terminal outcome per round | Historic decision and what was known when it was made |
| RecognitionEvent | recognition_id, subject_membership_id, contribution_ids, event_type (granted/corrected/revoked), criteria_version, evidence_snapshot, independent_decider, reason, effective_at, recorded_at | Preserve both award and later audit-preserving correction |
| AdoptionEpisode | id, organization_id, idea_id, decision_round_id, deployment_scope, site/department, start/end, status (active/paused/rolled_back/superseded), implemented_by, causal_link | One real deployment, possibly one of many for the same idea |
| ImpactObservation | id, episode_id, metric, direction (benefit/harm), unit, period_start/end, baseline, observed, method, volume, costs, sample/coverage, confidence, evidence_refs, verification_status, verified_by, effective_at, recorded_at | Independent field measurements, not predictions |
| ImpactCorrection | original_observation_id, replacement_observation_id, actor, reason, recorded_at | Preserve earlier report while correcting an error |
| AttributionLink | contribution_id, idea_revision_id, deployment_id, evidence_refs, type (original/contributor/implementer/reviewer/verifier), verified_by | Traceable credit without exclusive-owner shortcuts |

**Storage note:** identifiers, timestamp types, privacy and access must follow existing Phase 2 conventions. This table is a logical target, not a ready-to-run migration. `recorded_at` is system assigned; users may supply an `effective_at` claim but backdating is audited and requires verification. Cross-tenant references prohibited at DB level.

## Read model / Employee Profile

Each profile shows linked, dated cards:
- **Original proposal** — who proposed it, when, original version.
- **Decision at the time** — accept/reject/close, contemporaneous rationale, evidence snapshot and who decided.
- **Later reconsideration** — why conditions changed, which version is under review and the separate decision round.
- **Actual deployments** — site and operating status, with start/stop and rollback reasons.
- **Impact** — benefits and harms, distinct units, measured windows, verification badges, provenance and confidence.
- **Award history** — recognition date and basis, later correction/revocation linked separately. Historical award remains visible.
- **Contributors** — original author, subsequent improvers, implementers and people who found errors; only proven causal links count.

Default page emphasizes verifiable work and readable chronology. A neutral “not measured” is preferable to estimated ROI. Provide two views: chronological decisions and longitudinal outcomes. Allow “as known at [date]” to avoid hindsight bias.

## Aggregation algorithm contract

For each metric and additive unit **within a disjoint measurement coverage set**, include only independently verified observations in the permitted date range. Deduplicate source evidence and deployment identity. Where windows overlap, return `aggregation_blocked: overlapping_coverage` or show per-window results pending adjudication; do not silently add. Convert units only using an explicit trusted transform. Keep benefit and harm separate. An inactive period is not a positive measurement. Revisions/corrections contribute only their currently accepted observation, but all versions remain visible in history. A later award is not proof of prior realized impact.

## Governance edge cases

- A director's award is not self-approved; guest reviewers must be independently identified and scoped.
- Historic awards are not automatically “taken back” merely because a solution later became obsolete.
- Proven falsification can trigger an independent, traceable correction process; historic event remains visible.
- An implementation can improve Site A and harm Site B simultaneously.
- Rollback costs and unintended negative effects are recorded in the same evidence architecture, without netting away harm.
- Exported profiles respect confidentiality, personal data rules, organizational contracts and employee status.

## Out of scope

No AI-generated “verified impact,” leaderboard scoring, automatic financial bonuses, reward clawback, cross-organization publication, data migrations or changing currently open PR #8/#9. Define retention, appeal rights and reward policies with the pilot organization before production.
