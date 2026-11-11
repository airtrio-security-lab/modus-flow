# ADR-0015 · Meeting governance: personal consent, written protocol, retention, deletion, legal hold

**Status.** Accepted — owner decisions of 2026-11-11.

**Decisions of the owner (verbatim intent).**
1. Nobody gives consent to be recorded for someone else; without everyone's consent there is no recording;
   the alternative is a written protocol without recording.
2. The pilot uses local faster-whisper; its quality must be checked on real Russian speech, several speakers
   and background noise; prepared transcripts are never presented as automatic recognition.
3. Recordings are kept 30 days, transcripts 90 days by default; the organization sets them after a legal
   review; deletion only by an authorized admin, rights checked, an immutable record of the deletion;
   backups and legal holds are taken into account.
4. Confirmed decisions and their execution are stored apart from raw audio, under corporate policy; no
   unnecessary personal data.

**Implementation.**
* **Consent** (since 0009): `meeting_participants.consent` is changed only by that person (RLS); starting a
  recording or storing a file is refused by the database unless every *active* participant consented.
* **Written protocol** (0010): transcript source `minutes` — a lead participant writes the protocol of a
  meeting held without recording; it goes through the same findings and confirmation as a transcript.
  No consent is needed because nothing is recorded. The meeting page offers it whenever consent is missing.
* **Retention** (0010): `organizations.audio_retention_days` (default 30) and `transcript_retention_days`
  (default 90), 1…3650, changed by an org admin; every change is logged.
  `npm run platform:retention` (daily, schema owner) purges expired material.
* **Purge, not row deletion:** the recording row keeps who, when, size and SHA-256; its content is set to
  NULL. A transcript keeps its hash; its text and the protocol's copy are replaced by a placeholder.
  Unconfirmed drafts (proposed / dismissed findings) are deleted. Confirmed findings — accepted into an item or
  kept in memory — stay as the evidence of a decision; items, decisions, XP and execution history live in
  their own tables and are never touched by the purge.
* **Deletion by an admin:** `app_purge_meeting_media` — org admin only, reason ≥ 5 characters, never under a
  legal hold. The admin does not need to be a participant and never sees the content (the admin overview
  shows dates, sizes and expiry only).
* **Immutable log:** `retention_log` (append-only even for the schema owner's ordinary statements): purges,
  holds, releases and retention changes, with actor (NULL = system), reason, SHA-256 and size — no content.
* **Legal hold:** `app_set_legal_hold` with a reason; while set, neither the admin nor the schedule can purge.
* **Backups:** the sweep re-applies every purge recorded in the log, so content that comes back with a
  restored backup is purged again on the next run; run it right after a restore. Backups must not be kept
  longer than the audio retention period (operations policy, not enforceable from the application).
* **Append-only guarantees** stay: the purge flag (`modus.purge`) is honoured only inside the SECURITY DEFINER
  purge functions; the application role has no UPDATE/DELETE grant on these tables.

**Consequences.**
+ The rules are enforced by the database, tested (`test/platform/governance.test.ts`).
− Retention periods are defaults, not legal advice: the organization must confirm them with its lawyers.
− Database backups older than the retention period still contain purged audio until they rotate.
