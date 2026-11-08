# Maintainer review (demo)
Managers can request changes, document production nuances and errors, and close individual change requests. Authors can reply. During in_progress, feedback can be recorded as positive or negative observations. Unresolved change requests block resolution. Reviews and audit events are persisted.
API: GET/POST /api/requests/:id/reviews; POST /api/requests/:id/reviews/:reviewId/resolve.
Current access remains owner/manager demo only. No true cross-employee discussion, inline anchors, approval workflows, dedicated pilot status, notification delivery or independent verification. Demo authentication is not production-safe.
