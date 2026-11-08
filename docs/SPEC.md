# Product specification · MODUS FLOW v0.1

## Goal
An employee submits a problem or suggestion; a designated manager receives and processes it; the author can track status and review the outcome.

## Roles
- Employee: submit, list own cases, reopen their resolved/rejected case.
- Manager: view queue and transition cases through review/progress/resolution (demo scope only).
- Admin: reserved for organizational configuration; no demo admin authentication.

## Domain lifecycle
`submitted → in_review → in_progress → resolved`, with `rejected` from early stages and `reopened` from terminal states. Forbidden transitions fail closed. History records every successful change.

## Acceptance scenarios
1. Employee submits valid problem or idea; receives unique identifier and submitted status.
2. Invalid submissions fail validation.
3. Manager moves submission into review, progress and resolution.
4. Author reopens resolved/rejected item.
5. Employee cannot see or modify another employee's case.
6. Restart clears demo data (intentional non-production constraint).

## Later
Department directory, confidential channel, safe attachments, notifications, SLA, rich analytics and AI-assisted routing; AI only recommends, never decides or exposes restricted cases.
