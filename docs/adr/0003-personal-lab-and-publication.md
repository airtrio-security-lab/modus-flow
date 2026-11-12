# ADR-0003 · Personal Lab and explicit publication

**Context.** Employees must be able to think privately (including future AI dialogue) without any
risk of half-formed thoughts reaching their employer.

**Decision.** Lab drafts belong to a **user**, not an organization, and carry no organization id.
Publication is the only bridge: in one transaction it creates idea #N, revision 1, an authorship
contribution, audit entries and notifications, and freezes the draft. Only `title`,
`observation → problem`, `proposal → proposal`, `pilot → success criteria` are copied; `cause`,
`evidence`, `risks`, `notes` and any future AI dialogue never leave the Lab. Organization audit does
not record the draft id. Owners may delete Lab material at any time; published ideas are unaffected.
Publication is idempotent (`Idempotency-Key`) and race-safe (row lock; tested with 6 concurrent
publishers → exactly one idea).

**Consequences.** + Privacy by construction. − Authors must deliberately restate private evidence
in the organization if they want it considered — intended friction.
