import { z } from 'zod';
import { assertStageTransition } from '../domain/lifecycle.ts';
import { conflict, forbidden } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { hashRequest, idempotent } from './idempotency.ts';
import { loadIdea, type IdeaRow } from './ideas.ts';
import { notify } from './notifications.ts';

/**
 * «Совет королевства» — the round table for one item (owner brief 2026-11-11, ADR-0012).
 *
 * The council is advice and history, never a vote that replaces authority:
 *   * any member who can see the item adds arguments for or against;
 *   * people other than the originators add recommendations (implement, pilot,
 *     clarify, reject with reasons, rework) and can record dissent;
 *   * the maintainer hands the item to the decision owner (stage → decision);
 *   * the decision itself, a question to the author and a pilot remain the
 *     existing workflow steps of the people the rules name.
 * Every entry is append-only and timestamped by the database.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const RECOMMENDATIONS = ['implement', 'pilot', 'clarify', 'reject', 'rework'] as const;
export const CouncilEntryInput = z
  .object({
    kind: z.enum(['argument_for', 'argument_against', 'recommendation', 'dissent']),
    recommendation: z.enum(RECOMMENDATIONS).optional(),
    body: text(3, 3000),
  })
  .strict()
  .refine((v) => (v.kind === 'recommendation') === !!v.recommendation, {
    message: 'Для рекомендации выберите вариант; у аргумента его нет',
    path: ['recommendation'],
  })
  .refine((v) => !['recommendation', 'dissent'].includes(v.kind) || v.body.length >= 10, {
    message: 'Обоснуйте рекомендацию или разногласие (от 10 символов)',
    path: ['body'],
  });
export const HandoffInput = z.object({ summary: text(10, 3000) }).strict();

const OPEN_STAGES = ['published', 'review', 'development', 'verification', 'decision'];
const isOriginator = (a: OrgActor, i: IdeaRow) => a.membershipId === i.author_membership_id || a.membershipId === i.raised_by_membership_id;

function assertDiscussable(i: IdeaRow) {
  if (!OPEN_STAGES.includes(i.stage)) throw conflict('Совет обсуждает только обращения на рассмотрении');
}

export function addEntry(db: Database, actor: OrgActor, number: number, input: z.infer<typeof CouncilEntryInput>, key?: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true);
    return idempotent(c, actor.userId, `council.entry:${idea.id}`, key, hashRequest(input), async () => {
      assertDiscussable(idea);
      if (input.kind === 'recommendation' && isOriginator(actor, idea)) {
        throw forbidden('Автор аргументирует за своё обращение, но рекомендацию дают другие участники');
      }
      const { rows } = await c.query<{ id: string; created_at: Date }>(
        `INSERT INTO council_entries (organization_id, idea_id, author_membership_id, kind, recommendation, body)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [actor.orgId, idea.id, actor.membershipId, input.kind, input.recommendation ?? null, input.body],
      );
      const entry = rows[0]!;
      await audit(c, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: `council.${input.kind}`,
        entityType: 'idea',
        entityId: idea.id,
        data: { entry: entry.id, recommendation: input.recommendation ?? null },
      });
      if (input.kind === 'recommendation' || input.kind === 'dissent') {
        await notify(c, actor, 'council_recommendation', idea.id, [idea.maintainer_membership_id, idea.decision_owner_membership_id], entry.id);
      }
      return { status: 201, body: { id: entry.id, kind: input.kind, recommendation: input.recommendation ?? null, createdAt: entry.created_at } };
    });
  });
}

/** The maintainer closes the discussion and hands the item to the decision owner. */
export function handoff(db: Database, actor: OrgActor, number: number, input: z.infer<typeof HandoffInput>, key?: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true);
    return idempotent(c, actor.userId, `council.handoff:${idea.id}`, key, hashRequest(input), async () => {
      if (actor.membershipId !== idea.maintainer_membership_id) throw forbidden('Передать решение может ведущий обращения');
      if (isOriginator(actor, idea)) throw forbidden('Своё обращение передаёт на решение не автор');
      if (!idea.decision_owner_membership_id) throw conflict('Не назначен ответственный за решение');
      if (idea.stage !== 'review') throw conflict('Передать на решение можно обращение на рассмотрении');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO council_entries (organization_id, idea_id, author_membership_id, kind, body)
         VALUES ($1, $2, $3, 'handoff', $4) RETURNING id`,
        [actor.orgId, idea.id, actor.membershipId, input.summary],
      );
      assertStageTransition(idea.stage, 'decision');
      await c.query(`UPDATE ideas SET stage = 'decision' WHERE id = $1`, [idea.id]);
      idea.stage = 'decision';
      await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'council.handoff', entityType: 'idea', entityId: idea.id, data: { entry: rows[0]!.id } });
      await notify(c, actor, 'council_handoff', idea.id, [idea.decision_owner_membership_id], rows[0]!.id);
      return { status: 201, body: { id: rows[0]!.id, stage: idea.stage } };
    });
  });
}

type Role = 'initiator' | 'recorded' | 'maintainer' | 'decision_owner' | 'implementer' | 'department_head' | 'pilot_owner' | 'member';

interface Seat {
  membershipId: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
  roles: Role[];
  headOf: string[];
  stance: 'for' | 'against' | 'mixed' | 'none' | (typeof RECOMMENDATIONS)[number] | 'dissent';
}

async function people(c: Client, ids: string[]) {
  const { rows } = await c.query<{ membership_id: string; display_name: string; job_title: string | null; department: string | null }>(
    `SELECT membership_id, display_name, job_title, department FROM employees
      WHERE organization_id = app_org_id() AND membership_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.membership_id, r]));
}

export async function getCouncil(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number);
    const ov = (
      await c.query(
        `SELECT o.number, o.kind, o.title, o.problem, o.proposal, o.stage, o.status, o.category, o.department,
                o.department_id AS "departmentId", o.author, o.raised_by AS "raisedBy", o.maintainer,
                o.decision_owner AS "decisionOwner", o.implementer, o.published_at AS "publishedAt",
                o.first_response_due_at AS "firstResponseDueAt", o.first_response_at AS "firstResponseAt",
                o.resolution_due_at AS "resolutionDueAt", o.overdue_first_response AS "overdueFirstResponse",
                o.overdue_resolution AS "overdueResolution"
           FROM idea_overview o WHERE o.id = $1`,
        [idea.id],
      )
    ).rows[0] as Record<string, unknown>;

    const entries = await c.query<{
      id: string;
      kind: string;
      recommendation: string | null;
      body: string;
      createdAt: Date;
      authorMembershipId: string;
      author: string;
    }>(
      `SELECT x.id, x.kind, x.recommendation, x.body, x.created_at AS "createdAt",
              x.author_membership_id AS "authorMembershipId", e.display_name AS author
         FROM council_entries x JOIN employees e ON e.membership_id = x.author_membership_id
        WHERE x.idea_id = $1 ORDER BY x.created_at, x.id`,
      [idea.id],
    );
    const heads = await c.query<{ head: string; name: string }>(
      `SELECT head_membership_id AS head, name FROM departments
        WHERE organization_id = app_org_id() AND active AND head_membership_id IS NOT NULL`,
    );
    const pilots = await c.query<{ owner: string }>('SELECT DISTINCT owner_membership_id AS owner FROM verifications WHERE idea_id = $1', [idea.id]);

    const seats = new Map<string, { roles: Set<Role>; headOf: string[] }>();
    const add = (id: string | null | undefined, role: Role, headOf?: string) => {
      if (!id) return;
      const s = seats.get(id) ?? { roles: new Set<Role>(), headOf: [] };
      s.roles.add(role);
      if (headOf) s.headOf.push(headOf);
      seats.set(id, s);
    };
    if (idea.raised_by_membership_id) {
      add(idea.raised_by_membership_id, 'initiator');
      add(idea.author_membership_id, 'recorded');
    } else add(idea.author_membership_id, 'initiator');
    add(idea.maintainer_membership_id, 'maintainer');
    add(idea.decision_owner_membership_id, 'decision_owner');
    add(idea.implementer_membership_id, 'implementer');
    for (const p of pilots.rows) add(p.owner, 'pilot_owner');
    for (const h of heads.rows) add(h.head, 'department_head', h.name);
    for (const e of entries.rows) add(e.authorMembershipId, 'member');

    const who = await people(c, [...seats.keys()]);
    const stanceOf = (id: string): Seat['stance'] => {
      const mine = entries.rows.filter((e) => e.authorMembershipId === id && e.kind !== 'handoff');
      const last = [...mine].reverse().find((e) => e.kind === 'recommendation' || e.kind === 'dissent');
      if (last) return last.kind === 'dissent' ? 'dissent' : (last.recommendation as Seat['stance']);
      const pro = mine.some((e) => e.kind === 'argument_for');
      const con = mine.some((e) => e.kind === 'argument_against');
      return pro && con ? 'mixed' : pro ? 'for' : con ? 'against' : 'none';
    };
    const order: Role[] = ['initiator', 'recorded', 'maintainer', 'decision_owner', 'implementer', 'pilot_owner', 'department_head', 'member'];
    const list: Seat[] = [...seats.entries()]
      .map(([id, s]) => {
        const p = who.get(id);
        const roles = order.filter((r) => s.roles.has(r));
        // "member" only when no other role explains the seat.
        return {
          membershipId: id,
          name: p?.display_name ?? '—',
          jobTitle: p?.job_title ?? null,
          department: p?.department ?? null,
          roles: roles.length > 1 ? roles.filter((r) => r !== 'member') : roles,
          headOf: s.headOf,
          stance: stanceOf(id),
        };
      })
      .sort((a, b) => order.indexOf(a.roles[0]!) - order.indexOf(b.roles[0]!) || a.name.localeCompare(b.name, 'ru'));

    const decisions = await c.query(
      `SELECT d.outcome, d.rationale, d.created_at AS "createdAt", e.display_name AS "decidedBy"
         FROM decisions d JOIN employees e ON e.membership_id = d.decided_by_membership_id
        WHERE d.idea_id = $1 ORDER BY d.created_at`,
      [idea.id],
    );
    const questions = await c.query(
      `SELECT r.body, r.state, r.created_at AS "createdAt", e.display_name AS author
         FROM reviews r JOIN employees e ON e.membership_id = r.author_membership_id
        WHERE r.idea_id = $1 AND r.kind = 'request_changes' ORDER BY r.created_at`,
      [idea.id],
    );
    const similar = await c.query(
      `SELECT o.number, o.title, o.status FROM idea_overview o
        WHERE o.organization_id = app_org_id() AND o.id <> $1 AND similarity(o.title, $2) > 0.25
        ORDER BY similarity(o.title, $2) DESC LIMIT 3`,
      [idea.id, ov.title],
    );

    const me = actor.membershipId;
    const open = OPEN_STAGES.includes(idea.stage);
    const originator = isOriginator(actor, idea);
    return {
      item: ov,
      seats: list,
      entries: entries.rows.map(({ authorMembershipId, ...e }) => ({ ...e, authorMembershipId, mine: authorMembershipId === me })),
      decisions: decisions.rows,
      questions: questions.rows,
      similar: similar.rows,
      can: {
        argue: open,
        recommend: open && !originator,
        handoff: open && idea.stage === 'review' && me === idea.maintainer_membership_id && !originator && !!idea.decision_owner_membership_id
          && idea.decision_owner_membership_id !== me,
        askAuthor: open && !originator && ['published', 'review', 'development', 'decision'].includes(idea.stage)
          && (me === idea.maintainer_membership_id || me === idea.decision_owner_membership_id),
        pilot: open && !originator && idea.stage === 'review' && me === idea.maintainer_membership_id,
        decide: open && !originator && ['review', 'decision'].includes(idea.stage) && me === idea.decision_owner_membership_id,
      },
    };
  });
}

/** Items in front of the council: everything under consideration that the viewer may see. */
export async function listCouncil(db: Database, actor: OrgActor) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT o.number, o.title, o.status, o.department, coalesce(o.raised_by, o.author) AS initiator,
              o.maintainer, o.decision_owner AS "decisionOwner",
              (o.decision_owner_membership_id = app_membership_id()) AS "iDecide",
              (o.maintainer_membership_id = app_membership_id()) AS "iLead",
              o.first_response_due_at AS "firstResponseDueAt", o.resolution_due_at AS "resolutionDueAt",
              o.overdue_first_response AS "overdueFirstResponse", o.overdue_resolution AS "overdueResolution",
              count(x.id) FILTER (WHERE x.kind = 'argument_for')::int AS "for",
              count(x.id) FILTER (WHERE x.kind = 'argument_against')::int AS "against",
              count(x.id) FILTER (WHERE x.kind = 'recommendation')::int AS recommendations,
              count(x.id) FILTER (WHERE x.kind = 'dissent')::int AS dissent
         FROM idea_overview o LEFT JOIN council_entries x ON x.idea_id = o.id
        WHERE o.organization_id = app_org_id() AND o.stage IN ('published','review','development','verification','decision')
        GROUP BY o.id, o.number, o.title, o.status, o.department, o.raised_by, o.author, o.maintainer, o.decision_owner,
                 o.decision_owner_membership_id, o.maintainer_membership_id, o.first_response_due_at, o.resolution_due_at,
                 o.overdue_first_response, o.overdue_resolution, o.published_at
        ORDER BY CASE o.status WHEN 'decision' THEN 0 WHEN 'in_verification' THEN 1 WHEN 'in_review' THEN 2 WHEN 'needs_info' THEN 3 ELSE 4 END,
                 o.published_at
        LIMIT 200`,
    );
    return rows;
  });
}

