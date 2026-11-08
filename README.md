# MODUS FLOW

Internal employee feedback and improvement workflow for the Pavlodar Hub × Modus Trade hackathon.

**Stage:** functional, isolated **demo**, not production-ready. Target production review: 14 November 2026.

## Demo (Node.js >=22)
```bash
DEMO_MODE=true npm start
# Open http://localhost:3000
npm test
```

Switch between demo employee and manager in the UI. Create an idea/problem, send for review, change its status, and reopen as the author. Demo access is deliberately limited to `DEMO_MODE=true`; demo bearer tokens are publicly visible in the browser source. **Never expose this process to the public internet or use real employee data.**

## MVP
- Employee submission with validation and assigned author identity
- Role-based state transitions, basic author-only visibility
- Status history and responsive Russian UI
- Built-in Node test suite; no third-party application dependencies

## Architecture
`public/` → browser UI; `src/server.js` → HTTP JSON API; `src/domain.js` → state machine; `test/` → domain regression tests.

## Production blockers
- Persistent PostgreSQL database, migrations and backups
- SSO/real authentication, secure sessions, CSRF mitigation where applicable
- Department/assignee routing, manager authorization scope, confidentiality model
- Durable audit trail, event notifications, monitoring and rate limiting
- Integration/e2e and threat-model tests, TLS and security review
- Separate build/deploy with secret management and controlled demo-data migration

See `docs/SPEC.md` and `docs/DELIVERY.md`.
