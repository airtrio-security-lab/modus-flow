# MODUS FLOW · Contribution Engine v0.2
## Approved concept
An open, authenticated employee achievements directory. Every contribution has stable authorship and traceable verified adoption and usage. No monetary reward or arbitrary points are required. Submission and case management remain core features.
## Entities
Request → Contribution → Adoption (scope + evidence + manager verification) → Usage (adoption + external event ID + evidence + manager verification).
Counts distinguish adoption from repeated actual use. Deduplicate usage by adoption and external event ID. Attribution of derived ideas and measurable impact are future milestones, not inferred automatically.
## Demo API
GET /api/contributions; POST /api/contributions {requestId}; POST /api/contributions/:id/adoptions {scope,evidence}; POST /api/contributions/:id/usage {adoptionId,externalId,evidence}. All endpoints require demo bearer authentication; certification requires manager/admin.
## Privacy and integrity
Open achievements do not imply public exposure of confidential complaints, private employee data or raw evidence. Current implementation is an in-memory prototype with no real SSO or persistent audit log. Do not deploy publicly. Production requires PostgreSQL, identity, scoped access control, immutable audit, evidence storage, and verification tests.
