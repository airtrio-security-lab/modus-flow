# MODUS FLOW — Contribution Network · Product concept
Status: product direction agreed in conversation, 2026-11-09. **Design specification, not implemented functionality.**

## Product
Hybrid multi-tenant idea-development platform: personal private lab, organization workspace, and future voluntary community publication. Initial pilot Modus Trade. Mobile-first PWA and desktop web; optional future Notion, ChatGPT and messaging integrations.

## Workflow
1. Private Idea Lab: author captures raw thought, revises in steps, optional AI discussion. Private until explicit publication; raw private dialogue and revisions must not leak.
2. Publish: creates a branch-like proposal with immutable provenance, author and snapshot. Notify relevant organization participants.
3. Review: threaded discussion, suggested revisions with their own authorship, evidence and positive/negative feedback.
4. CI / Pilot: a review branch for testing. Distinguish automated completeness checks from human/field validation. Anyone may propose a test; production experiments require authorized approval. Collect both favorable and unfavorable observations, with evidence, methodology, dates and reviewers. Failed tests remain part of the record and can represent valuable risk prevention.
5. Decision Owner: assigned by department and scope; may merge, request changes or reject with rationale. Higher-risk changes require additional approvals. Merge means decision to adopt, **not** proven positive impact.
6. Post-merge: verify actual adoption and outcomes; preserve links between idea, changes, tests, decisions and measured effects.

## Employee profile
Each employee has a card with department, authored proposals, co-authorship, accepted reviews, testing contributions, implementation contributions and verified impact. Do not equate idea count or likes with merit.

## Honor board
A recognition board showcases **verified** contributions in multiple categories (idea, review, testing, implementation, prevention of harm), with traceable evidence and context; not a mandatory global ranking. Avoid incentives for spam or suppressing negative results.

## Notifications
Examples: “Кирилл предложил на обсуждение новую идею”, new review, test started, decision, merge, verified result. Target relevant department, followers and participants; support preferences and digesting to avoid spam. Do not expose private drafts.

## Permissions and data
Owner-only private lab; organization-scoped published ideas; explicit external publication; roles author, colleague, pilot owner, reviewer, decision owner. Tenant isolation and authorization at API/data layers. Confidential corporate information and personal data require separate policy. User identity and provenance must remain consistent across versions.

## Visual direction
Quiet Intelligence: calm light interface, graphite typography, restrained teal accents. Mobile chat-first for capturing thoughts, desktop workspace-first for collaboration; common data and history. Proposal detail resembles GitHub issue/PR with branch, review, CI/pilot, decision and audit timeline.

## Implementation status / open questions
Current demo branches implement basic private drafts, step prompts, publication, contribution tracking and local durable state. They do NOT implement threaded discussions, review branches, real CI/pilot feedback, decision owner policy, profiles, honor board, notifications, multi-tenancy, AI chat or Notion. Do not imply these are built.
Decision pending: anyone may propose a test branch, but authorized owner approves execution of real operational pilots (recommended). Need policy for recognition evidence, personal/corporate data ownership, appeals and conflict of interest.
