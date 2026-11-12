import { z } from 'zod';
import { AppError, forbidden } from '../domain/errors.ts';
import type { OrgActor, OrgRole } from '../domain/model.ts';
import { withTx, type Database } from '../db/pool.ts';
import * as admin from './admin.ts';
import { orgTx } from './context.ts';
import { submitItem, type SubmitInputT } from './intake.ts';
import * as wf from './workflow.ts';

/**
 * Import of an external data set (0017, ADR-0022). Every row goes through the real services — the
 * same submission, routing by category, reviews and decisions as an item typed in by a person — so
 * the organizer's scenarios are checked against real APIs and not against a painted table.
 *
 * What is kept as given: the external id (A-007), type, category, priority and the conditional status.
 * What is never invented: XP. A row marked «Реализовано» in the set is brought to «в работе» only;
 * the castle grows only if the implementation is confirmed, and for demo data that confirmation is a
 * separate, explicitly requested and labelled step (`demoConfirm`).
 */
export const DatasetRow = z
  .object({
    id: z.string().regex(/^[A-Z]{1,3}-[0-9]{1,6}$/),
    type: z.string().min(1).max(80),
    category: z.string().min(2).max(80),
    author: z.string().min(1).max(120),
    priority: z.string().min(1).max(40),
    status: z.string().min(1).max(60),
    text: z.string().min(20).max(5000),
    owner: z.string().min(1).max(120),
    next: z.string().max(1000).default(''),
  })
  .strict();
export const DatasetFile = z.object({ dataset: z.string().regex(/^[a-z0-9-]{2,60}$/), title: z.string().max(200), source: z.string().max(300).optional(), items: z.array(DatasetRow).min(1).max(500) }).strict();
export type DatasetFileT = z.infer<typeof DatasetFile>;

/** Conditional statuses of the set → how far the real workflow is taken. */
const STATUS_STEPS: Record<string, 'new' | 'review' | 'needs_info' | 'work' | 'done' | 'rejected' | 'closed'> = {
  Новое: 'new',
  'На рассмотрении': 'review',
  'Ожидает уточнения': 'needs_info',
  'В работе': 'work',
  Реализовано: 'done',
  Отклонено: 'rejected',
  Закрыто: 'closed',
};
/** Which member answers for a role named in the set: by job title, among people who may lead items. */
const OWNER_HINTS: [RegExp, RegExp][] = [
  [/\bit\b|ит-/i, /(^|[\s(])ИТ([\s-]|$)|\bIT\b/i],
  [/продаж/i, /продаж/i],
  [/закуп/i, /закуп/i],
  [/проектир/i, /проектир/i],
  [/бухгалт/i, /бухгалт/i],
  [/направлен|подразделен|процесс|административ/i, /операционн/i],
];
const AUTHOR_HINTS: [RegExp, RegExp][] = [
  [/продаж/i, /продаж/i],
  [/закуп/i, /закуп/i],
  [/проектир/i, /проектир/i],
  [/проект/i, /инженер/i],
];

interface Member extends OrgActor {
  name: string;
  job: string | null;
  departmentId: string | null;
}
export interface ImportReport {
  dataset: string;
  imported: { id: string; number: number; routedBy: 'category_rule' | 'fallback'; status: string }[];
  skipped: string[];
  categoriesCreated: string[];
  rulesCreated: string[];
  demoConfirmed: string[];
}

const titleOf = (text: string) => {
  const first = text.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]+$/, '').trim();
  return first.length <= 120 ? first : `${first.slice(0, 117).trimEnd()}…`;
};

export async function importDataset(db: Database, actor: OrgActor, file: DatasetFileT, opts: { demoConfirm?: string[] } = {}): Promise<ImportReport> {
  if (!actor.roles.includes('org_admin')) throw forbidden('Импорт набора данных доступен администратору организации');
  const unknown = file.items.filter((r) => !STATUS_STEPS[r.status]).map((r) => `${r.id}: «${r.status}»`);
  if (unknown.length) throw new AppError('validation_failed', `Неизвестные условные статусы: ${unknown.join(', ')}`);
  const ids = new Set(file.items.map((r) => r.id));
  if (ids.size !== file.items.length) throw new AppError('validation_failed', 'В наборе повторяются идентификаторы');

  const base = await withTx(db, orgTx(actor), async (c) => {
    const members = (
      await c.query<{ id: string; user_id: string; name: string; job: string | null; department: string | null; roles: OrgRole[] }>(
        `SELECT membership_id AS id, user_id, display_name AS name, job_title AS job, department, roles FROM employees
          WHERE organization_id = app_org_id() AND status = 'active' AND access = 'member' ORDER BY created_at`,
      )
    ).rows.map<Member>((m) => ({ userId: m.user_id, orgId: actor.orgId, membershipId: m.id, roles: m.roles, access: 'member', name: m.name, job: m.job, departmentId: m.department }));
    const done = (await c.query<{ external_id: string }>('SELECT external_id FROM dataset_items WHERE organization_id = app_org_id() AND dataset = $1', [file.dataset])).rows.map((r) => r.external_id);
    const categories = (await c.query<{ id: string; name: string }>('SELECT id, name FROM categories WHERE organization_id = app_org_id()')).rows;
    const ruled = (await c.query<{ category_id: string }>('SELECT DISTINCT category_id FROM routing_rules WHERE organization_id = app_org_id() AND active AND category_id IS NOT NULL')).rows.map((r) => r.category_id);
    const departments = new Map((await c.query<{ id: string; name: string }>('SELECT id, name FROM departments WHERE organization_id = app_org_id() AND active')).rows.map((d) => [d.name, d.id]));
    for (const m of members) m.departmentId = m.departmentId ? (departments.get(m.departmentId) ?? null) : null;
    return { members, done: new Set(done), categories: new Map(categories.map((x) => [x.name, x.id])), ruled: new Set(ruled) };
  });

  const leads = base.members.filter((m) => m.roles.includes('maintainer'));
  const deciders = base.members.filter((m) => m.roles.includes('decision_owner'));
  // The fallback owner: someone who may both lead and decide, preferring the organization's escalation contact's deputy role.
  const fallback = leads.find((m) => m.roles.includes('decision_owner') && /операционн/i.test(m.job ?? '')) ?? leads.find((m) => m.roles.includes('decision_owner')) ?? leads[0];
  if (!fallback || !deciders.length) throw new AppError('validation_failed', 'В организации нет сотрудников с правом вести обращения и принимать решения');
  const ownerFor = (role: string) => {
    for (const [re, job] of OWNER_HINTS) if (re.test(role)) return leads.find((m) => job.test(m.job ?? '')) ?? null;
    return null;
  };
  const plain = base.members.filter((m) => !m.roles.some((r) => r !== 'employee'));
  const authorFor = (role: string, not: string[]) => {
    const pool = plain.filter((m) => !not.includes(m.membershipId));
    for (const [re, job] of AUTHOR_HINTS) {
      const hit = re.test(role) ? pool.find((m) => job.test(m.job ?? '')) : undefined;
      if (hit) return hit;
    }
    return pool[0] ?? base.members.find((m) => !not.includes(m.membershipId))!;
  };

  const report: ImportReport = { dataset: file.dataset, imported: [], skipped: [], categoriesCreated: [], rulesCreated: [], demoConfirmed: [] };
  const key = (id: string, step: string) => `ds-${file.dataset}-${id}-${step}`;

  // Categories of the set and routing by category; where the organization has nobody for a role, the fallback path is used.
  for (const name of new Set(file.items.map((r) => r.category))) {
    if (base.categories.has(name)) continue;
    const created = await admin.createCategory(db, actor, { name, description: `Категория набора «${file.title}»`.slice(0, 500) });
    base.categories.set(name, created.id);
    report.categoriesCreated.push(name);
  }
  for (const row of file.items) {
    const categoryId = base.categories.get(row.category)!;
    const owner = ownerFor(row.owner);
    if (!owner || base.ruled.has(categoryId)) continue;
    await admin.createRule(db, actor, { categoryId, maintainer: owner.membershipId, decisionOwner: owner.roles.includes('decision_owner') ? owner.membershipId : fallback.membershipId });
    base.ruled.add(categoryId);
    report.rulesCreated.push(`${row.category} → ${owner.job ?? owner.name}`);
  }

  for (const row of file.items) {
    if (base.done.has(row.id)) {
      report.skipped.push(row.id);
      continue;
    }
    const categoryId = base.categories.get(row.category)!;
    const expected = ownerFor(row.owner) ?? fallback;
    const author = authorFor(row.author, [expected.membershipId, fallback.membershipId]);
    const kind = row.type === 'Проблема' ? 'problem' : 'idea';
    const input: SubmitInputT = {
      kind,
      title: titleOf(row.text),
      problem: row.text,
      ...(kind === 'idea' ? { proposal: row.next.length >= 20 ? row.next : row.text } : {}),
      categoryId,
      ...(author.departmentId ? { departmentId: author.departmentId } : {}),
      sourceChannel: 'app',
    };
    const number = (await submitItem(db, author, input, key(row.id, 'submit'))).body.item.number;
    const state = async () =>
      withTx(db, orgTx(actor), async (c) => {
        const { rows } = await c.query<{ id: string; m: string | null; d: string | null }>(
          'SELECT id, maintainer_membership_id AS m, decision_owner_membership_id AS d FROM ideas WHERE organization_id = app_org_id() AND number = $1',
          [number],
        );
        return rows[0]!;
      });
    let idea = await state();
    // A category with its own rule is routed by that rule; any other way to an owner — the author's department,
    // the organization's default, or the assignment below — is the fallback path (organizer's scenario 2).
    const routedBy: 'category_rule' | 'fallback' = base.ruled.has(categoryId) ? 'category_rule' : 'fallback';
    if (!idea.m) {
      // The fallback owner takes the unrouted item themself: assigning needs the right to lead, not the admin role.
      await wf.assign(db, fallback, number, { maintainer: fallback.membershipId, decisionOwner: fallback.membershipId }, key(row.id, 'assign'));
      idea = await state();
    } else if (!idea.d) {
      await wf.assign(db, fallback, number, { decisionOwner: fallback.membershipId }, key(row.id, 'assign'));
      idea = await state();
    }
    await withTx(db, orgTx(actor), (c) =>
      c.query('SELECT app_register_dataset_item($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [file.dataset, row.id, idea.id, row.type, row.category, row.priority, row.status, row.author, row.owner, row.next, routedBy]),
    );

    const lead = base.members.find((m) => m.membershipId === idea.m)!;
    const decider = base.members.find((m) => m.membershipId === idea.d) ?? fallback;
    const step = STATUS_STEPS[row.status]!;
    const next = row.next || 'Следующий шаг уточняется.';
    if (step === 'review') await wf.addReview(db, lead, number, { kind: 'comment', body: `Принято в рассмотрение. Следующий шаг: ${next}` }, key(row.id, 'review'));
    if (step === 'needs_info') await wf.addReview(db, lead, number, { kind: 'request_changes', body: `Нужно уточнение от автора. ${next}` }, key(row.id, 'ask'));
    if (step === 'work' || step === 'done') {
      await wf.addReview(db, lead, number, { kind: 'comment', body: `Берём в работу. ${next}` }, key(row.id, 'review'));
      await wf.decide(db, decider, number, { outcome: 'merge', rationale: `Решение по набору: взять в работу. ${next}`, implementer: lead.membershipId }, key(row.id, 'decide'));
    }
    if (step === 'rejected') await wf.decide(db, decider, number, { outcome: 'reject', rationale: `Отклонено с объяснением для автора. ${next}` }, key(row.id, 'decide'));
    if (step === 'closed') {
      await wf.addReview(db, lead, number, { kind: 'comment', body: `Спасибо за обратную связь. ${next}` }, key(row.id, 'review'));
      await wf.decide(db, decider, number, { outcome: 'close', rationale: `Закрыто без внедрения: действий не требуется. ${next}` }, key(row.id, 'decide'));
    }
    report.imported.push({ id: row.id, number, routedBy, status: row.status });
  }

  // The explicit demo confirmation: only rows given as «Реализовано», only on request, through the real completion step.
  for (const id of opts.demoConfirm ?? []) {
    const row = file.items.find((r) => r.id === id);
    if (!row || STATUS_STEPS[row.status] !== 'done') throw new AppError('validation_failed', `Демо-подтверждение возможно только для строк набора со статусом «Реализовано»: ${id}`);
    const done = await withTx(db, orgTx(actor), async (c) => {
      const { rows } = await c.query<{ number: number; impl: string | null; confirmed: Date | null; stage: string }>(
        `SELECT i.number, i.implementer_membership_id AS impl, d.demo_confirmed_at AS confirmed, i.stage
           FROM dataset_items d JOIN ideas i ON i.id = d.idea_id
          WHERE d.organization_id = app_org_id() AND d.dataset = $1 AND d.external_id = $2`,
        [file.dataset, id],
      );
      return rows[0];
    });
    if (!done || done.confirmed) continue;
    const who = base.members.find((m) => m.membershipId === done.impl) ?? fallback;
    if (done.stage === 'adoption') await wf.completeImplementation(db, who, done.number, { report: `ДЕМО-ПОДТВЕРЖДЕНИЕ для показа роста замка. В наборе организатора строка ${id} имеет условный статус «Реализовано»; фактического внедрения в компании не было.` }, key(id, 'demo-confirm'));
    await withTx(db, orgTx(actor), (c) => c.query('SELECT app_mark_dataset_demo_confirmed($1, $2)', [file.dataset, id]));
    report.demoConfirmed.push(id);
  }
  return report;
}

/** The set as the product sees it: original fields next to the item's real state. Visible like the items themselves. */
export async function listDataset(db: Database, actor: OrgActor, dataset: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT d.external_id AS "externalId", i.number, o.title, o.status, d.original_type AS "originalType", d.original_category AS "originalCategory",
              d.original_priority AS "originalPriority", d.original_status AS "originalStatus", d.original_author AS "originalAuthor",
              d.original_owner AS "originalOwner", d.routed_by AS "routedBy", d.demo_confirmed_at AS "demoConfirmedAt",
              (SELECT coalesce(sum(a.xp), 0)::int FROM xp_awards a WHERE a.idea_id = i.id) AS xp
         FROM dataset_items d JOIN ideas i ON i.id = d.idea_id
         JOIN idea_overview o ON o.id = i.id
        WHERE d.organization_id = app_org_id() AND d.dataset = $1 ORDER BY d.external_id`,
      [dataset],
    );
    return rows;
  });
}
export async function datasetOfItem(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT d.dataset, d.external_id AS "externalId", d.original_type AS "originalType", d.original_category AS "originalCategory", d.original_priority AS "originalPriority",
              d.original_status AS "originalStatus", d.original_author AS "originalAuthor", d.original_owner AS "originalOwner", d.routed_by AS "routedBy", d.demo_confirmed_at AS "demoConfirmedAt"
         FROM dataset_items d JOIN ideas i ON i.id = d.idea_id WHERE d.organization_id = app_org_id() AND i.number = $1`,
      [number],
    );
    return rows[0] ?? null;
  });
}
