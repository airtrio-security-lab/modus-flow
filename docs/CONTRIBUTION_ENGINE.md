# MODUS FLOW — Contribution Engine
Version: Concept v1.0 · 9 November 2026
Status: Approved product direction; implementation pending

## Mission
Make every employee improvement visible, attributable, reusable, and verifiable over time. A small contribution deserves a durable record even when its impact emerges years later.

**Core promise:** "You can see what your idea changed, where it was used, who built on it, and what evidence supports its impact."

## Scope and hackathon compliance
The mandatory employee-feedback workflow remains the foundation: submit feedback, review and assign it, track status, communicate decisions, and provide management oversight. The Contribution Engine extends this workflow; it does not replace it.

## Product principles
1. Evidence over points: views, votes, approvals, deployments, and actual uses are distinct events.
2. Attribution survives role changes and employee departure, subject to retention and privacy law.
3. Credit follows documented causal relationships, not mere references or popularity.
4. Original contributors and subsequent implementers receive distinct recognition.
5. Rejection does not erase the idea or the employee's participation; harmful outcomes are not concealed.
6. No compulsory public leaderboard. Default private; optional employee-controlled publication of approved achievements.
7. AI suggests classification and possible links, but never autonomously awards credit, reveals confidential submissions, or certifies impact.
8. Monetary rewards are not assumed. Recognition is meaningful without fabricated financial savings.

## Core objects
- **FeedbackRequest**: problem, idea or suggestion, with owner, visibility, category, status and accountable reviewer.
- **Contribution**: stable identifier, author(s), type (idea, analysis, implementation, validation, improvement), version, provenance and evidence.
- **ContributionLink**: typed causal relationship (derived_from, improves, implements, validates), review status and justification.
- **Adoption**: organizational unit, decision, deployment date, reviewer and documentary proof.
- **UsageEvent**: unique source event, time, unit, contribution version, evidence and verification state. Repeated ingestion is idempotent.
- **ImpactEvidence**: metric, baseline, observed value, period, units, method, reviewer and confidence/limitations.
- **Recognition**: transparent achievement linked to verified events; revocable with audit trail.
- **AuditEvent**: append-only history of actors, decisions, changes and access-sensitive actions.

## Primary workflows
### A. Employee submits
1. Employee sends problem/idea, optional supporting evidence, selects visibility.
2. System creates request and contribution draft with permanent IDs.
3. Reviewer checks duplicates, confidentiality, department and priority; AI may propose but cannot finalize.
4. Employee tracks progress and receives explanations.

### B. From idea to use
1. Authorized reviewer accepts idea for trial; responsible owner and deadline assigned.
2. Implementer registers an implementation contribution linked to the originating idea.
3. Adoption is approved for a specific team/site and linked to evidence.
4. Actual usage events arrive via validated integration or reviewed manual evidence.
5. Dashboard distinguishes confirmed uses, deployments and estimated impact.
6. Employee receives an update on verified adoption and subsequent improvements.

### C. Attribution and disputes
1. Every link specifies *why* the downstream work depends on the prior contribution.
2. Multiple authors and independent discoveries are supported.
3. Credit cannot be reassigned or removed without a recorded reason and review.
4. Disputed attribution is flagged; unverified downstream usage is not counted as proven impact.
5. Review and appeal remain available to affected employees.

## Lifecycle
Feedback: submitted → in_review → in_progress → awaiting_verification → resolved/closed; rejected or reopened with reason. Only authorized reviewers can finalize. Contribution: proposed → evaluated → trial → adopted → active → superseded/retired; evidence quality tracked separately.

## Employee experience
- My contributions: authored, implemented, verified, adopted, reused, derived.
- Contribution passport: provenance graph, event timeline, confirmed use count, deployment locations, verified impact, collaborators, limitations.
- Recognition: private achievements and optionally public, approved accomplishments.
- Notifications: accepted, adopted, reused, improved, disputed, retired.
- Exportable personal history with confidentiality controls.

## Manager experience
Queue, assignments, SLA, verification, organizational adoption, evidence review, duplicate handling, impact reports. No public shaming or employee ranking by raw counts.

## Metric integrity
- Count unique confirmed usage events, not page views or button clicks.
- Separate actual uses from projected/estimated uses and confirmed impact from estimates.
- Record event source, idempotency key, verifier, and relevant period.
- Reject unverifiable claims and detect duplicate submissions.
- Audit corrections instead of silently overwriting history.

## Privacy and security
Tenant isolation, department-scoped authorization, restricted confidential submissions, encryption, retention and deletion policies, export review, employee-controlled publication, consent where required, anti-retaliation procedures. Admin role does not automatically grant access to confidential content.

## Technical direction
React/TypeScript UI; PostgreSQL transactions and migrations; server-side policy checks; append-only audit/event records; transactional outbox for notifications; optional AI suggestion service. Do not build a blockchain or introduce financial reward ledgers for the MVP.

## MVP acceptance for 14 November
1. Real login and scoped roles; no demo bearer tokens in production.
2. Submit and process feedback end-to-end with reviewer and resolution reason.
3. Create contribution passport for an accepted idea.
4. Register one verified adoption with linked proof.
5. Register idempotent usage events and display confirmed use count.
6. Link an implementation to its source idea and preserve both authors' contributions.
7. Show private employee history and optional, explicitly approved public recognition.
8. Enforce authorization, maintain durable audit records and PostgreSQL persistence.
9. Pass automated tests, backup/restore rehearsal and security gate.

**Demo narrative:** an employee proposes a small warehouse improvement → manager reviews → colleague implements → site adopts → independently confirmed usage increments → employee sees ongoing contribution.

## Deferred
Complex scoring, company-wide leaderboards, financial rewards, automated ROI attribution, advanced AI graph inference, external credential issuance, organization-wide integrations.

## Current implementation status
The main branch currently contains only an in-memory demo for feedback requests and basic status transitions. This document is a specification, not a claim that the Contribution Engine is implemented.
