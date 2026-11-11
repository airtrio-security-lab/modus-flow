<div align="center">
  <img src=".github/media/modus-flow-hero.svg" width="100%" alt="MODUS FLOW — a living world for decisions" />
  <p><b>ONE COMPANY. MANY CIVILIZATIONS. ONE SHARED FUTURE.</b></p>
  <p>Every idea has a journey. Every decision leaves a trace. Every verified improvement changes the world.</p>
  <p><a href="README.ru.md">Русский</a> &nbsp;·&nbsp; <a href="#the-world">The world</a> &nbsp;·&nbsp; <a href="#architecture">Architecture</a> &nbsp;·&nbsp; <a href="#run-locally">Run locally</a></p>
</div>

---

<div align="center">
  <img src=".github/media/modus-flow-cinematic.gif" width="100%" alt="Animated original MODUS FLOW brand scene with a central citadel and themed districts" />
  <sub>Original animated brand artwork · Visual direction, not captured gameplay</sub>
</div>

<br />

## Ideas deserve more than an inbox.

**MODUS FLOW** turns employee feedback into an accountable journey: submit a problem or proposal, engage the right people, record an authorized decision, verify implementation, and preserve what was learned.

An organization becomes **the Great Commonwealth**. Departments become districts. Their castles gain architectural identity and grow when improvements are **actually delivered**, not when someone clicks an XP button.

> **Working today:** PostgreSQL workflow and interactive React/SVG city. **In development:** cinematic, genuinely rendered 3D with Three.js / React Three Fiber. The animation above is original concept artwork, not a video of the current app.

## The world

| Civilization | District identity | Small Council |
|:--|:--|:--|
| **Camelot** | Knightly citadels, towers, guilds | Hall of Knights |
| **Japanese Shogunate** | Tiered castles, gardens, timber and stone | Daimyō Hall |
| **Kazakh Khanate** | The khan's orda, yurts and steppe architecture | Khan's Yurt |
| **Mongol Realm** | Nomadic encampments, standards and fortifications | Council of Noyons |

**One company. One Commonwealth.** Civilizations are elected *visual styles for departments*, not separate companies or an inference about a person's background. Game titles never grant business permissions. The **Great Round Table** belongs to the whole organization.

## A decision becomes a story

~~~~text
Employee idea or problem
        ↓
Responsible department + deadline
        ↓
Small Council ── cross-team escalation ──→ Great Round Table
        ↓                                     ↓
Authorized human decision ←──────────────────┘
        ↓
Implementation → verified outcome → XP / castle growth
        ↓
Chronicle → Library of Decisions → Higher Archive
~~~~

**The advisor recommends. A person decides.** Current assistance is based on explicit rules, not a connected language model. Meeting recording requires each participant's consent and enforces access controls.

## More than a map

**Real work.** Submissions, Kanban, status history, routing, objections, evidence, authorized decisions, and deadlines.

**A living interface.** Department districts, staff cards, councils, messengers, growth levels and an accessible non-game workspace.

**Institutional memory.** Chronicle, reviewed decisions, Higher Archive, provenance and version history.

**Anywhere.** Desktop and responsive mobile PWA. Workflows remain available without cinematic graphics.

<div align="center">
  <a href="docs/demo/city/c-desk.png"><img src="docs/demo/city/c-desk.png" width="66%" alt="Actual SVG city screenshot on desktop" /></a>
  <a href="docs/demo/city/c-mob.png"><img src="docs/demo/city/c-mob.png" width="29%" alt="Actual mobile UI screenshot" /></a>
  <p><sub>Real development-build screenshots · Current React/SVG UI, not future 3D</sub></p>
</div>

## Honest build status

| System | Status in audited feat/kingdom-map baseline |
|:--|:--|
| Employee feedback, councils, decisions | Functional isolated demo |
| PostgreSQL 16, RLS, audit, verified XP | Implemented; regression tests exist |
| Four civilizations and department cards | React/SVG implementation |
| Chronicle, Library, Higher Archive | Demo implementation; legal review needed |
| Responsive mobile PWA | Implemented; real-device verification pending |
| Cinematic real-time 3D | **In development, not shipped** |
| AI advisor with an actual LLM | **Not connected**; rules available |
| Production rollout with real employee data | **Not ready**; OIDC and operational/privacy controls needed |

This describes an **audited baseline**, not a promise about concurrent work in progress. Read the [readiness audit](docs/audit/2026-11-11-final-readiness.md) and [architectural decisions](docs/adr/README.md).

## Architecture

~~~~text
React + TypeScript + Vite       Current: SVG city, operational UI, mobile PWA
             │
             ▼
Authorized HTTP API             Ideas · people · tasks · councils · knowledge
             │
             ▼
PostgreSQL 16 + Row-Level Security
Verified decisions · privacy · evidence · append-only XP
             │
             └── Planned visual presentation: Three.js + React Three Fiber
                 (same API; no duplicate business state)
~~~~

The world is a **visual projection of verified business events**, never a second source of truth.

## Run locally

Requires **Node.js ≥ 22.18, PostgreSQL 16, Docker** and access to this private repository.

~~~~bash
git clone https://github.com/airtrio-security-lab/modus-flow.git
cd modus-flow
git switch feat/kingdom-map
npm ci
docker compose up -d postgres
cp .env.example .env
# Configure MODUS_AUTH_SECRET (at least 32 characters) and DB URLs.
# Use only a fresh fictional demo database, never real employee data.
export MIGRATION_DATABASE_URL=postgres://modus:modus-local-only@127.0.0.1:5432/modus
npm run demo:seed
npm run web:build
npm run demo:start
# http://127.0.0.1:3100
~~~~

The demo uses fictional people and an SSO imitation: **never expose the demo server to the public internet**. See the [platform architecture](docs/architecture/PLATFORM.md) and [city walkthrough](docs/demo/city-demo.md).

### Test the real flow

~~~~bash
export TEST_DATABASE_URL=postgres://modus:modus-local-only@127.0.0.1:5432/postgres
npm run verify         # Local: typecheck, database tests, web build
npm run demo:city      # Requires fresh seeded demo
npm run demo:final     # Idea → Council → implementation → legacy
~~~~

GitHub Actions were blocked by account billing in the audited baseline. Local reported passes must not be represented as independently verified GitHub CI.

## Design as an experience. Engineer as evidence.

Our visual ambition is premium cinematic strategy-game art direction: credible architecture, restrained materials, deliberate light, beautiful motion, clear typography. The engineering standard is just as exacting: authorization, traceable decisions, honest model labels, idempotent XP and the separation of fact from simulation.

Created by **Air Trio Security Lab** in the Modus Trade hackathon context. This repository is private; no public license is implied. External artwork, code and fonts require appropriate licensing.

<div align="center"><h3>MODUS FLOW</h3><sub>Make progress visible. Make decisions accountable.</sub></div>
