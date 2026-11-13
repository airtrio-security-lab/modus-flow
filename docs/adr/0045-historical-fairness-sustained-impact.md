# ADR-0045 — Историческая справедливость и устойчивость вклада

**Status:** Proposed for product approval, 2026-11-09.  
**Scope:** Decision & Impact Timeline, Employee Profile, Honor Board.  
**Backlog:** [Issue #10](https://github.com/airtrio-security-lab/modus-flow/issues/10).  
**Происхождение:** черновик PR #11 (`feat/decision-impact-timeline-spec`, 2026-11-09), где он назывался ADR-0011; номер 0011 в `main` занят «Королевством», поэтому перенесён 2026-11-13 под номером 0045 без изменений по существу. Решение владельца ещё не принято.  
**Связь:** ADR-0031 уже хранит измеренный эффект на доказательствах (период, источник, цель, сопоставимость) — это часть «Measurement boundaries» ниже; остальное (две оси времени, события наград, раунды решения) не реализовано.

## Problem

An initially small improvement may deliver modest but verified benefit repeatedly over years. An ambitious structural change may earn a legitimate award when launched, then be rolled back after its costs or harm become apparent. A rejected idea may later succeed when technology, prices or audience change, just as some films initially underperformed in theaters but gained enduring recognition in the home-video era.

If we only store a current status, an early award, or a single cumulative score, we misrepresent the employee's contribution. We must distinguish **what was known and decided then**, **what actually happened later**, and **where an idea is useful now**.

## Decision

### Three independent truths

1. **Historical decision and recognition.** A decision and award record what was justified by evidence **available at that time**. Retain original rationale, decision maker, evidence snapshot, decision date, award criteria, recipients and contributor roles. Never overwrite a previous judgment with current knowledge. A later correction or revocation is a **new, linked event** with reason, authority and evidence; it does not erase the original award. A later rollback **does not automatically revoke** a valid historical award.
2. **Realized impact across time.** Benefits and harms are recorded separately for distinct adoption episodes, locations, operational periods and measured units. A small verified improvement may accumulate benefit for years; a stopped implementation must not accrue imagined future benefit. Include cost of implementation, maintenance and rollback where known. No artificial accumulation based solely on time elapsed.
3. **Current applicability.** A solution can be active, paused, superseded, rolled back or conditionally applicable in different contexts simultaneously. Current state does not rewrite its earlier value.

### Replay and temporal integrity

Each fact has **effective_at** (when the action or observation happened) and **recorded_at** (when the system learned of it), plus the actor and immutable provenance. The UI must support both “as known on date X” and “what we know today about date X.” Later-discovered evidence must not appear in an earlier decision's evidence snapshot.

Records and evidence are append-only. Corrections reference the original record rather than modifying or deleting it. Visibility follows organization scopes and confidentiality policy.

### Recognition and attribution

Keep **original authorship**, later revision authors, reviewers, implementers and field verifiers distinguishable. Subsequent usefulness may create **retrospective recognition** only on a documented causal link to the original contribution, not name similarity, citation or popularity. Verify conflicts of interest independently; the author cannot self-confirm impact. A person's departure from the organization does not erase historic authorship, while tenant/private Lab isolation still applies.

Awards are event-sourced: `granted`, `corrected`, `revoked_for_invalid_evidence` with rationale, evidence and independent decision. A valid award remains a historical fact even if the implementation later ceases to be useful. Financial clawback, if any, requires separate human policy and is **not** automatic.

### Measurement boundaries

- Store baseline, observed value, window, site, unit, methodology, sample size, operating context, confidence, measurement coverage, evidence references, independent verifier, recording date.
- Do not compare or sum incompatible metrics (minutes, tenge, safety incidents, satisfaction). Never collapse benefit and harm into one unqualified score.
- Avoid double-counting overlapping periods, duplicated deployments, repeated reports, or attribution across authors and implementers.
- Distinguish measured, independently verified, disputed, inconclusive and not measured. An award based on projections must not be labeled “verified actual impact.”
- For regular small savings, show cumulative totals **only for covered, non-overlapping verified intervals** using a declared additive metric and actual activity volume. Otherwise show a series of observations with uncertainty.
- The Honor Board displays the basis and time window of recognition, not just a timeless “top employee” label.

## Decision rounds

Phase 2's `decisions_one_per_idea` index guarantees one final decision per idea. Do **not** remove it ad hoc. A future migration introduces an authorized `decision_round` / `reconsideration` entity with one final decision per round, reason for reopening, reference to prior round and immutable original decisions. Reopening must never bypass independent decision ownership and verification gates.

## Trade-offs and next steps

Additional event and read models increase complexity and require careful privacy/retention controls. Postpone any universal lifetime score or monetary reward formula until empirical calibration. Implement independently from active Phase 1/2 PRs after CI verification and schema review. This ADR does **not** authorize a database migration or merge.

**Core principle:** “Награда отражает доказательства своего времени. Долгосрочная ценность определяется последующими результатами. Одно не должно стирать другое.”

## Ограничения (не скрываются)

- Только спецификация: кода, миграций и тестов нет; ничего не проверено на данных.
- Статус Proposed — решение владельца не принято; до него ADR не меняет поведение системы.
- Текст 2026-11-09 написан до ADR-0012–0044; совместимость с ними (XP, «Путь Посла», Высший Архив) не сверялась построчно.
