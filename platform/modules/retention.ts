import { z } from 'zod';
import { conflict, forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';

/**
 * Retention of meeting material (owner decision 2026-11-11, ADR-0015).
 *   * recordings 30 days and transcripts 90 days by default, per organization;
 *   * deletion only by an organization admin, with a reason, never under legal hold;
 *   * every purge, hold and retention change goes to an append-only log with hashes, no content;
 *   * a daily sweep purges what expired and re-applies logged purges after a backup restore.
 * Confirmed decisions, items and their execution are stored apart and are not touched here.
 */
const isAdmin = (a: OrgActor) => a.access === 'member' && a.roles.includes('org_admin');
const reason = z.string().trim().min(5).max(500);

export const RetentionInput = z
  .object({ audioDays: z.number().int().min(1).max(3650), transcriptDays: z.number().int().min(1).max(3650) })
  .strict();
export const PurgeInput = z.object({ what: z.enum(['recording', 'transcript', 'all']), reason }).strict();
export const HoldInput = z.object({ hold: z.boolean(), reason }).strict();

export async function retentionOverview(db: Database, actor: OrgActor) {
  if (!isAdmin(actor)) throw forbidden('Сроки хранения и удаление — у администратора организации');
  return withTx(db, orgTx(actor), async (c) => {
    const settings = (
      await c.query<{ audioDays: number; transcriptDays: number }>(
        'SELECT audio_retention_days AS "audioDays", transcript_retention_days AS "transcriptDays" FROM organizations WHERE id = app_org_id()',
      )
    ).rows[0]!;
    const meetings = await c.query(
      `SELECT meeting_id AS "meetingId", title, created_at AS "createdAt", legal_hold AS "legalHold", legal_hold_reason AS "legalHoldReason",
              recording_at AS "recordingAt", recording_bytes AS "recordingBytes", recording_purged_at AS "recordingPurgedAt",
              recording_expires_at AS "recordingExpiresAt", transcripts, transcripts_purged AS "transcriptsPurged",
              transcript_expires_at AS "transcriptExpiresAt"
         FROM app_retention_overview()`,
    );
    const log = await c.query(
      `SELECT l.created_at AS "at", l.object, l.action, l.reason, l.content_sha256 AS sha256, l.size_bytes AS "sizeBytes",
              coalesce(e.display_name, 'Система (по сроку)') AS actor, m.title AS meeting
         FROM retention_log l LEFT JOIN employees e ON e.membership_id = l.actor_membership_id
         LEFT JOIN meetings m ON m.id = l.meeting_id
        ORDER BY l.created_at DESC LIMIT 100`,
    );
    return {
      settings,
      meetings: meetings.rows,
      log: log.rows,
      note: 'Сроки по умолчанию: аудио 30 дней, расшифровки 90 дней. Меняйте их только после проверки правовых требований. Решения и их исполнение хранятся отдельно и здесь не удаляются.',
    };
  });
}

export async function setRetention(db: Database, actor: OrgActor, input: z.infer<typeof RetentionInput>) {
  if (!isAdmin(actor)) throw forbidden('Сроки хранения меняет администратор организации');
  return withTx(db, orgTx(actor), async (c) => {
    await c.query('UPDATE organizations SET audio_retention_days = $2, transcript_retention_days = $3 WHERE id = $1', [actor.orgId, input.audioDays, input.transcriptDays]);
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'retention.changed', entityType: 'organization', entityId: actor.orgId, data: input });
    return input;
  });
}

export async function purgeMedia(db: Database, actor: OrgActor, meetingId: string, input: z.infer<typeof PurgeInput>) {
  if (!isAdmin(actor)) throw forbidden('Удалять материалы заседаний может только администратор организации');
  return withTx(db, orgTx(actor), async (c) => {
    // Clear messages first; the database enforces the same rules again inside the purge.
    const m = (await c.query<{ legal_hold: boolean }>('SELECT legal_hold FROM app_retention_overview() WHERE meeting_id = $1', [meetingId])).rows[0];
    if (!m) throw notFound('Заседание не найдено');
    if (m.legal_hold) throw conflict('Заседание под законным удержанием: удаление запрещено, пока удержание не снято');
    const { rows } = await c.query<{ n: number }>('SELECT app_purge_meeting_media($1, $2, $3) AS n', [meetingId, input.what, input.reason]);
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'meeting.media_purged', entityType: 'meeting', entityId: meetingId, data: { what: input.what, count: rows[0]!.n } });
    return { purged: rows[0]!.n };
  });
}

export async function setLegalHold(db: Database, actor: OrgActor, meetingId: string, input: z.infer<typeof HoldInput>) {
  if (!isAdmin(actor)) throw forbidden('Законное удержание устанавливает администратор организации');
  return withTx(db, orgTx(actor), async (c) => {
    await c.query('SELECT app_set_legal_hold($1, $2, $3)', [meetingId, input.hold, input.reason]);
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: input.hold ? 'meeting.hold_set' : 'meeting.hold_released', entityType: 'meeting', entityId: meetingId, data: {} });
    return { legalHold: input.hold };
  });
}

/** Scheduled job, run with the schema-owner connection (see platform/cli/retention.ts). */
export async function sweep(db: Database, at?: Date): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>('SELECT app_retention_sweep($1) AS n', [at ?? new Date()]);
  return rows[0]!.n;
}
