# ADR-0014 · Living kingdom: game titles, council meetings with recording, findings with evidence

**Status.** Accepted for the demo (owner master prompt «Living Kingdom & AI Advisor», 2026-11-11). P0 only;
P1 (department chat halls, notification frequency settings) and P2 are not implemented yet.

**Context.** The owner asks for personal accounts with game roles, a council meeting that can be recorded,
transcribed and analysed, findings confirmed by a person and turned into ordinary work, and an
organizational memory of how decisions came about. No speech-to-text engine and no language model is
connected; paid services need the owner's approval; recordings of people need their consent.

**Decision.**
* **Four separate things about a person:** job title (directory), rights (`memberships.roles`), game title
  (`game_titles`, `guild_titles`) and achievements (the castle's XP). No policy, trigger or check reads a
  game title, so it can never grant access. King and regent are unique per organization and assigned by an
  admin; a department head is «Глава замка»; others get their guild's junior title by default. Titles are
  editable; none is humiliating.
* **Meetings** (`meetings`, `meeting_participants`): called only by leads; participants are notified with
  the real organizer as actor (`app_notify_meeting` proves the event against the meeting record). Every
  participant gives or declines consent **personally** — nobody can set another person's consent. The
  database refuses to start a recording or store a file unless every participant consented; once
  recording started, participants and consents are fixed.
* **Recordings** (`meeting_recordings`): microphone in the browser (MediaRecorder, visible indicator,
  pause, stop, retry on network errors) or an existing file (WebM, OGG, MP3, M4A, WAV; ≤ 25 MB; the file
  signature must match the type). Stored in PostgreSQL (same tenant isolation, transactions, backups;
  no separate encryption at rest), append-only, readable only by participants; playback is logged.
* **Transcripts** (`meeting_transcripts`): source is always stored and shown — `engine` (a local
  OpenAI-compatible speech-to-text server, off by default, local URL only), `manual` (typed by a person)
  or `prepared` (demo material, labelled «Подготовленная расшифровка — не распознана из этой записи»).
  The engine's output carries timestamps but no speakers: speakers are never guessed.
* **Findings** reuse the 0008 protocol pipeline (exact quote at its offsets, enforced by a trigger) and add
  type (idea, problem, task, deadline, owner candidate, proposed solution, decision, risk, objection, open
  question, insight), timestamp, speaker, confidence and basis. By default a transparent template finds
  them and the UI says «по шаблону (без ИИ)»; a decision only on explicit words («решили», «утвердили»,
  «договорились»); owners and deadlines only when named in the text. A local model (Ollama) is optional;
  its quotes are verified, its type must be known, and the timestamp and speaker come from the transcript
  line, never from the model. Transcript text is passed to the model as data with an instruction to ignore
  commands inside it; nothing a model returns can change a status, assign anyone or award XP.
* **Speaker attribution:** a finding is linked to a person only when the transcript label is exactly the
  name of a participant of that meeting (trigger-enforced); otherwise it stays an unmatched label.
* **Review:** findings are drafts in the organization's memory. A lead who took part confirms one into an
  ordinary item (same intake, routing, notifications; `source_channel = meeting`, note with the meeting
  and timestamp, credit to the person who raised it), keeps it in memory, or dismisses it — once.
  Re-analysing the same transcript returns the stored findings; the same words confirmed from another
  analysis of the meeting are refused with the existing item number.
* **Access:** a restrictive policy keeps transcript-based protocols visible only to participants — the
  0008 rule «leads read protocols» does not open a recorded conversation to leads who were not there.
* **Notifications:** game headline + business message. «Созван Королевский совет» / «Созван малый совет
  замка», «Идёт запись заседания», «Находки ждут проверки», «В замок прибыл посол», «Получено поручение»,
  «Замок повысил уровень». No headline imitates the King; a «Король направил послание» headline would
  require a real message from the title holder, which this version does not send.

**Consequences.**
+ The whole path — talk at the council → evidence → confirmed work → XP only after confirmed
  implementation — works without any external service and without cost.
+ Nothing in the interface can be mistaken for AI while no model is connected.
− Without a connected engine, transcription is manual; the demo uses a prepared, labelled transcript of a
  synthesized (espeak-ng) recording.
− The template misses findings phrased without markers; confidence for template findings reflects the
  kind of wording matched, not a measured accuracy.
− Audio is stored in the database: fine for a pilot (≤ 25 MB per meeting), an object store is needed later.
− Local engines are tested with stub servers only; they were not run against real models here.
