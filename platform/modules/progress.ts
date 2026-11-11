import { z } from 'zod';
import { AppError, conflict, forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { levelFor, per10, thresholdsValid, type LevelConfig } from '../domain/progress.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { hashRequest, idempotent } from './idempotency.ts';
import { loadIdea } from './ideas.ts';
import { notify } from './notifications.ts';

/**
 * Castle progress: XP, levels, achievements and the department rating
 * (owner brief 2026-11-11, ADR-0012).
 *
 * XP is a ledger written only by database triggers on confirmed events:
 *   * implementation confirmed (stage → impact_verification): xp_per_implementation;
 *   * effect approved by the decision owner: 0..xp_effect_max, once per item.
 * Nothing is awarded for submitting, reviewing or rejecting, and (idea, kind)
 * is unique, so no event can be counted twice. Castles belong to departments;
 * this module never ranks people.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const EffectInput = z.object({ xp: z.number().int().min(0).max(1000), rationale: text(20, 3000) }).strict();
export const RatingQuery = z.object({ period: z.enum(['30', '90', '365', 'all']).default('all') }).strict();
export const ProgressSettingsInput = z
  .object({
    xpPerImplementation: z.number().int().min(0).max(1000).optional(),
    xpEffectMax: z.number().int().min(0).max(1000).optional(),
    levelThresholds: z.array(z.number().int().min(0).max(1_000_000)).length(5).optional(),
    levelNames: z.array(text(2, 40)).length(5).optional(),
  })
  .strict()
  .refine((v) => !v.levelThresholds || thresholdsValid(v.levelThresholds), {
    message: 'Пороги уровней: пять значений, первое 0, каждое следующее больше предыдущего',
    path: ['levelThresholds'],
  });

const fullMember = (a: OrgActor) => {
  if (a.access !== 'member') throw forbidden('Доступно сотрудникам организации');
};

export async function loadConfig(c: Client): Promise<LevelConfig> {
  const { rows } = await c.query<LevelConfig>(
    `SELECT level_thresholds AS thresholds, level_names AS names,
            xp_per_implementation AS "xpPerImplementation", xp_effect_max AS "xpEffectMax"
       FROM organizations WHERE id = app_org_id()`,
  );
  return rows[0]!;
}

export interface CastleProgress {
  id: string;
  xp: number;
  implemented: number;
  effectXp: number;
  headcount: number | null;
}

/** All-time progress of every active department (used by the kingdom map). */
export async function castleProgress(c: Client): Promise<Map<string, CastleProgress>> {
  const { rows } = await c.query<CastleProgress>(
    `SELECT d.id, coalesce(sum(a.xp), 0)::int AS xp,
            count(a.id) FILTER (WHERE a.kind = 'implementation')::int AS implemented,
            coalesce(sum(a.xp) FILTER (WHERE a.kind = 'effect'), 0)::int AS "effectXp",
            d.headcount
       FROM departments d LEFT JOIN xp_awards a ON a.department_id = d.id
      WHERE d.organization_id = app_org_id() AND d.active
      GROUP BY d.id`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Called in the same transaction right after an award was written. If the
 * department crossed a level threshold, the level-up is recorded in the audit
 * log with the item that brought it, and the item's originators are told.
 */
export async function afterAward(c: Client, actor: OrgActor, ideaId: string, kind: 'implementation' | 'effect') {
  const award = await c.query<{ department_id: string | null; xp: number; number: number }>(
    `SELECT a.department_id, a.xp, i.number FROM xp_awards a JOIN ideas i ON i.id = a.idea_id
      WHERE a.idea_id = $1 AND a.kind = $2`,
    [ideaId, kind],
  );
  const a = award.rows[0];
  if (!a?.department_id) return null;
  // «Замок получил XP» — to the people whose idea it was, once per award.
  const origin = (await c.query<{ author_membership_id: string; raised_by_membership_id: string | null }>(
    'SELECT author_membership_id, raised_by_membership_id FROM ideas WHERE id = $1',
    [ideaId],
  )).rows[0]!;
  await notify(c, actor, 'castle_xp', ideaId, [origin.author_membership_id, origin.raised_by_membership_id], `${ideaId}:${kind}`);
  const total = (await c.query<{ xp: number }>('SELECT coalesce(sum(xp), 0)::int AS xp FROM xp_awards WHERE department_id = $1', [a.department_id])).rows[0]!.xp;
  const cfg = await loadConfig(c);
  const before = levelFor(total - a.xp, cfg);
  const after = levelFor(total, cfg);
  if (after.level <= before.level) return null;
  await audit(c, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action: 'castle.level_up',
    entityType: 'department',
    entityId: a.department_id,
    data: { level: after.level, name: after.name, idea: a.number, xp: total },
  });
  const who = await c.query<{ author_membership_id: string; raised_by_membership_id: string | null }>(
    'SELECT author_membership_id, raised_by_membership_id FROM ideas WHERE id = $1',
    [ideaId],
  );
  const r = who.rows[0]!;
  await notify(c, actor, 'castle_level_up', ideaId, [r.author_membership_id, r.raised_by_membership_id], `${a.department_id}:${after.level}`);
  return { departmentId: a.department_id, from: before.level, to: after.level, name: after.name };
}

/** The decision owner confirms the documented effect of an implemented item: 0..xp_effect_max XP, once. */
export function approveEffect(db: Database, actor: OrgActor, number: number, input: z.infer<typeof EffectInput>, key?: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true);
    return idempotent(c, actor.userId, `effect.approve:${idea.id}`, key, hashRequest(input), async () => {
      const implemented = await c.query('SELECT 1 FROM xp_awards WHERE idea_id = $1 AND kind = $2', [idea.id, 'implementation']);
      if (!implemented.rowCount) throw conflict('Эффект подтверждается только после подтверждённого внедрения');
      if (actor.membershipId === idea.author_membership_id || actor.membershipId === idea.raised_by_membership_id) {
        throw forbidden('Эффект своей идеи подтверждает не автор, а ответственный за решение');
      }
      if (actor.membershipId !== idea.decision_owner_membership_id) throw forbidden('Эффект подтверждает ответственный за решение');
      const cfg = await loadConfig(c);
      if (input.xp > cfg.xpEffectMax) throw new AppError('validation_failed', `Бонус за эффект — не больше ${cfg.xpEffectMax} XP`);
      const exists = await c.query('SELECT 1 FROM effect_approvals WHERE idea_id = $1', [idea.id]);
      if (exists.rowCount) throw conflict('Эффект по этому обращению уже подтверждён');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO effect_approvals (organization_id, idea_id, approved_by_membership_id, xp, rationale)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [actor.orgId, idea.id, actor.membershipId, input.xp, input.rationale],
      );
      await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'effect.approved', entityType: 'idea', entityId: idea.id, data: { xp: input.xp } });
      const levelUp = await afterAward(c, actor, idea.id, 'effect');
      return { status: 201, body: { id: rows[0]!.id, number: idea.number, xp: input.xp, levelUp } };
    });
  });
}

const PERIOD_DAYS = { '30': 30, '90': 90, '365': 365, all: null } as const;

/** Department rating: XP, implemented items and confirmed effect, for a period and all time; normalized separately. */
export async function rating(db: Database, actor: OrgActor, q: z.infer<typeof RatingQuery>) {
  fullMember(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const cfg = await loadConfig(c);
    const days = PERIOD_DAYS[q.period];
    const from = days ? new Date(Date.now() - days * 86400e3) : new Date(0);
    const { rows } = await c.query<{
      id: string;
      name: string;
      headcount: number | null;
      xpTotal: number;
      xpPeriod: number;
      implementedTotal: number;
      implementedPeriod: number;
      effectXpTotal: number;
      effectXpPeriod: number;
    }>(
      `SELECT d.id, d.name, d.headcount,
              coalesce(sum(a.xp), 0)::int AS "xpTotal",
              coalesce(sum(a.xp) FILTER (WHERE a.created_at >= $1), 0)::int AS "xpPeriod",
              count(a.id) FILTER (WHERE a.kind = 'implementation')::int AS "implementedTotal",
              count(a.id) FILTER (WHERE a.kind = 'implementation' AND a.created_at >= $1)::int AS "implementedPeriod",
              coalesce(sum(a.xp) FILTER (WHERE a.kind = 'effect'), 0)::int AS "effectXpTotal",
              coalesce(sum(a.xp) FILTER (WHERE a.kind = 'effect' AND a.created_at >= $1), 0)::int AS "effectXpPeriod"
         FROM departments d LEFT JOIN xp_awards a ON a.department_id = d.id
        WHERE d.organization_id = app_org_id() AND d.active
        GROUP BY d.id, d.name, d.headcount`,
      [from],
    );
    const sorted = rows
      .map((r) => {
        const lv = levelFor(r.xpTotal, cfg);
        return {
          departmentId: r.id,
          name: r.name,
          headcount: r.headcount,
          level: lv.level,
          levelName: lv.name,
          xpTotal: r.xpTotal,
          xpPeriod: r.xpPeriod,
          implementedTotal: r.implementedTotal,
          implementedPeriod: r.implementedPeriod,
          effectXpTotal: r.effectXpTotal,
          effectXpPeriod: r.effectXpPeriod,
          xpPer10: per10(r.xpPeriod, r.headcount),
          implementedPer10: per10(r.implementedPeriod, r.headcount),
        };
      })
      .sort((a, b) => b.xpPeriod - a.xpPeriod || b.xpTotal - a.xpTotal || a.name.localeCompare(b.name, 'ru'));
    let rank = 0;
    let prev: number | null = null;
    const out = sorted.map((r, i) => {
      if (r.xpPeriod !== prev) rank = i + 1;
      prev = r.xpPeriod;
      return { rank, ...r };
    });
    return { period: q.period, from: days ? from.toISOString() : null, levels: { thresholds: cfg.thresholds, names: cfg.names }, rows: out };
  });
}

export interface Achievement {
  key: string;
  title: string;
  description: string;
  earnedAt: string | null;
}

/** One castle: level, XP history (which item brought what), level-ups and achievements. */
export async function castle(db: Database, actor: OrgActor, departmentId: string) {
  fullMember(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const d = await c.query<{ id: string; name: string; headcount: number | null }>(
      'SELECT id, name, headcount FROM departments WHERE id = $1 AND organization_id = app_org_id() AND active',
      [departmentId],
    );
    if (!d.rowCount) throw notFound('Замок не найден');
    const cfg = await loadConfig(c);
    const awards = await c.query<{
      kind: 'implementation' | 'effect';
      xp: number;
      at: Date;
      number: number;
      title: string;
      credited: string;
    }>(
      `SELECT a.kind, a.xp, a.created_at AS at, o.number, o.title, coalesce(o.raised_by, o.author) AS credited
         FROM xp_awards a JOIN idea_overview o ON o.id = a.idea_id
        WHERE a.department_id = $1 ORDER BY a.created_at, a.kind`,
      [departmentId],
    );
    let total = 0;
    let implemented = 0;
    const achievements = new Map<string, Achievement>();
    const earn = (key: string, title: string, description: string, at: Date) => {
      if (!achievements.has(key) || !achievements.get(key)!.earnedAt) achievements.set(key, { key, title, description, earnedAt: at.toISOString() });
    };
    const history = awards.rows.map((r) => {
      const before = levelFor(total, cfg).level;
      total += r.xp;
      const after = levelFor(total, cfg);
      if (r.kind === 'implementation') implemented += 1;
      if (r.kind === 'implementation' && implemented === 1) earn('first_stone', 'Первый камень', 'Первая подтверждённая реализация', r.at);
      if (r.kind === 'implementation' && implemented === 5) earn('five', 'Пять внедрений', 'Пять подтверждённых реализаций', r.at);
      if (r.kind === 'effect' && r.xp > 0) earn('proven_effect', 'Доказанный эффект', 'Ответственный подтвердил эффект внедрения', r.at);
      if (after.level > before) earn(`level_${after.level}`, after.name, `Замок достиг уровня ${after.level}`, r.at);
      return {
        kind: r.kind,
        xp: r.xp,
        at: r.at.toISOString(),
        number: r.number,
        title: r.title,
        credited: r.credited,
        total,
        levelUp: after.level > before ? { level: after.level, name: after.name } : null,
      };
    });
    const all: Achievement[] = [
      { key: 'first_stone', title: 'Первый камень', description: 'Первая подтверждённая реализация', earnedAt: null },
      ...cfg.names.slice(1).map((n, i) => ({ key: `level_${i + 2}`, title: n, description: `Замок достиг уровня ${i + 2}`, earnedAt: null })),
      { key: 'proven_effect', title: 'Доказанный эффект', description: 'Ответственный подтвердил эффект внедрения', earnedAt: null },
      { key: 'five', title: 'Пять внедрений', description: 'Пять подтверждённых реализаций', earnedAt: null },
    ].map((x) => achievements.get(x.key) ?? x);
    const lv = levelFor(total, cfg);
    return {
      ...lv,
      levelName: lv.name,
      id: d.rows[0]!.id,
      name: d.rows[0]!.name,
      headcount: d.rows[0]!.headcount,
      xp: total,
      implemented,
      levels: { thresholds: cfg.thresholds, names: cfg.names },
      history: history.reverse(),
      achievements: all,
    };
  });
}

/** My items and what the implemented ones brought to their castles — credit, not a score. */
export async function myContribution(db: Database, actor: OrgActor) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT o.number, o.title, o.status, o.department,
              (o.author_membership_id = app_membership_id()) AS authored,
              (o.raised_by_membership_id = app_membership_id()) AS credited,
              coalesce((SELECT sum(a.xp) FROM xp_awards a WHERE a.idea_id = o.id), 0)::int AS xp
         FROM idea_overview o
        WHERE o.organization_id = app_org_id()
          AND app_membership_id() IN (o.author_membership_id, o.raised_by_membership_id)
        ORDER BY o.published_at DESC LIMIT 200`,
    );
    return { items: rows };
  });
}

export async function updateProgressSettings(db: Database, actor: OrgActor, input: z.infer<typeof ProgressSettingsInput>) {
  if (!(actor.access === 'member' && actor.roles.includes('org_admin'))) throw forbidden('Только администратор организации');
  return withTx(db, orgTx(actor), async (c) => {
    await c.query(
      `UPDATE organizations SET
          xp_per_implementation = coalesce($2, xp_per_implementation),
          xp_effect_max = coalesce($3, xp_effect_max),
          level_thresholds = coalesce($4::int[], level_thresholds),
          level_names = coalesce($5::text[], level_names)
        WHERE id = $1`,
      [actor.orgId, input.xpPerImplementation ?? null, input.xpEffectMax ?? null, input.levelThresholds ?? null, input.levelNames ?? null],
    );
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'admin.progress_settings_updated', entityType: 'organization', entityId: actor.orgId, data: input });
    return loadConfig(c);
  });
}

/** XP awarded for one item and whether the viewer may approve its effect (item page). */
export async function ideaProgress(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number);
    const cfg = await loadConfig(c);
    const awards = await c.query(
      'SELECT kind, xp, created_at AS at FROM xp_awards WHERE idea_id = $1 ORDER BY created_at',
      [idea.id],
    );
    const effect = await c.query(
      `SELECT a.xp, a.rationale, a.created_at AS at, e.display_name AS "approvedBy"
         FROM effect_approvals a JOIN employees e ON e.membership_id = a.approved_by_membership_id
        WHERE a.idea_id = $1`,
      [idea.id],
    );
    const implemented = awards.rows.some((a) => a.kind === 'implementation');
    const me = actor.membershipId;
    return {
      awards: awards.rows,
      effect: effect.rows[0] ?? null,
      effectMax: cfg.xpEffectMax,
      xpPerImplementation: cfg.xpPerImplementation,
      canApproveEffect:
        implemented && !effect.rowCount && me === idea.decision_owner_membership_id && me !== idea.author_membership_id && me !== idea.raised_by_membership_id,
    };
  });
}
