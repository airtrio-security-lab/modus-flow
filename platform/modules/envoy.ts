import { forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { civilization } from '../domain/civilizations.ts';
import { ENVOY_EVENTS, ENVOY_NO_XP, ENVOY_RANKS, awardText, envoyRankFor, envoyRankName, rankUpText, type EnvoyEventKind, type EnvoyRankInfo } from '../domain/envoy.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { orgTx } from './context.ts';

/**
 * «Путь Посла» (ADR-0032): read side. The ledger (envoy_xp_awards) and the rank-ups are written only by
 * database triggers on confirmed events (migration 0020); this module reads them under the caller's RLS
 * and computes the rank. Nothing here writes XP, and nothing here is consulted for rights: a rank is a
 * picture and a word.
 */
export interface EnvoyAward {
  id: string;
  kind: EnvoyEventKind;
  xp: number;
  at: string;
  /** null when the viewer may not see the item any more. */
  number: number | null;
  title: string | null;
  /** «+20 XP — подтверждено внедрение обращения №126». */
  text: string;
}

export interface EnvoyCard extends EnvoyRankInfo {
  membershipId: string;
  /** The person (the envoy's owner); `name` is the rank's name. */
  personName: string;
  self: boolean;
  /** The envoy dresses in the style of the person's own department; a change of style changes clothes only. */
  civilization: string;
  civilizationName: string;
  department: string | null;
  xp: number;
  thresholds: number[];
  ranks: { rank: number; name: string; xp: number; attire: string; reachedAt: string | null; number: number | null }[];
  history: EnvoyAward[];
  /** The person's items: the envoys they sent (status as on the item card). */
  items: { number: number; title: string; status: string; xp: number }[];
  results: { implemented: number; effects: number };
  rules: { kind: EnvoyEventKind; label: string; xp: number; enabled: boolean }[];
  noXp: readonly string[];
}

async function thresholds(c: Client): Promise<number[]> {
  return (await c.query<{ t: number[] }>('SELECT envoy_rank_thresholds AS t FROM organizations WHERE id = app_org_id()')).rows[0]!.t;
}

async function eventXp(c: Client): Promise<Record<EnvoyEventKind, number>> {
  const r = (
    await c.query<{ resolution: number; implementation: number; effect: number }>(
      `SELECT envoy_xp_resolution AS resolution, envoy_xp_implementation AS implementation, envoy_xp_effect AS effect
         FROM organizations WHERE id = app_org_id()`,
    )
  ).rows[0]!;
  return r;
}

/** XP and rank of several people at once (the map). Rows the caller may not read count as nothing. */
export async function envoyRanks(c: Client, membershipIds: string[]): Promise<Map<string, { xp: number; rank: number }>> {
  const ids = [...new Set(membershipIds.filter(Boolean))];
  const out = new Map<string, { xp: number; rank: number }>();
  if (!ids.length) return out;
  const t = await thresholds(c);
  const { rows } = await c.query<{ id: string; xp: number }>(
    `SELECT membership_id AS id, coalesce(sum(xp), 0)::int AS xp FROM envoy_xp_awards
      WHERE organization_id = app_org_id() AND membership_id = ANY($1::uuid[]) GROUP BY membership_id`,
    [ids],
  );
  for (const id of ids) out.set(id, { xp: 0, rank: 1 });
  for (const r of rows) out.set(r.id, { xp: r.xp, rank: envoyRankFor(r.xp, t).rank });
  return out;
}

/** The style of each person's department (employees.department → departments.civilization). */
export async function envoyCivilizations(c: Client, membershipIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(membershipIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await c.query<{ id: string; civ: string | null }>(
    `SELECT e.membership_id AS id, d.civilization AS civ
       FROM employees e
       LEFT JOIN departments d ON d.organization_id = e.organization_id AND d.name = e.department AND d.active
      WHERE e.organization_id = app_org_id() AND e.membership_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, civilization(r.civ).id]));
}

export async function loadEnvoy(c: Client, actor: OrgActor, membershipId: string): Promise<EnvoyCard> {
  const self = membershipId === actor.membershipId;
  // Colleagues' envoys: to full members, exactly like the person card. A guest sees only their own.
  if (!self && actor.access !== 'member') throw forbidden('Карточки сотрудников доступны сотрудникам организации');
  const p = (
    await c.query<{ id: string; name: string; department: string | null }>(
      `SELECT membership_id AS id, display_name AS name, department FROM employees
        WHERE organization_id = app_org_id() AND membership_id = $1 AND status = 'active'`,
      [membershipId],
    )
  ).rows[0];
  if (!p) throw notFound('Сотрудник не найден');
  const t = await thresholds(c);
  const xpOf = await eventXp(c);
  const civ = (await envoyCivilizations(c, [p.id])).get(p.id) ?? civilization(null).id;
  const awards = await c.query<{ id: string; kind: EnvoyEventKind; xp: number; at: Date; number: number | null; title: string | null }>(
    `SELECT a.id, a.event_kind AS kind, a.xp, a.created_at AS at, o.number, o.title
       FROM envoy_xp_awards a LEFT JOIN idea_overview o ON o.id = a.idea_id
      WHERE a.organization_id = app_org_id() AND a.membership_id = $1
      ORDER BY a.created_at DESC, a.id`,
    [p.id],
  );
  const ups = await c.query<{ rank: number; at: Date; number: number | null }>(
    `SELECT u.rank, u.created_at AS at, o.number FROM envoy_rank_ups u LEFT JOIN idea_overview o ON o.id = u.idea_id
      WHERE u.organization_id = app_org_id() AND u.membership_id = $1 ORDER BY u.rank`,
    [p.id],
  );
  const items = await c.query<{ number: number; title: string; status: string; xp: number }>(
    `SELECT o.number, o.title, o.status,
            (SELECT coalesce(sum(a.xp), 0)::int FROM envoy_xp_awards a WHERE a.idea_id = o.id AND a.membership_id = $1) AS xp
       FROM idea_overview o
      WHERE o.organization_id = app_org_id() AND coalesce(o.raised_by_membership_id, o.author_membership_id) = $1
      ORDER BY o.published_at DESC LIMIT 50`,
    [p.id],
  );
  const xp = awards.rows.reduce((s, a) => s + a.xp, 0);
  const info = envoyRankFor(xp, t);
  const reached = new Map(ups.rows.map((u) => [u.rank, u]));
  return {
    ...info,
    membershipId: p.id,
    personName: p.name,
    self,
    civilization: civ,
    civilizationName: civilization(civ).name,
    department: p.department,
    xp,
    thresholds: t,
    ranks: ENVOY_RANKS.map((r, i) => ({
      rank: r.rank,
      name: r.name,
      xp: t[i]!,
      attire: r.attire,
      reachedAt: r.rank === 1 ? null : (reached.get(r.rank)?.at.toISOString() ?? null),
      number: reached.get(r.rank)?.number ?? null,
    })),
    history: awards.rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      xp: a.xp,
      at: a.at.toISOString(),
      number: a.number,
      title: a.title,
      text: a.number === null ? `+${a.xp} XP — ${ENVOY_EVENTS[a.kind].label} (обращение вам недоступно)` : awardText(a.kind, a.xp, a.number),
    })),
    items: items.rows,
    results: {
      implemented: awards.rows.filter((a) => a.kind === 'implementation').length,
      effects: awards.rows.filter((a) => a.kind === 'effect').length,
    },
    rules: (Object.keys(ENVOY_EVENTS) as EnvoyEventKind[]).map((k) => ({ kind: k, label: ENVOY_EVENTS[k].label, xp: xpOf[k], enabled: ENVOY_EVENTS[k].enabled })),
    noXp: ENVOY_NO_XP,
  };
}

export interface PendingRankUp {
  notificationId: string;
  rank: number;
  name: string;
  text: string;
  number: number | null;
  at: string;
}

/**
 * The person's own envoy, with the rank-up they have not seen yet. «Seen» is the existing notification
 * read mark: the card closes by POST /notifications/read, which awards nothing.
 */
export async function myEnvoy(db: Database, actor: OrgActor): Promise<EnvoyCard & { pending: PendingRankUp | null }> {
  return withTx(db, orgTx(actor), async (c) => {
    const card = await loadEnvoy(c, actor, actor.membershipId);
    const n = (
      await c.query<{ id: string; dedupe_key: string; number: number | null; created_at: Date }>(
        `SELECT n.id, n.dedupe_key, i.number, n.created_at FROM notifications n LEFT JOIN ideas i ON i.id = n.idea_id
          WHERE n.recipient_membership_id = app_membership_id() AND n.event_type = 'envoy_rank_up' AND n.read_at IS NULL
          ORDER BY n.created_at DESC LIMIT 1`,
      )
    ).rows[0];
    const rank = n ? Number(n.dedupe_key.split(':').pop()) : NaN;
    // Only a rank-up that is really recorded is announced, never one computed ahead.
    const recorded = n && Number.isInteger(rank) && card.ranks.find((r) => r.rank === rank)?.reachedAt;
    return {
      ...card,
      pending: recorded
        ? { notificationId: n.id, rank, name: envoyRankName(rank), text: rankUpText(rank), number: n.number, at: n.created_at.toISOString() }
        : null,
    };
  });
}

export async function envoyOf(db: Database, actor: OrgActor, membershipId: string): Promise<EnvoyCard> {
  return withTx(db, orgTx(actor), (c) => loadEnvoy(c, actor, membershipId));
}
