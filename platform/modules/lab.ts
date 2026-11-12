import { z } from 'zod';
import { AppError, conflict, notFound } from '../domain/errors.ts';
import { LabContentSchema, projectPublication, type LabContent } from '../domain/lab.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx, resolveOrgActor } from './context.ts';
import { hashRequest, idempotent, type IdempotentResult } from './idempotency.ts';
import { createItem } from './intake.ts';

/**
 * Personal Lab: private, user-owned drafts. Nothing here is organization-scoped
 * and nothing here is readable by anyone but the owner (enforced by RLS).
 * Publication is the only bridge to an organization and copies a snapshot of
 * exactly three fields (see domain/lab.ts).
 */
export const CreateDraftInput = z
  .object({
    kind: z.enum(['idea', 'problem']).default('idea'),
    title: z.string().trim().min(3).max(160),
    content: LabContentSchema.default({}),
  })
  .strict();

export const SaveVersionInput = z
  .object({
    baseVersion: z.number().int().min(1),
    title: z.string().trim().min(3).max(160),
    content: LabContentSchema,
  })
  .strict();

export const PublishInput = z
  .object({
    organization: z.string().min(2).max(63),
    categoryId: z.uuid().optional(),
    departmentId: z.uuid().optional(),
  })
  .strict();

export interface DraftView {
  id: string;
  kind: 'idea' | 'problem';
  state: 'private' | 'published';
  version: number;
  title: string;
  content: LabContent;
  publishedIdeaId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DraftRow {
  id: string;
  kind: 'idea' | 'problem';
  state: 'private' | 'published';
  current_version: number;
  published_idea_id: string | null;
  created_at: Date;
  updated_at: Date;
  title: string;
  content: LabContent;
}

const DRAFT_SELECT = `
  SELECT d.id, d.kind, d.state, d.current_version, d.published_idea_id, d.created_at, d.updated_at,
         v.title, v.content
    FROM lab_drafts d
    JOIN lab_draft_versions v ON v.draft_id = d.id AND v.version = d.current_version`;

const toView = (r: DraftRow): DraftView => ({
  id: r.id,
  kind: r.kind,
  state: r.state,
  version: r.current_version,
  title: r.title,
  content: r.content,
  publishedIdeaId: r.published_idea_id,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

async function loadDraft(c: Client, id: string, lock = false): Promise<DraftRow> {
  // RLS hides other users' drafts, so "not yours" and "does not exist" are indistinguishable.
  const lockClause = lock ? ' FOR UPDATE OF d' : '';
  const { rows } = await c.query<DraftRow>(`${DRAFT_SELECT} WHERE d.id = $1${lockClause}`, [id]);
  const row = rows[0];
  if (!row) throw notFound('Черновик не найден');
  return row;
}

export async function createDraft(db: Database, userId: string, input: z.infer<typeof CreateDraftInput>): Promise<DraftView> {
  return withTx(db, { userId }, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO lab_drafts (owner_user_id, kind, current_version) VALUES ($1, $2, 1) RETURNING id`,
      [userId, input.kind],
    );
    const id = rows[0]!.id;
    await c.query(
      `INSERT INTO lab_draft_versions (draft_id, version, owner_user_id, title, content) VALUES ($1, 1, $2, $3, $4)`,
      [id, userId, input.title, JSON.stringify(input.content)],
    );
    await audit(c, { orgId: null, actorUserId: userId, action: 'lab.draft_created', entityType: 'lab_draft', entityId: id });
    return toView(await loadDraft(c, id));
  });
}

export async function listDrafts(db: Database, userId: string): Promise<DraftView[]> {
  return withTx(db, { userId }, async (c) => {
    const { rows } = await c.query<DraftRow>(`${DRAFT_SELECT} ORDER BY d.updated_at DESC`);
    return rows.map(toView);
  });
}

export async function getDraft(db: Database, userId: string, id: string): Promise<DraftView & { versions: { version: number; title: string; createdAt: string }[] }> {
  return withTx(db, { userId }, async (c) => {
    const draft = toView(await loadDraft(c, id));
    const { rows } = await c.query<{ version: number; title: string; created_at: Date }>(
      'SELECT version, title, created_at FROM lab_draft_versions WHERE draft_id = $1 ORDER BY version',
      [id],
    );
    return { ...draft, versions: rows.map((r) => ({ version: r.version, title: r.title, createdAt: r.created_at.toISOString() })) };
  });
}

/** Saves a new private version. `baseVersion` prevents silent overwrites from a second device. */
export async function saveVersion(db: Database, userId: string, id: string, input: z.infer<typeof SaveVersionInput>): Promise<DraftView> {
  return withTx(db, { userId }, async (c) => {
    const draft = await loadDraft(c, id, true);
    if (draft.state !== 'private') throw conflict('Опубликованный черновик не изменяется; развивайте идею в организации');
    if (draft.current_version !== input.baseVersion) {
      throw conflict('Черновик изменён в другом окне', { currentVersion: draft.current_version });
    }
    const next = draft.current_version + 1;
    await c.query(
      `INSERT INTO lab_draft_versions (draft_id, version, owner_user_id, title, content) VALUES ($1, $2, $3, $4, $5)`,
      [id, next, userId, input.title, JSON.stringify(input.content)],
    );
    await c.query('UPDATE lab_drafts SET current_version = $2, updated_at = now() WHERE id = $1', [id, next]);
    return toView(await loadDraft(c, id));
  });
}

/** The owner may delete their own Lab material at any time; published ideas are unaffected. */
export async function deleteDraft(db: Database, userId: string, id: string): Promise<void> {
  await withTx(db, { userId }, async (c) => {
    await loadDraft(c, id, true);
    await c.query('DELETE FROM lab_drafts WHERE id = $1', [id]);
    await audit(c, { orgId: null, actorUserId: userId, action: 'lab.draft_deleted', entityType: 'lab_draft', entityId: id });
  });
}

export interface PublishedIdea {
  idea: { id: string; number: number; organization: string; title: string; stage: string };
}

/**
 * Publishes a private draft into an organization as idea #N, atomically:
 * idea + revision 1 + authorship contribution + draft state + audit +
 * notifications all commit together or not at all. Safe to retry with the
 * same Idempotency-Key; a draft can be published only once.
 */
export async function publishDraft(
  db: Database,
  userId: string,
  draftId: string,
  input: z.infer<typeof PublishInput>,
  idempotencyKey?: string,
): Promise<IdempotentResult<PublishedIdea>> {
  const actor = await resolveOrgActor(db, userId, input.organization);
  return withTx(db, orgTx(actor), (c) =>
    idempotent(c, userId, `lab.publish:${draftId}`, idempotencyKey, hashRequest({ draftId, ...input }), async () => {
      const draft = await loadDraft(c, draftId, true);
      if (draft.state !== 'private') throw conflict('Черновик уже опубликован');
      const parsed = LabContentSchema.safeParse(draft.content);
      if (!parsed.success) throw new AppError('validation_failed', 'Содержимое черновика повреждено');
      const snapshot = projectPublication(draft.title, parsed.data);

      const created = await createItem(c, actor, {
        kind: draft.kind,
        title: snapshot.title,
        problem: snapshot.problem,
        proposal: snapshot.proposal,
        successCriteria: snapshot.successCriteria,
        categoryId: input.categoryId,
        departmentId: input.departmentId,
        sourceChannel: 'app',
      });
      const ideaId = created.id;
      const number = created.number;
      await c.query(
        `UPDATE lab_drafts SET state = 'published', published_idea_id = $2, published_at = now(), updated_at = now() WHERE id = $1`,
        [draftId, ideaId],
      );
      await audit(c, {
        orgId: null,
        actorUserId: userId,
        action: 'lab.draft_published',
        entityType: 'lab_draft',
        entityId: draftId,
        data: { version: draft.current_version, ideaId },
      });
      return {
        status: 201,
        body: { idea: { id: ideaId, number, organization: input.organization, title: snapshot.title, stage: created.stage } },
      };
    }),
  );
}
