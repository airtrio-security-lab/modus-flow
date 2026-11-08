# MODUS FLOW · Private Idea Lab v0.3
Approved design: private-by-default ideation, step-by-step reflection, explicit publication into open employee contribution directory.
Six prompts: observation, cause, evidence, proposal, risks, pilot. Each saved step produces a revision. A draft is accessible only to its author; publication requires observation and proposal, and emits a separate public request snapshot plus a contribution. Private notes, risks, raw revision history and evidence are not copied to public content.
API: GET/POST /api/drafts; PATCH /api/drafts/:id {step,text}; POST /api/drafts/:id/publish. All authenticated; owner-only. Drafts immutable after publication. AI and Notion are planned integrations, NOT implemented. No automated AI calls.
Prototype limitations: in-memory storage, demo bearer tokens, no durable transactions or SSO. Not production ready. The public contribution directory is visible only to authenticated users. Do not put sensitive real employee data in demo.
