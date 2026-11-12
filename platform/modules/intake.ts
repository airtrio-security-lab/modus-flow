import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import { SOURCE_CHANNELS, type OrgActor } from '../domain/model.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { hashRequest, idempotent, type IdempotentResult } from './idempotency.ts';
import { membersWithRoles, notify } from './notifications.ts';
import { ContextFields, type ContextInputT } from '../domain/project-context.ts';
import { saveContext } from './project-context.ts';

/**
 * Intake: the single way an item enters the organization — quick submission,
 * recording on someone's behalf from a meeting / e-mail / call, or publishing a
 * private Lab draft. Routing (who is responsible, deadlines) is decided by the
 * database at insert time (migration 0004) and cannot be chosen by the client.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const SubmitInput = z
  .object({
    kind: z.enum(['idea', 'problem']),
    title: text(3, 160),
    problem: text(20, 5000),
    proposal: text(20, 5000).optional(),
    successCriteria: text(10, 3000).optional(),
    categoryId: z.uuid().optional(),
    departmentId: z.uuid().optional(),
    sourceChannel: z.enum(SOURCE_CHANNELS).default('app'),
    sourceNote: text(1, 300).optional(),
    raisedBy: z.uuid().optional(),
    // «Где возникла проблема?» (ADR-0031): optional, never required for an ordinary idea.
    context: z.object(ContextFields).strict().optional(),
  })
  .strict()
  .refine((v) => v.kind === 'problem' || !!v.proposal, { message: 'Для идеи опишите предлагаемое решение', path: ['proposal'] })
  .refine((v) => !v.raisedBy || v.sourceChannel !== 'app', {
    message: 'Укажите, откуда вопрос (совещание, почта, звонок...), если фиксируете его со слов коллеги',
    path: ['sourceChannel'],
  });
export type SubmitInputT = z.infer<typeof SubmitInput>;

export interface ItemContent {
  kind: 'idea' | 'problem';
  title: string;
  problem: string;
  proposal: string | null;
  successCriteria: string | null;
  categoryId?: string;
  departmentId?: string;
  sourceChannel?: (typeof SOURCE_CHANNELS)[number];
  sourceNote?: string;
  raisedBy?: string;
  context?: ContextInputT;
}

export interface CreatedItem {
  id: string;
  number: number;
  title: string;
  stage: string;
  status: string;
  routed: boolean;
  maintainer: string | null;
  decisionOwner: string | null;
  firstResponseDueAt: string | null;
}

/** Creates idea + revision 1 + contributions + audit + notifications inside the caller's transaction. */
export async function createItem(c: Client, actor: OrgActor, item: ItemContent): Promise<CreatedItem> {
  if (item.raisedBy === actor.membershipId) {
    throw new AppError('validation_failed', 'Если вопрос ваш — подайте его от своего имени без поля «поднял вопрос»');
  }
  const num = await c.query<{ n: number }>('SELECT app_next_idea_number($1) AS n', [actor.orgId]);
  const number = num.rows[0]!.n;
  const ins = await c.query<{
    id: string;
    stage: string;
    maintainer_membership_id: string | null;
    decision_owner_membership_id: string | null;
    routing_rule_id: string | null;
    first_response_due_at: Date | null;
  }>(
    `INSERT INTO ideas (organization_id, number, kind, author_membership_id, category_id, department_id,
                        source_channel, source_note, raised_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, stage, maintainer_membership_id, decision_owner_membership_id, routing_rule_id, first_response_due_at`,
    [
      actor.orgId,
      number,
      item.kind,
      actor.membershipId,
      item.categoryId ?? null,
      item.departmentId ?? null,
      item.sourceChannel ?? 'app',
      item.sourceNote ?? null,
      item.raisedBy ?? null,
    ],
  );
  const idea = ins.rows[0]!;
  await c.query(
    `INSERT INTO idea_revisions (organization_id, idea_id, number, author_membership_id, origin, title, problem, proposal, success_criteria, status)
     VALUES ($1, $2, 1, $3, 'publication', $4, $5, $6, $7, 'current')`,
    [actor.orgId, idea.id, actor.membershipId, item.title, item.problem, item.proposal, item.successCriteria],
  );
  await c.query(
    `INSERT INTO contributions (organization_id, membership_id, idea_id, kind, source_type, source_id)
     VALUES ($1, $2, $3, 'authorship', 'idea', $3)`,
    [actor.orgId, actor.membershipId, idea.id],
  );
  if (item.raisedBy) {
    // The colleague who raised the question gets permanent credit for spotting it.
    await c.query(
      `INSERT INTO contributions (organization_id, membership_id, idea_id, kind, source_type, source_id)
       VALUES ($1, $2, $3, 'issue_found', 'idea', $3)`,
      [actor.orgId, item.raisedBy, idea.id],
    );
  }
  await audit(c, {
    orgId: actor.orgId,
    actorUserId: actor.userId,
    action: 'idea.published',
    entityType: 'idea',
    entityId: idea.id,
    data: {
      number,
      revision: 1,
      channel: item.sourceChannel ?? 'app',
      routingRule: idea.routing_rule_id,
      routed: idea.maintainer_membership_id !== null,
    },
  });

  if (item.context && (item.context.project || item.context.workStage || item.context.affectedDepartmentIds?.length)) {
    // The department responsible for routing is whatever the routing rules chose, not what the form says.
    const dep = await c.query<{ department_id: string | null }>('SELECT department_id FROM ideas WHERE id = $1', [idea.id]);
    await saveContext(c, actor, { id: idea.id, department_id: dep.rows[0]?.department_id ?? null }, item.context);
  }

  const routed = idea.maintainer_membership_id !== null;
  const recipients = routed
    ? [idea.maintainer_membership_id, idea.decision_owner_membership_id]
    : await unroutedRecipients(c, actor.orgId);
  await notify(c, actor, 'idea_published', idea.id, recipients, idea.id);
  if (item.raisedBy) await notify(c, actor, 'raised_on_behalf', idea.id, [item.raisedBy], idea.id);

  return {
    id: idea.id,
    number,
    title: item.title,
    stage: idea.stage,
    status: routed ? 'in_review' : 'unrouted',
    routed,
    maintainer: idea.maintainer_membership_id,
    decisionOwner: idea.decision_owner_membership_id,
    firstResponseDueAt: idea.first_response_due_at?.toISOString() ?? null,
  };
}

/** Unrouted items go to every lead and to the organization's escalation contact — never to nobody. */
async function unroutedRecipients(c: Client, orgId: string): Promise<string[]> {
  const leads = await membersWithRoles(c, orgId, ['maintainer', 'decision_owner']);
  const esc = await c.query<{ m: string | null }>('SELECT escalation_membership_id AS m FROM organizations WHERE id = $1', [orgId]);
  return [...leads, ...(esc.rows[0]?.m ? [esc.rows[0].m] : [])];
}

/** Quick submission or recording on someone's behalf. Idempotent with an Idempotency-Key. */
export async function submitItem(
  db: Database,
  actor: OrgActor,
  input: SubmitInputT,
  key?: string,
): Promise<IdempotentResult<{ item: CreatedItem }>> {
  return withTx(db, orgTx(actor), (c) =>
    idempotent(c, actor.userId, `idea.submit:${actor.orgId}`, key, hashRequest(input), async () => ({
      status: 201,
      body: {
        item: await createItem(c, actor, {
          kind: input.kind,
          title: input.title,
          problem: input.problem,
          proposal: input.proposal ?? null,
          successCriteria: input.successCriteria ?? null,
          categoryId: input.categoryId,
          departmentId: input.departmentId,
          sourceChannel: input.sourceChannel,
          sourceNote: input.sourceNote,
          raisedBy: input.raisedBy,
          context: input.context,
        }),
      },
    })),
  );
}
