import { AppError, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { loadIdea } from './ideas.ts';

/**
 * Attachments ("прикладывает материалы", brief §2.3). Stored in PostgreSQL
 * (bytea, ≤ 5 MB, ≤ 10 per item) so they share the item's transaction, tenant
 * isolation and backups. Append-only. The declared type must match the file's
 * real signature; downloads are served as attachments with a sandbox CSP.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const ZIP = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'text/plain': (b) => {
    if (b.includes(0)) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b);
      return true;
    } catch {
      return false;
    }
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ZIP,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ZIP,
};
export const ALLOWED_TYPES = Object.keys(SIGNATURES);

export function validateFile(contentType: string, data: Buffer, fileName: string): void {
  const check = SIGNATURES[contentType];
  if (!check) throw new AppError('unsupported_media_type', 'Тип файла не поддерживается', { allowed: ALLOWED_TYPES });
  if (data.length === 0) throw new AppError('validation_failed', 'Пустой файл');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new AppError('payload_too_large', 'Файл больше 5 МБ');
  if (!check(data)) throw new AppError('validation_failed', 'Содержимое файла не соответствует его типу');
  if (!/^[^/\\\u0000-\u001f]{1,200}$/u.test(fileName) || /\p{Cf}/u.test(fileName)) {
    throw new AppError('validation_failed', 'Некорректное имя файла');
  }
}

export async function uploadAttachment(
  db: Database,
  actor: OrgActor,
  number: number,
  file: { fileName: string; contentType: string; data: Buffer },
) {
  validateFile(file.contentType, file.data, file.fileName);
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number);
    const participants = [
      idea.author_membership_id,
      idea.raised_by_membership_id,
      idea.maintainer_membership_id,
      idea.decision_owner_membership_id,
      idea.implementer_membership_id,
    ];
    const owner = await c.query('SELECT 1 FROM verifications WHERE idea_id = $1 AND owner_membership_id = $2', [idea.id, actor.membershipId]);
    if (!participants.includes(actor.membershipId) && !owner.rowCount) {
      throw new AppError('forbidden', 'Файлы прикладывают автор, ответственные и исполнитель');
    }
    const { rows } = await c.query<{ id: string; size_bytes: number; sha256: string; created_at: Date }>(
      `INSERT INTO attachments (organization_id, idea_id, uploaded_by_membership_id, file_name, content_type, size_bytes, sha256, data)
       VALUES ($1, $2, $3, $4, $5, 0, '', $6) RETURNING id, size_bytes, sha256, created_at`,
      [actor.orgId, idea.id, actor.membershipId, file.fileName, file.contentType, file.data],
    );
    const a = rows[0]!;
    await audit(c, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'idea.attachment_added',
      entityType: 'attachment',
      entityId: a.id,
      data: { idea: number, size: a.size_bytes, type: file.contentType },
    });
    return { id: a.id, fileName: file.fileName, contentType: file.contentType, sizeBytes: a.size_bytes, sha256: a.sha256, createdAt: a.created_at.toISOString() };
  });
}

export async function downloadAttachment(db: Database, actor: OrgActor, number: number, id: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number);
    const { rows } = await c.query<{ file_name: string; content_type: string; data: Buffer; sha256: string }>(
      'SELECT file_name, content_type, data, sha256 FROM attachments WHERE id = $1 AND idea_id = $2',
      [id, idea.id],
    );
    if (!rows[0]) throw notFound('Файл не найден');
    return { fileName: rows[0].file_name, contentType: rows[0].content_type, data: rows[0].data, sha256: rows[0].sha256 };
  });
}
