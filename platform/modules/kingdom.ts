import { forbidden } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Database } from '../db/pool.ts';
import { orgTx } from './context.ts';
import { castleProgress, loadConfig } from './progress.ts';
import { levelFor } from '../domain/progress.ts';

/**
 * «Королевство»: the same items drawn as a living map (owner decision,
 * 2026-11-11). One castle per active department; a castle gains a tower for
 * every implemented item of that department and nothing else — submitting a
 * lot does not grow it. Open items are envoys on the road to the council.
 *
 * Read-only and computed from recorded facts under the caller's row-level
 * security: a member sees what «Все обращения» already shows, nothing more.
 * Castles belong to departments, never to people: no personal scores.
 */
export interface Castle {
  id: string;
  name: string;
  towers: number;
  building: number;
  envoys: number;
  waiting: number;
  returned: number;
  /** Progress (0007): XP from confirmed events only, level 1..5 by the organization's thresholds. */
  xp: number;
  level: number;
  levelName: string;
  levelFloor: number;
  nextLevelXp: number | null;
  nextLevelName: string | null;
  progress: number;
  effectXp: number;
  headcount: number | null;
  /** Architectural style of the district (0014, ADR-0019): a picture, no rights. */
  civilization: string;
  /** Achievements the castle earned (same rules as the castle page) — pedestals on the plaza. */
  achievements: number;
}

export interface Envoy {
  number: number;
  title: string;
  status: string;
  departmentId: string | null;
  responded: boolean;
  overdueFirstResponse: boolean;
  overdueResolution: boolean;
  stale: boolean;
  mine: boolean;
  publishedAt: string;
}

export async function kingdom(
  db: Database,
  actor: OrgActor,
): Promise<{ castles: Castle[]; envoys: Envoy[]; wildlands: number; levels: { thresholds: number[]; names: string[] } }> {
  if (actor.access !== 'member') throw forbidden('Город Содружества доступен сотрудникам организации');
  return withTx(db, orgTx(actor), async (c) => {
    const castles = await c.query<Castle>(
      `SELECT d.id, d.name, d.civilization,
              count(o.number) FILTER (WHERE o.status = 'implemented')::int AS towers,
              count(o.number) FILTER (WHERE o.status = 'in_progress')::int AS building,
              count(o.number) FILTER (WHERE o.status NOT IN ('implemented','rejected','closed'))::int AS envoys,
              count(o.number) FILTER (WHERE o.overdue_first_response)::int AS waiting,
              count(o.number) FILTER (WHERE o.status IN ('rejected','closed'))::int AS returned
         FROM departments d
         LEFT JOIN idea_overview o ON o.department_id = d.id AND o.organization_id = app_org_id()
        WHERE d.organization_id = app_org_id() AND d.active
        GROUP BY d.id, d.name, d.civilization
        ORDER BY d.name`,
    );
    const envoys = await c.query<Envoy>(
      `SELECT o.number, o.title, o.status, o.department_id AS "departmentId",
              (o.first_response_at IS NOT NULL) AS responded,
              o.overdue_first_response AS "overdueFirstResponse", o.overdue_resolution AS "overdueResolution", o.stale,
              coalesce(app_membership_id() IN (o.author_membership_id, o.raised_by_membership_id), false) AS mine,
              o.published_at AS "publishedAt"
         FROM idea_overview o
        WHERE o.organization_id = app_org_id() AND o.status NOT IN ('implemented','rejected','closed')
        ORDER BY o.published_at
        LIMIT 300`,
    );
    const known = new Set(castles.rows.map((r) => r.id));
    const wildlands = envoys.rows.filter((e) => !e.departmentId || !known.has(e.departmentId)).length;
    const cfg = await loadConfig(c);
    const progress = await castleProgress(c);
    const withProgress = castles.rows.map((r) => {
      const p = progress.get(r.id);
      const lv = levelFor(p?.xp ?? 0, cfg);
      return {
        ...r,
        xp: p?.xp ?? 0,
        level: lv.level,
        levelName: lv.name,
        levelFloor: lv.floor,
        nextLevelXp: lv.next,
        nextLevelName: lv.nextName,
        progress: lv.progress,
        effectXp: p?.effectXp ?? 0,
        headcount: p?.headcount ?? null,
        // Same rules as the castle page: first stone, five implementations, proven effect, each level-up.
        achievements: Number((p?.implemented ?? 0) >= 1) + Number((p?.implemented ?? 0) >= 5) + Number((p?.effectXp ?? 0) > 0) + (lv.level - 1),
      };
    });
    return { castles: withProgress, envoys: envoys.rows, wildlands, levels: { thresholds: cfg.thresholds, names: cfg.names } };
  });
}
