import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, conflict, forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { extractFindings, formatMs, ITEM_TYPES, normQuote, type Finding, type FindingType } from '../domain/meeting.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { hashRequest, idempotent } from './idempotency.ts';
import { loadIdea } from './ideas.ts';
import { createItem } from './intake.ts';
import { extractFindingsByModel, type ModelConfig } from './advisor-model.ts';
import { transcribe, type TranscribeConfig } from './transcribe.ts';

/**
 * Council meetings with recording (ADR-0014):
 *   call a meeting → participants are notified → each gives or declines consent
 *   → recording (microphone) or upload of an existing file — only with everyone's
 *   consent, enforced by the database → transcript (local engine, typed by a
 *   person, or a prepared demo file — always labelled) → findings by template or
 *   local model, each with the exact quote, timestamp and speaker from the
 *   transcript → a lead participant confirms, keeps in memory or dismisses →
 *   a confirmed finding becomes an ordinary item through the usual intake.
 * Nothing here decides, assigns people or awards XP.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const MAX_RECORDING_BYTES = 25 * 1024 * 1024;

export interface MeetingDeps {
  model: ModelConfig | null;
  engine: TranscribeConfig | null;
  fetchImpl?: typeof fetch;
}

const isLead = (a: OrgActor) => a.access === 'member' && a.roles.some((r) => r === 'maintainer' || r === 'decision_owner' || r === 'org_admin');

async function notifyMeeting(c: Client, actor: OrgActor, event: 'meeting_called' | 'meeting_recording_started' | 'meeting_findings_ready', meetingId: string, recipients: string[], dedupe: string) {
  const targets = [...new Set(recipients.filter((r) => r && r !== actor.membershipId))];
  if (!targets.length) return 0;
  const { rows } = await c.query<{ n: number }>('SELECT app_notify_meeting($1, $2, $3::uuid[], $4) AS n', [event, meetingId, targets, dedupe]);
  return rows[0]!.n;
}

// ---------------------------------------------------------------------------
// Calling a meeting and consent
// ---------------------------------------------------------------------------
export const CreateMeetingInput = z
  .object({
    title: text(3, 200),
    departmentId: z.uuid().optional(),
    ideaNumber: z.number().int().positive().optional(),
    participants: z.array(z.uuid()).min(1).max(40),
    /** The organizer agrees to be recorded by calling a recorded meeting. */
    organizerConsent: z.literal(true),
  })
  .strict();

export async function createMeeting(db: Database, actor: OrgActor, input: z.infer<typeof CreateMeetingInput>, key?: string) {
  if (!isLead(actor)) throw forbidden('Заседание созывает руководитель или ведущий обращений');
  return withTx(db, orgTx(actor), async (c) =>
    idempotent(c, actor.userId, `meeting.create:${actor.orgId}`, key, hashRequest(input), async () => {
      const idea = input.ideaNumber ? await loadIdea(c, input.ideaNumber) : null;
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO meetings (organization_id, scope, department_id, idea_id, title, organizer_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [actor.orgId, input.departmentId ? 'castle' : 'royal', input.departmentId ?? null, idea?.id ?? null, input.title, actor.membershipId],
      );
      const id = rows[0]!.id;
      const people = [...new Set([actor.membershipId, ...input.participants])];
      for (const m of people) {
        const mine = m === actor.membershipId;
        await c.query(
          `INSERT INTO meeting_participants (organization_id, meeting_id, membership_id) VALUES ($1, $2, $3)`,
          [actor.orgId, id, m],
        );
        if (mine) {
          await c.query(`UPDATE meeting_participants SET consent = 'given', consent_at = clock_timestamp() WHERE meeting_id = $1 AND membership_id = $2`, [id, m]);
        }
      }
      await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'meeting.called', entityType: 'meeting', entityId: id, data: { participants: people.length } });
      await notifyMeeting(c, actor, 'meeting_called', id, people, id);
      return { status: 201, body: { id } };
    }),
  );
}

export async function setConsent(db: Database, actor: OrgActor, meetingId: string, consent: 'given' | 'declined') {
  return withTx(db, orgTx(actor), async (c) => {
    const r = await c.query(
      `UPDATE meeting_participants SET consent = $3, consent_at = clock_timestamp()
        WHERE meeting_id = $1 AND membership_id = $2 RETURNING consent`,
      [meetingId, actor.membershipId, consent],
    );
    if (!r.rowCount) throw notFound('Вы не участник этого заседания');
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: `meeting.consent_${consent}`, entityType: 'meeting', entityId: meetingId, data: {} });
    return { consent };
  });
}

async function loadMeeting(c: Client, id: string, lock = false) {
  const { rows } = await c.query<{
    id: string;
    title: string;
    scope: string;
    organizer_membership_id: string;
    recording_started_at: Date | null;
    ended_at: Date | null;
  }>(`SELECT id, title, scope, organizer_membership_id, recording_started_at, ended_at FROM meetings WHERE id = $1 AND organization_id = app_org_id()${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw notFound('Заседание не найдено');
  return rows[0];
}

/** Organizer starts recording: allowed by the database only when every participant consented. */
export async function startRecording(db: Database, actor: OrgActor, meetingId: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const m = await loadMeeting(c, meetingId, true);
    if (m.organizer_membership_id !== actor.membershipId) throw forbidden('Запись включает организатор заседания');
    if (m.recording_started_at) return { recordingStartedAt: m.recording_started_at, replayed: true };
    const pending = await c.query<{ name: string; consent: string }>(
      `SELECT e.display_name AS name, p.consent FROM meeting_participants p JOIN employees e ON e.membership_id = p.membership_id
        WHERE p.meeting_id = $1 AND p.consent <> 'given' ORDER BY e.display_name`,
      [meetingId],
    );
    if (pending.rowCount) {
      throw conflict('Запись возможна только с согласия всех участников', { waiting: pending.rows });
    }
    const { rows } = await c.query<{ t: Date }>('UPDATE meetings SET recording_started_at = clock_timestamp() WHERE id = $1 RETURNING recording_started_at AS t', [meetingId]);
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'meeting.recording_started', entityType: 'meeting', entityId: meetingId, data: {} });
    const people = await c.query<{ m: string }>('SELECT membership_id AS m FROM meeting_participants WHERE meeting_id = $1', [meetingId]);
    await notifyMeeting(c, actor, 'meeting_recording_started', meetingId, people.rows.map((r) => r.m), meetingId);
    return { recordingStartedAt: rows[0]!.t, replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Recording upload and download
// ---------------------------------------------------------------------------
const AUDIO: Record<string, (b: Buffer) => boolean> = {
  'audio/webm': (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  'audio/ogg': (b) => b.subarray(0, 4).toString('latin1') === 'OggS',
  'audio/mpeg': (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0),
  'audio/mp4': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'audio/wav': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE',
};
export const AUDIO_TYPES = Object.keys(AUDIO);
const ALIASES: Record<string, string> = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'video/webm': 'audio/webm' };

export function normalizeAudioType(header: string): string {
  const t = header.split(';')[0]!.trim().toLowerCase();
  return ALIASES[t] ?? t;
}

export async function uploadRecording(
  db: Database,
  actor: OrgActor,
  meetingId: string,
  file: { contentType: string; data: Buffer; source: 'microphone' | 'upload'; durationMs: number | null },
) {
  const type = normalizeAudioType(file.contentType);
  const check = AUDIO[type];
  if (!check) throw new AppError('unsupported_media_type', 'Формат записи не поддерживается', { allowed: AUDIO_TYPES });
  if (file.data.length === 0) throw new AppError('validation_failed', 'Пустой файл');
  if (file.data.length > MAX_RECORDING_BYTES) throw new AppError('payload_too_large', 'Запись больше 25 МБ');
  if (!check(file.data)) throw new AppError('validation_failed', 'Содержимое файла не похоже на аудио этого формата');
  return withTx(db, orgTx(actor), async (c) => {
    const m = await loadMeeting(c, meetingId, true);
    if (m.organizer_membership_id !== actor.membershipId) throw forbidden('Запись сохраняет организатор заседания');
    const exists = await c.query('SELECT 1 FROM meeting_recordings WHERE meeting_id = $1', [meetingId]);
    if (exists.rowCount) throw conflict('Запись этого заседания уже сохранена');
    if (!m.recording_started_at) {
      // An uploaded file still needs everyone's consent: the database refuses otherwise.
      await c.query('UPDATE meetings SET recording_started_at = clock_timestamp() WHERE id = $1', [meetingId]);
    }
    const hash = sha256(file.data);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO meeting_recordings (organization_id, meeting_id, source, content_type, size_bytes, duration_ms, sha256, data, uploaded_by_membership_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [actor.orgId, meetingId, file.source, type, file.data.length, file.durationMs, hash, file.data, actor.membershipId],
    );
    await c.query('UPDATE meetings SET ended_at = clock_timestamp() WHERE id = $1 AND ended_at IS NULL', [meetingId]);
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'meeting.recording_saved', entityType: 'meeting', entityId: meetingId, data: { bytes: file.data.length, source: file.source, sha256: hash } });
    return { id: rows[0]!.id, sha256: hash, sizeBytes: file.data.length };
  });
}

export async function downloadRecording(db: Database, actor: OrgActor, meetingId: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query<{ content_type: string; data: Buffer; sha256: string }>(
      'SELECT content_type, data, sha256 FROM meeting_recordings WHERE meeting_id = $1',
      [meetingId],
    );
    if (!rows[0]) throw notFound('Записи нет или нет доступа');
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'meeting.recording_played', entityType: 'meeting', entityId: meetingId, data: {} });
    return { contentType: rows[0].content_type, data: rows[0].data, sha256: rows[0].sha256 };
  });
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------
export const TranscriptInput = z.object({ text: z.string().min(20).max(100000), source: z.enum(['manual', 'prepared']) }).strict();

async function storeTranscript(c: Client, actor: OrgActor, meetingId: string, body: string, source: 'engine' | 'manual' | 'prepared', engine: string | null) {
  const clean = body.replace(/\r\n?/g, '\n');
  const hash = sha256(clean);
  const existing = await c.query<{ id: string }>('SELECT id FROM meeting_transcripts WHERE meeting_id = $1 AND sha256 = $2', [meetingId, hash]);
  if (existing.rows[0]) return { id: existing.rows[0].id, replayed: true };
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO meeting_transcripts (organization_id, meeting_id, source, engine, text, sha256, created_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [actor.orgId, meetingId, source, engine, clean, hash, actor.membershipId],
  );
  await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'meeting.transcript_added', entityType: 'meeting', entityId: meetingId, data: { source, engine } });
  return { id: rows[0]!.id, replayed: false };
}

export async function addTranscript(db: Database, actor: OrgActor, meetingId: string, input: z.infer<typeof TranscriptInput>) {
  if (!isLead(actor)) throw forbidden('Расшифровку добавляет руководитель — участник заседания');
  return withTx(db, orgTx(actor), async (c) => {
    await loadMeeting(c, meetingId);
    return storeTranscript(c, actor, meetingId, input.text, input.source, null);
  });
}

export async function transcribeRecording(db: Database, actor: OrgActor, meetingId: string, deps: MeetingDeps) {
  if (!deps.engine) throw conflict('Движок расшифровки не подключён. Вставьте расшифровку вручную');
  if (!isLead(actor)) throw forbidden('Расшифровку запускает руководитель — участник заседания');
  const rec = await downloadRecording(db, actor, meetingId);
  // The engine runs outside the transaction: a long recognition must not hold a connection.
  const body = await transcribe(deps.engine, rec.data, rec.contentType, deps.fetchImpl);
  return withTx(db, orgTx(actor), (c) => storeTranscript(c, actor, meetingId, body, 'engine', `${deps.engine!.model}`));
}

// ---------------------------------------------------------------------------
// Analysis → findings (drafts in the organization's memory)
// ---------------------------------------------------------------------------
export const AnalyzeInput = z.object({ transcriptId: z.uuid(), method: z.enum(['rules', 'model']).default('rules') }).strict();

export async function analyze(db: Database, actor: OrgActor, meetingId: string, input: z.infer<typeof AnalyzeInput>, deps: MeetingDeps) {
  if (!isLead(actor)) throw forbidden('Анализ запускает руководитель — участник заседания');
  const t = await withTx(db, orgTx(actor), async (c) => {
    const m = await loadMeeting(c, meetingId);
    const { rows } = await c.query<{ id: string; text: string; sha256: string }>(
      'SELECT id, text, sha256 FROM meeting_transcripts WHERE id = $1 AND meeting_id = $2',
      [input.transcriptId, meetingId],
    );
    if (!rows[0]) throw notFound('Расшифровка не найдена');
    const done = await c.query<{ id: string }>('SELECT id FROM meeting_protocols WHERE transcript_id = $1 AND method = $2', [input.transcriptId, input.method]);
    return { meeting: m, transcript: rows[0], existing: done.rows[0]?.id ?? null };
  });
  // Re-analysis of the same transcript by the same method returns the stored findings.
  if (t.existing) return { id: t.existing, replayed: true, findings: null, dropped: 0 };
  let found: { findings: Finding[]; dropped: number };
  if (input.method === 'model') {
    if (!deps.model) throw conflict('Локальная модель не подключена. Найдите находки по шаблону');
    found = await extractFindingsByModel(deps.model, t.transcript.text, deps.fetchImpl);
  } else found = { findings: extractFindings(t.transcript.text), dropped: 0 };

  return withTx(db, orgTx(actor), async (c) => {
    const again = await c.query<{ id: string }>('SELECT id FROM meeting_protocols WHERE transcript_id = $1 AND method = $2', [input.transcriptId, input.method]);
    if (again.rows[0]) return { id: again.rows[0].id, replayed: true, findings: null, dropped: 0 };
    const people = await c.query<{ id: string; name: string }>(
      `SELECT p.membership_id AS id, lower(e.display_name) AS name FROM meeting_participants p
         JOIN employees e ON e.membership_id = p.membership_id WHERE p.meeting_id = $1`,
      [meetingId],
    );
    const byName = new Map(people.rows.map((r) => [r.name, r.id]));
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO meeting_protocols (organization_id, created_by_membership_id, title, source_text, source_sha256, method, model, transcript_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [actor.orgId, actor.membershipId, `Заседание: ${t.meeting.title}`.slice(0, 200), t.transcript.text, t.transcript.sha256, input.method, input.method === 'model' ? deps.model!.model : null, input.transcriptId],
    );
    const pid = rows[0]!.id;
    for (const f of found.findings) {
      await c.query(
        `INSERT INTO protocol_candidates (organization_id, protocol_id, ord, quote_start, quote_end, quote, proposed_title, proposed_kind, proposed_raiser,
                                          finding_type, audio_start_ms, speaker_label, speaker_membership_id, confidence, basis)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [actor.orgId, pid, f.ord, f.quoteStart, f.quoteEnd, f.quote, f.title.slice(0, 160), f.kind, f.speaker, f.type, f.startMs, f.speaker,
          f.speaker ? (byName.get(f.speaker.toLowerCase()) ?? null) : null, f.confidence, f.basis.slice(0, 200)],
      );
    }
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'meeting.analyzed', entityType: 'meeting', entityId: meetingId, data: { method: input.method, findings: found.findings.length, dropped: found.dropped } });
    const all = await c.query<{ m: string }>('SELECT membership_id AS m FROM meeting_participants WHERE meeting_id = $1', [meetingId]);
    await notifyMeeting(c, actor, 'meeting_findings_ready', meetingId, all.rows.map((r) => r.m), pid);
    return { id: pid, replayed: false, findings: found.findings.length, dropped: found.dropped };
  });
}

// ---------------------------------------------------------------------------
// Review by a person
// ---------------------------------------------------------------------------
export const AcceptFindingInput = z
  .object({
    kind: z.enum(['idea', 'problem']),
    title: text(3, 160),
    problem: text(20, 5000),
    proposal: text(20, 5000).optional(),
    categoryId: z.uuid().optional(),
    departmentId: z.uuid().optional(),
    raisedBy: z.uuid().optional(),
  })
  .strict()
  .refine((v) => v.kind === 'problem' || !!v.proposal, { message: 'Для идеи опишите предлагаемое решение', path: ['proposal'] });

async function loadFinding(c: Client, meetingId: string, findingId: string) {
  const { rows } = await c.query<{
    id: string;
    status: string;
    finding_type: FindingType;
    quote: string;
    audio_start_ms: number | null;
    title: string;
  }>(
    `SELECT k.id, k.status, k.finding_type, k.quote, k.audio_start_ms, m.title
       FROM protocol_candidates k
       JOIN meeting_protocols p ON p.id = k.protocol_id
       JOIN meeting_transcripts t ON t.id = p.transcript_id
       JOIN meetings m ON m.id = t.meeting_id
      WHERE k.id = $2 AND m.id = $1 AND k.organization_id = app_org_id() FOR UPDATE OF k`,
    [meetingId, findingId],
  );
  const k = rows[0];
  if (!k) throw notFound('Находка не найдена');
  if (k.status !== 'proposed') throw conflict('По этой находке уже принято решение');
  return k;
}

export async function acceptFinding(db: Database, actor: OrgActor, meetingId: string, findingId: string, input: z.infer<typeof AcceptFindingInput>, key?: string) {
  if (!isLead(actor)) throw forbidden('Находки подтверждает руководитель — участник заседания');
  return withTx(db, orgTx(actor), async (c) =>
    idempotent(c, actor.userId, `meeting.accept:${findingId}`, key, hashRequest(input), async () => {
      const k = await loadFinding(c, meetingId, findingId);
      if (!ITEM_TYPES.includes(k.finding_type)) throw conflict('Эту находку можно сохранить в память, но не превратить в обращение');
      // The same words, confirmed earlier from another analysis of this meeting, are not registered twice.
      const twins = await c.query<{ quote: string; number: number }>(
        `SELECT k.quote, i.number FROM protocol_candidates k
           JOIN meeting_protocols p ON p.id = k.protocol_id JOIN meeting_transcripts t ON t.id = p.transcript_id
           JOIN ideas i ON i.id = k.item_id
          WHERE t.meeting_id = $1 AND k.status = 'accepted'`,
        [meetingId],
      );
      const twin = twins.rows.find((r) => normQuote(r.quote) === normQuote(k.quote));
      if (twin) throw conflict(`Это уже зарегистрировано: обращение №${twin.number}`, { number: twin.number });
      const item = await createItem(c, actor, {
        kind: input.kind,
        title: input.title,
        problem: input.problem,
        proposal: input.proposal ?? null,
        successCriteria: null,
        categoryId: input.categoryId,
        departmentId: input.departmentId,
        sourceChannel: 'meeting',
        sourceNote: `Заседание «${k.title}»${k.audio_start_ms !== null ? `, ${formatMs(k.audio_start_ms)}` : ''}`.slice(0, 300),
        raisedBy: input.raisedBy,
      });
      await c.query(
        `UPDATE protocol_candidates SET status = 'accepted', item_id = $2, decided_by_membership_id = $3, decided_at = clock_timestamp() WHERE id = $1`,
        [findingId, item.id, actor.membershipId],
      );
      await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'meeting.finding_accepted', entityType: 'idea', entityId: item.id, data: { meeting: meetingId, finding: findingId } });
      return { status: 201, body: { item } };
    }),
  );
}

export async function decideFinding(db: Database, actor: OrgActor, meetingId: string, findingId: string, status: 'noted' | 'dismissed') {
  if (!isLead(actor)) throw forbidden('Находки проверяет руководитель — участник заседания');
  return withTx(db, orgTx(actor), async (c) => {
    await loadFinding(c, meetingId, findingId);
    await c.query(
      `UPDATE protocol_candidates SET status = $2, decided_by_membership_id = $3, decided_at = clock_timestamp() WHERE id = $1`,
      [findingId, status, actor.membershipId],
    );
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: `meeting.finding_${status}`, entityType: 'meeting', entityId: meetingId, data: { finding: findingId } });
    return { status };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
export async function listMeetings(db: Database, actor: OrgActor) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT m.id, m.title, m.scope, d.name AS department, i.number AS "ideaNumber", o.display_name AS organizer,
              m.created_at AS "createdAt", m.recording_started_at AS "recordingStartedAt", m.ended_at AS "endedAt",
              (SELECT consent FROM meeting_participants x WHERE x.meeting_id = m.id AND x.membership_id = app_membership_id()) AS "myConsent",
              (SELECT count(*)::int FROM meeting_participants x WHERE x.meeting_id = m.id) AS participants,
              (SELECT count(*)::int FROM meeting_participants x WHERE x.meeting_id = m.id AND x.consent = 'given') AS consented,
              EXISTS (SELECT 1 FROM meeting_recordings r WHERE r.meeting_id = m.id) AS "hasRecording"
         FROM meetings m
         JOIN employees o ON o.membership_id = m.organizer_membership_id
         LEFT JOIN departments d ON d.id = m.department_id
         LEFT JOIN ideas i ON i.id = m.idea_id
        WHERE m.organization_id = app_org_id()
        ORDER BY m.created_at DESC LIMIT 100`,
    );
    return rows;
  });
}

export async function getMeeting(db: Database, actor: OrgActor, id: string, deps: MeetingDeps) {
  return withTx(db, orgTx(actor), async (c) => {
    const m = (
      await c.query(
        `SELECT m.id, m.title, m.scope, m.department_id AS "departmentId", d.name AS department, i.number AS "ideaNumber",
                m.organizer_membership_id AS "organizerMembershipId", o.display_name AS organizer, m.created_at AS "createdAt",
                m.recording_started_at AS "recordingStartedAt", m.ended_at AS "endedAt"
           FROM meetings m JOIN employees o ON o.membership_id = m.organizer_membership_id
           LEFT JOIN departments d ON d.id = m.department_id LEFT JOIN ideas i ON i.id = m.idea_id
          WHERE m.id = $1 AND m.organization_id = app_org_id()`,
        [id],
      )
    ).rows[0] as Record<string, unknown> | undefined;
    if (!m) throw notFound('Заседание не найдено или вы не участник');
    const participants = await c.query(
      `SELECT p.membership_id AS "membershipId", e.display_name AS name, e.job_title AS "jobTitle", e.department, p.consent, p.consent_at AS "consentAt"
         FROM meeting_participants p JOIN employees e ON e.membership_id = p.membership_id
        WHERE p.meeting_id = $1 ORDER BY e.display_name`,
      [id],
    );
    const recording = (
      await c.query(
        `SELECT r.source, r.content_type AS "contentType", r.size_bytes AS "sizeBytes", r.duration_ms AS "durationMs", r.sha256,
                r.created_at AS "createdAt", e.display_name AS "uploadedBy"
           FROM meeting_recordings r JOIN employees e ON e.membership_id = r.uploaded_by_membership_id WHERE r.meeting_id = $1`,
        [id],
      )
    ).rows[0] ?? null;
    const transcripts = await c.query(
      `SELECT t.id, t.source, t.engine, t.text, t.sha256, t.created_at AS "createdAt", e.display_name AS "createdBy"
         FROM meeting_transcripts t JOIN employees e ON e.membership_id = t.created_by_membership_id
        WHERE t.meeting_id = $1 ORDER BY t.created_at`,
      [id],
    );
    const analyses = await c.query(
      `SELECT p.id, p.transcript_id AS "transcriptId", p.method, p.model, p.created_at AS "createdAt", e.display_name AS "createdBy"
         FROM meeting_protocols p JOIN employees e ON e.membership_id = p.created_by_membership_id
         JOIN meeting_transcripts t ON t.id = p.transcript_id WHERE t.meeting_id = $1 ORDER BY p.created_at`,
      [id],
    );
    const findings = await c.query(
      `SELECT k.id, k.protocol_id AS "analysisId", k.ord, k.finding_type AS type, k.quote, k.quote_start AS "quoteStart", k.quote_end AS "quoteEnd",
              k.proposed_title AS title, k.proposed_kind AS kind, k.audio_start_ms AS "startMs", k.speaker_label AS "speakerLabel",
              k.speaker_membership_id AS "speakerMembershipId", k.confidence, k.basis, k.status, i.number AS "itemNumber",
              d.display_name AS "decidedBy", k.decided_at AS "decidedAt"
         FROM protocol_candidates k
         JOIN meeting_protocols p ON p.id = k.protocol_id JOIN meeting_transcripts t ON t.id = p.transcript_id
         LEFT JOIN ideas i ON i.id = k.item_id LEFT JOIN employees d ON d.membership_id = k.decided_by_membership_id
        WHERE t.meeting_id = $1 ORDER BY p.created_at, k.ord`,
      [id],
    );
    const me = participants.rows.find((p) => p.membershipId === actor.membershipId);
    const allConsented = participants.rows.length > 0 && participants.rows.every((p) => p.consent === 'given');
    const organizer = m.organizerMembershipId === actor.membershipId;
    return {
      ...m,
      participants: participants.rows,
      myConsent: me?.consent ?? null,
      allConsented,
      recording,
      transcripts: transcripts.rows,
      analyses: analyses.rows,
      findings: findings.rows,
      engine: deps.engine ? { configured: true, model: deps.engine.model } : { configured: false, model: null },
      model: deps.model ? { configured: true, model: deps.model.model } : { configured: false, model: null },
      can: {
        consent: !!me && !m.recordingStartedAt,
        record: organizer && allConsented && !recording,
        review: isLead(actor),
        transcribe: isLead(actor) && !!recording && !!deps.engine,
        addTranscript: isLead(actor),
      },
    };
  });
}

/** Where an item came from, if it was confirmed from a meeting the viewer took part in. */
export async function itemOrigin(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number);
    const { rows } = await c.query(
      `SELECT m.id AS "meetingId", m.title, k.audio_start_ms AS "startMs", k.quote, k.finding_type AS type, k.speaker_label AS speaker,
              k.confidence, t.source AS "transcriptSource", d.display_name AS "confirmedBy", k.decided_at AS "confirmedAt"
         FROM protocol_candidates k
         JOIN meeting_protocols p ON p.id = k.protocol_id JOIN meeting_transcripts t ON t.id = p.transcript_id
         JOIN meetings m ON m.id = t.meeting_id LEFT JOIN employees d ON d.membership_id = k.decided_by_membership_id
        WHERE k.item_id = $1`,
      [idea.id],
    );
    return rows[0] ?? null;
  });
}
