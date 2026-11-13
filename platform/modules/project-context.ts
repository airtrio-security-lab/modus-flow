import { z } from 'zod';
import { AppError, conflict, forbidden } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { norm, skillMatches } from './advisor.ts';
import { orgTx } from './context.ts';
import { hashRequest, idempotent } from './idempotency.ts';
import { loadIdea, type IdeaRow } from './ideas.ts';

import { AffectedInput, ContextFields, ContextInput, WORK_STAGES, WORK_STAGE_NAMES, type ContextInputT, type WorkStage } from '../domain/project-context.ts';

/** Server side of «Где возникла проблема?» (ADR-0031); the fields and their meaning are in domain/project-context.ts. */
export { AffectedInput, ContextFields, ContextInput, WORK_STAGES, WORK_STAGE_NAMES, type ContextInputT, type WorkStage };

const isItemPerson = (actor: OrgActor, idea: Pick<IdeaRow, 'author_membership_id' | 'raised_by_membership_id' | 'maintainer_membership_id' | 'decision_owner_membership_id'>) =>
  [idea.author_membership_id, idea.raised_by_membership_id, idea.maintainer_membership_id, idea.decision_owner_membership_id].includes(actor.membershipId);

async function insertAffected(c: Client, actor: OrgActor, idea: { id: string; department_id: string | null }, ids: string[]): Promise<string[]> {
  const added: string[] = [];
  for (const departmentId of [...new Set(ids)]) {
    if (departmentId === idea.department_id) {
      throw new AppError('validation_failed', 'Это подразделение уже отвечает за обращение — в «затронутые» добавляют другие');
    }
    const ok = await c.query('SELECT 1 FROM departments WHERE id = $1 AND organization_id = app_org_id() AND active', [departmentId]);
    if (!ok.rowCount) throw new AppError('validation_failed', 'Затронутое подразделение не найдено среди действующих');
    const r = await c.query(
      `INSERT INTO idea_affected_departments (organization_id, idea_id, department_id, added_by_membership_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [actor.orgId, idea.id, departmentId, actor.membershipId],
    );
    if (r.rowCount) added.push(departmentId);
  }
  return added;
}

/** Inside the caller's transaction: used when the item is created and when the context is added later. */
export async function saveContext(c: Client, actor: OrgActor, idea: { id: string; department_id: string | null }, input: ContextInputT): Promise<void> {
  if (input.project || input.workStage) {
    await c.query(
      `INSERT INTO idea_contexts (idea_id, organization_id, project_ref, work_stage, created_by_membership_id) VALUES ($1, $2, $3, $4, $5)`,
      [idea.id, actor.orgId, input.project ?? null, input.workStage ?? null, actor.membershipId],
    );
  }
  const added = input.affectedDepartmentIds?.length ? await insertAffected(c, actor, idea, input.affectedDepartmentIds) : [];
  await audit(c, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action: 'idea.context_set',
    entityType: 'idea',
    entityId: idea.id,
    // The project name is free text and may name a customer: the log keeps the fact, not the text.
    data: { project: Boolean(input.project), workStage: input.workStage ?? null, affected: added.length },
  });
}

/** The context of an item filed without one (for example from the Warrior Hall). Written once. */
export function setContext(db: Database, actor: OrgActor, number: number, input: ContextInputT, key?: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true);
    return idempotent(c, actor.userId, `idea.context:${idea.id}`, key, hashRequest(input), async () => {
      if (!isItemPerson(actor, idea)) throw forbidden('Контекст указывает автор обращения, его ведущий или ответственный за решение');
      if (input.project || input.workStage) {
        const exists = await c.query('SELECT 1 FROM idea_contexts WHERE idea_id = $1', [idea.id]);
        if (exists.rowCount) throw conflict('Проект и этап работы для этого обращения уже указаны и не меняются');
      }
      await saveContext(c, actor, idea, input);
      return { status: 201, body: await loadContext(c, idea.id) };
    });
  });
}

/** Names one more department the problem touches. It gives that department no rights over the item. */
export function addAffected(db: Database, actor: OrgActor, number: number, input: z.infer<typeof AffectedInput>, key?: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true);
    return idempotent(c, actor.userId, `idea.affected:${idea.id}:${input.departmentId}`, key, hashRequest(input), async () => {
      if (!isItemPerson(actor, idea)) throw forbidden('Затронутые подразделения отмечает автор обращения, его ведущий или ответственный за решение');
      if (idea.stage === 'closed') throw conflict('Обращение закрыто');
      const added = await insertAffected(c, actor, idea, [input.departmentId]);
      if (added.length) {
        await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'idea.affected_added', entityType: 'idea', entityId: idea.id, data: { department: input.departmentId } });
      }
      return { status: added.length ? 201 : 200, body: await loadContext(c, idea.id) };
    });
  });
}

export interface ItemContext {
  project: string | null;
  workStage: WorkStage | null;
  workStageName: string | null;
  setBy: string | null;
  setAt: string | null;
  affected: { id: string; name: string; addedBy: string; at: string }[];
}

export async function loadContext(c: Client, ideaId: string): Promise<ItemContext> {
  const ctx = (
    await c.query<{ project_ref: string | null; work_stage: WorkStage | null; by: string; created_at: Date }>(
      `SELECT x.project_ref, x.work_stage, e.display_name AS by, x.created_at
         FROM idea_contexts x JOIN employees e ON e.membership_id = x.created_by_membership_id WHERE x.idea_id = $1`,
      [ideaId],
    )
  ).rows[0];
  const affected = await c.query<{ id: string; name: string; addedBy: string; at: Date }>(
    `SELECT d.id, d.name, e.display_name AS "addedBy", a.created_at AS at
       FROM idea_affected_departments a JOIN departments d ON d.id = a.department_id
       JOIN employees e ON e.membership_id = a.added_by_membership_id
      WHERE a.idea_id = $1 ORDER BY a.created_at, d.name`,
    [ideaId],
  );
  return {
    project: ctx?.project_ref ?? null,
    workStage: ctx?.work_stage ?? null,
    workStageName: ctx?.work_stage ? WORK_STAGE_NAMES[ctx.work_stage] : null,
    setBy: ctx?.by ?? null,
    setAt: ctx?.created_at.toISOString() ?? null,
    affected: affected.rows.map((r) => ({ ...r, at: r.at.toISOString() })),
  };
}

/**
 * Who could be invited to discuss a problem that touches several departments: the heads of the
 * affected departments for everybody who sees the item, and — for its lead and decision owner only,
 * like the executor suggestions — colleagues of those departments whose own questionnaire names a
 * matching skill. A suggestion, by rules, «без ИИ»: nobody is invited or assigned by it.
 */
export async function suggestSpecialists(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number);
    const ctx = await loadContext(c, idea.id);
    const ids = ctx.affected.map((a) => a.id);
    if (!ids.length) return { method: 'rules' as const, affected: [], heads: [], specialists: [], canSeeSkills: false, note: 'Затронутые подразделения не отмечены.' };
    const heads = await c.query<{ membershipId: string; name: string; jobTitle: string | null; department: string }>(
      `SELECT e.membership_id AS "membershipId", e.display_name AS name, e.job_title AS "jobTitle", d.name AS department
         FROM departments d JOIN employees e ON e.membership_id = d.head_membership_id
        WHERE d.id = ANY($1::uuid[]) AND d.organization_id = app_org_id() ORDER BY d.name`,
      [ids],
    );
    const leads = actor.membershipId === idea.maintainer_membership_id || actor.membershipId === idea.decision_owner_membership_id;
    let specialists: { membershipId: string; name: string; jobTitle: string | null; department: string | null; matched: string[] }[] = [];
    if (leads) {
      const t = (
        await c.query<{ text: string }>(
          `SELECT concat_ws(' ', r.title, r.problem, r.proposal) AS text FROM idea_revisions r WHERE r.idea_id = $1 AND r.status = 'current'`,
          [idea.id],
        )
      ).rows[0]?.text ?? '';
      const hay = norm(t);
      const people = await c.query<{ membershipId: string; name: string; jobTitle: string | null; department: string | null; skills: string[] }>(
        `SELECT e.membership_id AS "membershipId", e.display_name AS name, e.job_title AS "jobTitle", e.department, p.skills
           FROM employee_profiles p JOIN employees e ON e.membership_id = p.membership_id
          WHERE e.organization_id = app_org_id() AND e.department = ANY($1::text[])
            AND e.membership_id <> ALL($2::uuid[])`,
        [ctx.affected.map((a) => a.name), [idea.author_membership_id, ...heads.rows.map((h) => h.membershipId)]],
      );
      specialists = people.rows
        .map((p) => ({ membershipId: p.membershipId, name: p.name, jobTitle: p.jobTitle, department: p.department, matched: p.skills.filter((s) => skillMatches(s, hay)) }))
        .filter((p) => p.matched.length)
        .slice(0, 8);
    }
    return {
      method: 'rules' as const,
      affected: ctx.affected.map((a) => ({ id: a.id, name: a.name })),
      heads: heads.rows,
      specialists,
      canSeeSkills: leads,
      note: 'Подсказка по правилам, без ИИ: руководители затронутых подразделений и коллеги, указавшие подходящий навык в своей анкете. Приглашает и назначает только человек с такими правами.',
    };
  });
}
