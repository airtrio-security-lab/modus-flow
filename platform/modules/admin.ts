import { z } from 'zod';
import { forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';

/**
 * Organization administration: departments, categories, routing rules and
 * deadline settings. Writes need org_admin (enforced by RLS too); reads are
 * open to members because the submission form needs the lists.
 * Nothing is deleted — entries are deactivated, so history keeps its labels.
 */
const name = (min: number, max: number) => z.string().trim().min(min).max(max);

export const DepartmentInput = z.object({ name: name(2, 120), head: z.uuid().nullable().optional(), active: z.boolean().optional() }).strict();
export const CategoryInput = z
  .object({ name: name(2, 80), description: name(1, 500).nullable().optional(), sortOrder: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional() })
  .strict();
export const RuleInput = z
  .object({
    categoryId: z.uuid().nullable().optional(),
    departmentId: z.uuid().nullable().optional(),
    priority: z.number().int().min(1).max(1000).optional(),
    maintainer: z.uuid(),
    decisionOwner: z.uuid().nullable().optional(),
    escalateTo: z.uuid().nullable().optional(),
    firstResponseHours: z.number().int().min(1).max(720).nullable().optional(),
    resolutionDays: z.number().int().min(1).max(365).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export const SettingsInput = z
  .object({
    defaultFirstResponseHours: z.number().int().min(1).max(720).optional(),
    defaultResolutionDays: z.number().int().min(1).max(365).optional(),
    staleDays: z.number().int().min(1).max(90).optional(),
    escalationMembershipId: z.uuid().nullable().optional(),
  })
  .strict();

const isAdmin = (a: OrgActor) => a.access === 'member' && a.roles.includes('org_admin');
const requireAdmin = (a: OrgActor) => {
  if (!isAdmin(a)) throw forbidden('Только администратор организации');
};
const log = (c: Client, a: OrgActor, action: string, type: string, id: string, data: Record<string, unknown> = {}) =>
  audit(c, { orgId: a.orgId, actorUserId: a.userId, action, entityType: type, entityId: id, data });

/** Everything the submission form and admin screens need, in one call. */
export async function getDirectory(db: Database, actor: OrgActor) {
  return withTx(db, orgTx(actor), async (c) => {
    const departments = await c.query(
      `SELECT d.id, d.name, d.active, d.head_membership_id AS "headMembershipId", e.display_name AS head
         FROM departments d LEFT JOIN employees e ON e.membership_id = d.head_membership_id
        WHERE d.organization_id = app_org_id() ORDER BY d.name`,
    );
    const categories = await c.query(
      `SELECT id, name, description, sort_order AS "sortOrder", active FROM categories
        WHERE organization_id = app_org_id() ORDER BY sort_order, name`,
    );
    const members = await c.query(
      `SELECT membership_id AS "membershipId", display_name AS name, department, job_title AS "jobTitle", roles, access
         FROM employees WHERE organization_id = app_org_id() AND status = 'active' ORDER BY display_name`,
    );
    const settings = await c.query(
      `SELECT default_first_response_hours AS "defaultFirstResponseHours", default_resolution_days AS "defaultResolutionDays",
              stale_days AS "staleDays", escalation_membership_id AS "escalationMembershipId"
         FROM organizations WHERE id = app_org_id()`,
    );
    // Guests (invited reviewers) do not need organization settings.
    const full = actor.access === 'member';
    return { departments: departments.rows, categories: categories.rows, members: members.rows, settings: full ? (settings.rows[0] ?? null) : null };
  });
}

export async function listRules(db: Database, actor: OrgActor) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT r.id, r.priority, r.active, r.category_id AS "categoryId", c.name AS category,
              r.department_id AS "departmentId", d.name AS department,
              r.maintainer_membership_id AS "maintainer", em.display_name AS "maintainerName",
              r.decision_owner_membership_id AS "decisionOwner", ed.display_name AS "decisionOwnerName",
              r.escalate_to_membership_id AS "escalateTo", ee.display_name AS "escalateToName",
              r.first_response_hours AS "firstResponseHours", r.resolution_days AS "resolutionDays"
         FROM routing_rules r
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN departments d ON d.id = r.department_id
         LEFT JOIN employees em ON em.membership_id = r.maintainer_membership_id
         LEFT JOIN employees ed ON ed.membership_id = r.decision_owner_membership_id
         LEFT JOIN employees ee ON ee.membership_id = r.escalate_to_membership_id
        WHERE r.organization_id = app_org_id()
        ORDER BY r.active DESC, (r.category_id IS NOT NULL)::int + (r.department_id IS NOT NULL)::int DESC, r.priority`,
    );
    return rows;
  });
}

export async function createDepartment(db: Database, actor: OrgActor, input: z.infer<typeof DepartmentInput>) {
  requireAdmin(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO departments (organization_id, name, head_membership_id, active) VALUES ($1, $2, $3, $4) RETURNING id',
      [actor.orgId, input.name, input.head ?? null, input.active ?? true],
    );
    await log(c, actor, 'admin.department_created', 'department', rows[0]!.id, { name: input.name });
    return { id: rows[0]!.id };
  });
}

export async function updateDepartment(db: Database, actor: OrgActor, id: string, input: Partial<z.infer<typeof DepartmentInput>>) {
  requireAdmin(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const { rowCount } = await c.query(
      `UPDATE departments SET name = coalesce($2, name),
              head_membership_id = CASE WHEN $3::boolean THEN $4::uuid ELSE head_membership_id END,
              active = coalesce($5, active)
        WHERE id = $1 AND organization_id = app_org_id()`,
      [id, input.name ?? null, input.head !== undefined, input.head ?? null, input.active ?? null],
    );
    if (!rowCount) throw notFound('Подразделение не найдено');
    await log(c, actor, 'admin.department_updated', 'department', id, input as Record<string, unknown>);
    return { id };
  });
}

export async function createCategory(db: Database, actor: OrgActor, input: z.infer<typeof CategoryInput>) {
  requireAdmin(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO categories (organization_id, name, description, sort_order, active) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [actor.orgId, input.name, input.description ?? null, input.sortOrder ?? 100, input.active ?? true],
    );
    await log(c, actor, 'admin.category_created', 'category', rows[0]!.id, { name: input.name });
    return { id: rows[0]!.id };
  });
}

export async function updateCategory(db: Database, actor: OrgActor, id: string, input: Partial<z.infer<typeof CategoryInput>>) {
  requireAdmin(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const { rowCount } = await c.query(
      `UPDATE categories SET name = coalesce($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              sort_order = coalesce($5, sort_order), active = coalesce($6, active)
        WHERE id = $1 AND organization_id = app_org_id()`,
      [id, input.name ?? null, input.description !== undefined, input.description ?? null, input.sortOrder ?? null, input.active ?? null],
    );
    if (!rowCount) throw notFound('Категория не найдена');
    await log(c, actor, 'admin.category_updated', 'category', id, input as Record<string, unknown>);
    return { id };
  });
}

export async function createRule(db: Database, actor: OrgActor, input: z.infer<typeof RuleInput>) {
  requireAdmin(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO routing_rules (organization_id, category_id, department_id, priority, maintainer_membership_id,
                                  decision_owner_membership_id, escalate_to_membership_id, first_response_hours, resolution_days, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        actor.orgId,
        input.categoryId ?? null,
        input.departmentId ?? null,
        input.priority ?? 100,
        input.maintainer,
        input.decisionOwner ?? null,
        input.escalateTo ?? null,
        input.firstResponseHours ?? null,
        input.resolutionDays ?? null,
        input.active ?? true,
      ],
    );
    await log(c, actor, 'admin.rule_created', 'routing_rule', rows[0]!.id, input as Record<string, unknown>);
    return { id: rows[0]!.id };
  });
}

/** Rules are never deleted: deactivate to stop using one; past items keep a reference to it. */
export async function setRuleActive(db: Database, actor: OrgActor, id: string, active: boolean) {
  requireAdmin(actor);
  return withTx(db, orgTx(actor), async (c) => {
    const { rowCount } = await c.query('UPDATE routing_rules SET active = $2 WHERE id = $1 AND organization_id = app_org_id()', [id, active]);
    if (!rowCount) throw notFound('Правило не найдено');
    await log(c, actor, active ? 'admin.rule_activated' : 'admin.rule_deactivated', 'routing_rule', id);
    return { id, active };
  });
}

export async function updateSettings(db: Database, actor: OrgActor, input: z.infer<typeof SettingsInput>) {
  requireAdmin(actor);
  return withTx(db, orgTx(actor), async (c) => {
    await c.query(
      `UPDATE organizations SET
          default_first_response_hours = coalesce($2, default_first_response_hours),
          default_resolution_days = coalesce($3, default_resolution_days),
          stale_days = coalesce($4, stale_days),
          escalation_membership_id = CASE WHEN $5::boolean THEN $6::uuid ELSE escalation_membership_id END
        WHERE id = $1`,
      [
        actor.orgId,
        input.defaultFirstResponseHours ?? null,
        input.defaultResolutionDays ?? null,
        input.staleDays ?? null,
        input.escalationMembershipId !== undefined,
        input.escalationMembershipId ?? null,
      ],
    );
    await log(c, actor, 'admin.settings_updated', 'organization', actor.orgId, input as Record<string, unknown>);
    return { ok: true };
  });
}
