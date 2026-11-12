import { z } from 'zod';
import { forbidden } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Database } from '../db/pool.ts';
import { orgTx } from './context.ts';

/**
 * Owner / management dashboard (brief §2.7 metrics; owner video: "what needs a
 * decision, what is forgotten, where questions come from"). Every number is
 * computed from recorded facts — no estimates, no likes, no rankings of people.
 */
export const AnalyticsQuery = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .strict();

export async function analytics(db: Database, actor: OrgActor, q: z.infer<typeof AnalyticsQuery>) {
  const lead = actor.access === 'member' && actor.roles.some((r) => r === 'maintainer' || r === 'decision_owner' || r === 'org_admin');
  if (!lead) throw forbidden('Аналитика доступна руководителям и администраторам');
  return withTx(db, orgTx(actor), async (c) => {
    const period = [q.from ?? '1970-01-01', q.to ?? '9999-12-31'];
    const scope = `o.organization_id = app_org_id() AND o.published_at >= $1::date AND o.published_at < ($2::date + 1)`;

    const totals = await c.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE o.stage NOT IN ('closed','impact_verification'))::int AS open,
              count(*) FILTER (WHERE o.status = 'unrouted')::int AS unrouted,
              count(*) FILTER (WHERE o.overdue_first_response)::int AS "overdueFirstResponse",
              count(*) FILTER (WHERE o.overdue_resolution)::int AS "overdueResolution",
              count(*) FILTER (WHERE o.stale)::int AS stale,
              count(*) FILTER (WHERE o.first_response_at IS NOT NULL)::int AS responded,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM decisions d WHERE d.idea_id = o.id))::int AS "withResult",
              count(*) FILTER (WHERE o.status = 'implemented')::int AS implemented,
              count(*) FILTER (WHERE o.status = 'in_progress')::int AS "inProgress",
              count(*) FILTER (WHERE o.status = 'rejected')::int AS rejected,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o.first_response_at - o.published_at) / 3600)
                      FILTER (WHERE o.first_response_at IS NOT NULL))::numeric, 1) AS "medianFirstResponseHours",
              round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM o.first_response_at - o.published_at) / 3600)
                      FILTER (WHERE o.first_response_at IS NOT NULL))::numeric, 1) AS "p90FirstResponseHours"
         FROM idea_overview o WHERE ${scope}`,
      period,
    );
    const t = totals.rows[0] as Record<string, number>;
    const share = (n: number) => (t.total ? Math.round((n / t.total) * 1000) / 10 : null);

    const byStatus = await c.query(`SELECT o.status, count(*)::int AS count FROM idea_overview o WHERE ${scope} GROUP BY 1 ORDER BY 2 DESC`, period);
    const byChannel = await c.query(
      `SELECT o.source_channel AS channel, count(*)::int AS count FROM idea_overview o WHERE ${scope} GROUP BY 1 ORDER BY 2 DESC`,
      period,
    );
    const byCategory = await c.query(
      `SELECT coalesce(o.category, 'Без категории') AS category, count(*)::int AS total,
              count(*) FILTER (WHERE o.stage NOT IN ('closed','impact_verification'))::int AS open,
              count(*) FILTER (WHERE o.status = 'implemented')::int AS implemented,
              count(*) FILTER (WHERE o.status = 'rejected')::int AS rejected,
              count(*) FILTER (WHERE o.overdue_first_response OR o.overdue_resolution)::int AS overdue
         FROM idea_overview o WHERE ${scope} GROUP BY 1 ORDER BY 2 DESC`,
      period,
    );
    const byDepartment = await c.query(
      `SELECT coalesce(o.department, 'Не указано') AS department, count(*)::int AS total,
              count(*) FILTER (WHERE o.stage NOT IN ('closed','impact_verification'))::int AS open,
              count(*) FILTER (WHERE o.overdue_first_response OR o.overdue_resolution)::int AS overdue
         FROM idea_overview o WHERE ${scope} GROUP BY 1 ORDER BY 2 DESC`,
      period,
    );
    // Recurring problems: open items whose titles are close to each other.
    const recurring = await c.query(
      `WITH open_items AS (
         SELECT o.id, o.number, o.title, o.category FROM idea_overview o
          WHERE ${scope} AND o.stage NOT IN ('closed','impact_verification')
          ORDER BY o.published_at DESC LIMIT 500)
       SELECT a.number AS "anchorNumber", a.title AS "anchorTitle", a.category,
              array_agg(b.number ORDER BY b.number) AS "similarNumbers", count(*)::int + 1 AS size
         FROM open_items a JOIN open_items b ON b.id <> a.id AND b.number > a.number
                                            AND similarity(a.title, b.title) > 0.3
        GROUP BY a.number, a.title, a.category
        ORDER BY size DESC, a.number LIMIT 10`,
      period,
    );
    const attention = await c.query(
      `SELECT o.number, o.title, o.status, o.category, o.department, o.maintainer, o.published_at AS "publishedAt",
              o.overdue_first_response AS "overdueFirstResponse", o.overdue_resolution AS "overdueResolution", o.stale
         FROM idea_overview o
        WHERE ${scope} AND (o.status = 'unrouted' OR o.overdue_first_response OR o.overdue_resolution OR o.stale)
        ORDER BY o.published_at LIMIT 20`,
      period,
    );
    return {
      period: { from: q.from ?? null, to: q.to ?? null },
      totals: t,
      metrics: {
        shareResponded: share(t.responded ?? 0),
        shareWithResult: share(t.withResult ?? 0),
        medianFirstResponseHours: t.medianFirstResponseHours ?? null,
        p90FirstResponseHours: t.p90FirstResponseHours ?? null,
        implemented: t.implemented ?? 0,
      },
      byStatus: byStatus.rows,
      byChannel: byChannel.rows,
      byCategory: byCategory.rows,
      byDepartment: byDepartment.rows,
      recurring: distinctClusters(recurring.rows as { anchorNumber: number; similarNumbers: number[] }[]),
      needsAttention: attention.rows,
    };
  });
}

/**
 * The pair query returns one row per anchor, so a group of three similar items
 * appears again from its second member. Keep a cluster only if its anchor is
 * not already part of a cluster kept before (rows are ordered by size).
 */
export function distinctClusters<T extends { anchorNumber: number; similarNumbers: number[] }>(rows: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.anchorNumber)) continue;
    out.push(r);
    seen.add(r.anchorNumber);
    for (const n of r.similarNumbers) seen.add(n);
  }
  return out;
}
