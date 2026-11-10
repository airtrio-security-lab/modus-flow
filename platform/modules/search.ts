import { z } from 'zod';
import { ITEM_STATUSES } from '../domain/status.ts';
import { IDEA_STAGES, SOURCE_CHANNELS, type OrgActor } from '../domain/model.ts';
import { withTx, type Database } from '../db/pool.ts';
import { orgTx } from './context.ts';

/**
 * Lists, filters and full-text search over the idea_overview read model
 * (brief §2.4 «Поиск, фильтрация и просмотр истории обращений»), and
 * similar-item detection to reduce duplicates («повторяющиеся проблемы»).
 */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const SearchQuery = z
  .object({
    q: z.string().trim().min(2).max(200).optional(),
    status: z.enum(ITEM_STATUSES).optional(),
    stage: z.enum(IDEA_STAGES).optional(),
    kind: z.enum(['idea', 'problem']).optional(),
    category: z.uuid().optional(),
    department: z.uuid().optional(),
    channel: z.enum(SOURCE_CHANNELS).optional(),
    mine: bool.optional(),
    assigned: bool.optional(),
    overdue: bool.optional(),
    stale: bool.optional(),
    open: bool.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type SearchQueryT = z.infer<typeof SearchQuery>;

const OVERVIEW_COLUMNS = `
  o.number, o.kind, o.title, o.stage, o.status, o.category, o.department, o.source_channel AS "sourceChannel",
  o.author, o.raised_by AS "raisedBy", o.maintainer, o.decision_owner AS "decisionOwner", o.implementer,
  o.published_at AS "publishedAt", o.updated_at AS "updatedAt",
  o.first_response_due_at AS "firstResponseDueAt", o.first_response_at AS "firstResponseAt",
  o.resolution_due_at AS "resolutionDueAt",
  o.overdue_first_response AS "overdueFirstResponse", o.overdue_resolution AS "overdueResolution", o.stale`;

export async function searchItems(db: Database, actor: OrgActor, f: SearchQueryT) {
  return withTx(db, orgTx(actor), async (c) => {
    const where: string[] = ['o.organization_id = app_org_id()'];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (f.q) {
      const q = p(f.q);
      where.push(`(to_tsvector('russian', o.title || ' ' || o.problem || ' ' || coalesce(o.proposal, '')) @@ websearch_to_tsquery('russian', ${q})
                   OR o.title ILIKE '%' || ${q} || '%')`);
    }
    if (f.status) where.push(`o.status = ${p(f.status)}`);
    if (f.stage) where.push(`o.stage = ${p(f.stage)}`);
    if (f.kind) where.push(`o.kind = ${p(f.kind)}`);
    if (f.category) where.push(`o.category_id = ${p(f.category)}`);
    if (f.department) where.push(`o.department_id = ${p(f.department)}`);
    if (f.channel) where.push(`o.source_channel = ${p(f.channel)}`);
    if (f.mine) where.push(`app_membership_id() IN (o.author_membership_id, o.raised_by_membership_id)`);
    if (f.assigned) where.push(`app_membership_id() IN (o.maintainer_membership_id, o.decision_owner_membership_id, o.implementer_membership_id)`);
    if (f.overdue) where.push(`(o.overdue_first_response OR o.overdue_resolution)`);
    if (f.stale) where.push(`o.stale`);
    if (f.open) where.push(`o.stage NOT IN ('closed','impact_verification')`);
    const { rows } = await c.query(
      `SELECT ${OVERVIEW_COLUMNS} FROM idea_overview o WHERE ${where.join(' AND ')}
        ORDER BY (o.overdue_first_response OR o.overdue_resolution) DESC, o.updated_at DESC LIMIT ${p(f.limit)}`,
      params,
    );
    return rows;
  });
}

export const SimilarQuery = z.object({ q: z.string().trim().min(5).max(500) }).strict();

/**
 * Finds existing items that look like the text being typed, so the employee
 * can follow an existing item instead of creating a duplicate.
 */
export async function similarItems(db: Database, actor: OrgActor, q: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT o.number, o.title, o.status, o.category,
              round(greatest(word_similarity($1, o.title), word_similarity($1, o.problem))::numeric, 2) AS score
         FROM idea_overview o
        WHERE o.organization_id = app_org_id()
          AND (word_similarity($1, o.title) > 0.35 OR word_similarity($1, o.problem) > 0.45
               OR to_tsvector('russian', o.title || ' ' || o.problem) @@ plainto_tsquery('russian', $1))
        ORDER BY score DESC, o.updated_at DESC LIMIT 5`,
      [q],
    );
    return rows;
  });
}
