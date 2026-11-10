import { z } from 'zod';
import { AppError, conflict, notFound } from '../domain/errors.ts';
import { failingForGate, type CheckGate } from '../domain/checks.ts';
import { assertStageTransition } from '../domain/lifecycle.ts';
import type { IdeaStage, NotificationEvent, OrgActor } from '../domain/model.ts';
import { authorize } from '../domain/policy.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { accessFacts, computeChecks, loadIdea, type IdeaRow } from './ideas.ts';
import { hashRequest, idempotent, type IdempotentResult } from './idempotency.ts';
import { notify } from './notifications.ts';

/**
 * Organization workflow: Maintainer review → change request → author objection
 * → new revision → field verification with positive and negative evidence →
 * decision. Every operation:
 *   1. runs in one transaction under tenant RLS,
 *   2. locks the idea row first, so concurrent operations on one idea are
 *      serialized and none can overwrite another's effect,
 *   3. is idempotent with an Idempotency-Key,
 *   4. checks the service policy; the database re-checks the critical rules
 *      (migration 0002) and keeps every record append-only.
 * Nothing here deletes or edits contributions, reviews, revisions, evidence or
 * decisions: history only grows.
 */

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const uuid = z.uuid();

export const AssignInput = z
  .object({ maintainer: uuid.optional(), decisionOwner: uuid.optional() })
  .strict()
  .refine((v) => v.maintainer || v.decisionOwner, 'Укажите maintainer и/или decisionOwner');
export const ReviewInput = z
  .object({
    kind: z.enum(['comment', 'request_changes', 'objection', 'approval', 'progress']),
    body: text(1, 5000),
    parentReviewId: uuid.optional(),
  })
  .strict()
  .refine((v) => (v.kind === 'objection') === !!v.parentReviewId, 'Возражение должно ссылаться на замечание (parentReviewId)');
export const ResolveInput = z.object({ outcome: z.enum(['resolved', 'withdrawn']), note: text(5, 3000) }).strict();
const RevisionBody = {
  baseRevision: z.number().int().positive(),
  title: text(3, 160),
  problem: text(20, 5000),
  proposal: text(20, 5000),
  successCriteria: text(10, 3000).optional(),
};
export const ReviseInput = z.object({ ...RevisionBody, rationale: text(5, 3000).optional() }).strict();
export const SuggestInput = z.object({ ...RevisionBody, rationale: text(10, 3000) }).strict();
export const SuggestionDecisionInput = z.object({ accept: z.boolean(), note: text(5, 3000).optional() }).strict();
export const StartVerificationInput = z
  .object({ plan: text(10, 5000), successCriteria: text(10, 3000), owner: uuid })
  .strict();
export type EvidenceKind = 'baseline' | 'result' | 'positive_observation' | 'negative_observation' | 'reference';
export const EvidenceInput = z
  .object({
    kind: z.enum(['baseline', 'result', 'positive_observation', 'negative_observation', 'reference']),
    body: text(1, 5000),
    metric: text(1, 160).optional(),
    value: z.number().finite().optional(),
    unit: text(1, 40).optional(),
  })
  .strict()
  .refine((v) => v.value === undefined || v.metric !== undefined, 'Для значения укажите метрику');
export const ConcludeInput = z
  .object({ outcome: z.enum(['positive', 'negative', 'inconclusive']), conclusion: text(10, 5000) })
  .strict();
export const DecideInput = z
  .object({ outcome: z.enum(['merge', 'reject', 'close']), rationale: text(10, 5000), implementer: uuid.optional() })
  .strict()
  .refine((v) => !v.implementer || v.outcome === 'merge', { message: 'Исполнитель назначается только при решении о внедрении', path: ['implementer'] });
export const ImplementerInput = z.object({ implementer: uuid }).strict();
export const CompleteImplementationInput = z.object({ report: text(10, 5000) }).strict();

type Result<T> = Promise<IdempotentResult<T>>;

async function mutate<T>(
  db: Database,
  actor: OrgActor,
  number: number,
  scope: string,
  input: unknown,
  key: string | undefined,
  op: (c: Client, idea: IdeaRow) => Promise<T>,
): Result<T> {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true); // row lock: one workflow step per idea at a time
    return idempotent(c, actor.userId, `${scope}:${idea.id}`, key, hashRequest(input), async () => ({
      status: 201,
      body: await op(c, idea),
    }));
  });
}

async function moveStage(c: Client, idea: IdeaRow, to: IdeaStage): Promise<void> {
  if (idea.stage === to) return;
  assertStageTransition(idea.stage, to);
  await c.query('UPDATE ideas SET stage = $2 WHERE id = $1', [idea.id, to]);
  idea.stage = to;
}

// updated_at is set by the database (trigger a05_ideas_touch); a no-op update records the activity time.
const touch = (c: Client, idea: IdeaRow) => c.query('UPDATE ideas SET stage = stage WHERE id = $1', [idea.id]);

async function requireChecks(c: Client, idea: IdeaRow, gate: CheckGate): Promise<void> {
  const failing = failingForGate(await computeChecks(c, idea), gate);
  if (failing.length) {
    throw new AppError('checks_failed', 'Автоматические проверки не пройдены', { gate, failing });
  }
}

async function recordContribution(
  c: Client,
  actor: OrgActor,
  idea: IdeaRow,
  membershipId: string,
  kind: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  await c.query(
    `INSERT INTO contributions (organization_id, membership_id, idea_id, kind, source_type, source_id)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [actor.orgId, membershipId, idea.id, kind, sourceType, sourceId],
  );
}

const log = (c: Client, actor: OrgActor, action: string, entityType: string, entityId: string, data: Record<string, unknown>) =>
  audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action, entityType, entityId, data });

const ping = (c: Client, actor: OrgActor, event: NotificationEvent, idea: IdeaRow, to: (string | null)[], key: string) =>
  notify(c, actor, event, idea.id, to, key);

async function activeMember(c: Client, membershipId: string, role: 'maintainer' | 'decision_owner'): Promise<void> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM memberships WHERE id = $1 AND organization_id = app_org_id() AND status = 'active' AND $2 = ANY (roles)`,
    [membershipId, role],
  );
  if (!rowCount) throw new AppError('validation_failed', `Назначаемый участник должен иметь роль ${role}`);
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------
export function assign(db: Database, actor: OrgActor, number: number, input: z.infer<typeof AssignInput>, key?: string) {
  return mutate(db, actor, number, 'idea.assign', input, key, async (c, idea) => {
    authorize(actor, 'idea.assign', accessFacts(idea));
    for (const [id, role] of [
      [input.maintainer, 'maintainer'],
      [input.decisionOwner, 'decision_owner'],
    ] as const) {
      if (!id) continue;
      if (id === idea.author_membership_id) throw new AppError('validation_failed', 'Автор не может вести или решать собственную идею');
      await activeMember(c, id, role);
    }
    const maintainer = input.maintainer ?? idea.maintainer_membership_id;
    const decisionOwner = input.decisionOwner ?? idea.decision_owner_membership_id;
    // Hybrid powers (owner decision 2026-11-10): one head of department may lead
    // and decide a simple item; a field verification needs two people (see startVerification).
    const active = await c.query(`SELECT 1 FROM verifications WHERE idea_id = $1 AND status IN ('planned','running')`, [idea.id]);
    if (active.rowCount) throw conflict('Назначения нельзя менять во время проверки');
    await c.query(
      'UPDATE ideas SET maintainer_membership_id = $2, decision_owner_membership_id = $3 WHERE id = $1',
      [idea.id, maintainer, decisionOwner],
    );
    idea.maintainer_membership_id = maintainer;
    idea.decision_owner_membership_id = decisionOwner;
    if (idea.stage === 'published' && maintainer) await moveStage(c, idea, 'review');
    await log(c, actor, 'idea.assigned', 'idea', idea.id, { maintainer, decisionOwner });
    await ping(c, actor, 'assigned', idea, [input.maintainer ?? null, input.decisionOwner ?? null], `${idea.id}:${maintainer}:${decisionOwner}`);
    return { number: idea.number, stage: idea.stage, maintainer, decisionOwner };
  });
}

// ---------------------------------------------------------------------------
// Review conversation
// ---------------------------------------------------------------------------
const REVIEW_ACTION = {
  comment: 'idea.comment',
  approval: 'idea.approve',
  request_changes: 'idea.request_changes',
  objection: 'idea.object',
  progress: 'idea.report_progress',
} as const;

export function addReview(db: Database, actor: OrgActor, number: number, input: z.infer<typeof ReviewInput>, key?: string) {
  return mutate(db, actor, number, 'idea.review', input, key, async (c, idea) => {
    authorize(actor, REVIEW_ACTION[input.kind], accessFacts(idea));
    let parentAuthor: string | null = null;
    if (input.kind === 'objection') {
      const p = await c.query<{ kind: string; author_membership_id: string }>(
        'SELECT kind, author_membership_id FROM reviews WHERE id = $1 AND idea_id = $2',
        [input.parentReviewId, idea.id],
      );
      if (p.rows[0]?.kind !== 'request_changes') throw new AppError('validation_failed', 'Возражение адресуется только к запросу изменений');
      parentAuthor = p.rows[0].author_membership_id;
    }
    if (input.kind === 'request_changes' && !['published', 'review', 'development', 'decision'].includes(idea.stage)) {
      throw conflict('На этой стадии изменения запрашиваются после завершения проверки');
    }
    const { rows } = await c.query<{ id: string; created_at: Date }>(
      `INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, parent_review_id, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [actor.orgId, idea.id, idea.current_revision_number, actor.membershipId, input.kind, input.parentReviewId ?? null, input.body],
    );
    const review = rows[0]!;
    if (input.kind === 'request_changes') {
      await moveStage(c, idea, 'development');
    } else {
      await touch(c, idea);
    }
    if (input.kind === 'request_changes' || input.kind === 'approval') {
      await recordContribution(c, actor, idea, actor.membershipId, 'review', 'review', review.id);
    }
    await log(c, actor, `review.${input.kind}`, 'review', review.id, { idea: idea.number, revision: idea.current_revision_number });
    const event: NotificationEvent =
      input.kind === 'request_changes'
        ? 'changes_requested'
        : input.kind === 'objection'
          ? 'objection_raised'
          : input.kind === 'progress'
            ? 'status_report'
            : 'comment_added';
    // Whoever raised the item follows it too: they must see that it is not forgotten.
    const to =
      input.kind === 'objection'
        ? [parentAuthor, idea.maintainer_membership_id]
        : [
            idea.author_membership_id,
            idea.raised_by_membership_id,
            idea.maintainer_membership_id,
            ...(input.kind === 'progress' ? [idea.decision_owner_membership_id, idea.implementer_membership_id] : []),
          ];
    await ping(c, actor, event, idea, to, review.id);
    return {
      id: review.id,
      kind: input.kind,
      revision: idea.current_revision_number,
      stage: idea.stage,
      createdAt: review.created_at.toISOString(),
    };
  });
}

export function resolveReview(
  db: Database,
  actor: OrgActor,
  number: number,
  reviewId: string,
  input: z.infer<typeof ResolveInput>,
  key?: string,
) {
  return mutate(db, actor, number, `review.resolve:${reviewId}`, input, key, async (c, idea) => {
    const r = await c.query<{ kind: string; state: string; author_membership_id: string }>(
      'SELECT kind, state, author_membership_id FROM reviews WHERE id = $1 AND idea_id = $2',
      [reviewId, idea.id],
    );
    const review = r.rows[0];
    if (!review || review.kind !== 'request_changes') throw notFound('Запрос изменений не найден');
    authorize(actor, 'review.resolve', accessFacts(idea), { reviewAuthorMembershipId: review.author_membership_id });
    if (review.state !== 'open') throw conflict('Замечание уже закрыто');
    await c.query(
      `UPDATE reviews SET state = $2, resolution_note = $3, resolved_by_membership_id = $4, resolved_at = clock_timestamp() WHERE id = $1`,
      [reviewId, input.outcome, input.note, actor.membershipId],
    );
    const open = await c.query(`SELECT 1 FROM reviews WHERE idea_id = $1 AND kind = 'request_changes' AND state = 'open'`, [idea.id]);
    // A withdrawn request (e.g. the author's objection was accepted) returns the idea to review.
    if (idea.stage === 'development' && open.rowCount === 0 && input.outcome === 'withdrawn') await moveStage(c, idea, 'review');
    else await touch(c, idea);
    await log(c, actor, `review.${input.outcome}`, 'review', reviewId, { idea: idea.number });
    await ping(c, actor, 'comment_added', idea, [idea.author_membership_id, review.author_membership_id], `${reviewId}:resolve`);
    return { id: reviewId, state: input.outcome, stage: idea.stage };
  });
}

// ---------------------------------------------------------------------------
// Revisions and suggested revisions
// ---------------------------------------------------------------------------
async function nextRevisionNumber(c: Client, idea: IdeaRow): Promise<number> {
  const { rows } = await c.query<{ n: number }>('SELECT coalesce(max(number), 0) + 1 AS n FROM idea_revisions WHERE idea_id = $1', [idea.id]);
  return rows[0]!.n;
}

/** The text may change only before verification; afterwards the verified text is what gets decided. */
function assertTextEditable(idea: IdeaRow): void {
  if (!['published', 'review', 'development'].includes(idea.stage)) {
    throw conflict('Текст идеи нельзя менять после начала проверки — решение принимается по проверенной версии');
  }
}

function assertBase(idea: IdeaRow, base: number): void {
  if (base !== idea.current_revision_number) {
    throw conflict('Версия идеи изменилась, обновите страницу', { currentRevision: idea.current_revision_number });
  }
}

async function promote(c: Client, idea: IdeaRow, revisionNumber: number): Promise<void> {
  await c.query(`UPDATE idea_revisions SET status = 'superseded' WHERE idea_id = $1 AND status = 'current'`, [idea.id]);
  await c.query(`UPDATE idea_revisions SET status = 'current' WHERE idea_id = $1 AND number = $2`, [idea.id, revisionNumber]);
  await c.query('UPDATE ideas SET current_revision_number = $2 WHERE id = $1', [idea.id, revisionNumber]);
  idea.current_revision_number = revisionNumber;
  if (idea.stage === 'development') await moveStage(c, idea, 'review');
}

export function revise(db: Database, actor: OrgActor, number: number, input: z.infer<typeof ReviseInput>, key?: string) {
  return mutate(db, actor, number, 'idea.revise', input, key, async (c, idea) => {
    authorize(actor, 'idea.revise', accessFacts(idea));
    assertBase(idea, input.baseRevision);
    assertTextEditable(idea);
    const n = await nextRevisionNumber(c, idea);
    await c.query(`UPDATE idea_revisions SET status = 'superseded' WHERE idea_id = $1 AND status = 'current'`, [idea.id]);
    await c.query(
      `INSERT INTO idea_revisions (organization_id, idea_id, number, author_membership_id, origin, based_on_number,
                                   title, problem, proposal, success_criteria, rationale, status)
       VALUES ($1, $2, $3, $4, 'author_update', $5, $6, $7, $8, $9, $10, 'current')`,
      [actor.orgId, idea.id, n, actor.membershipId, input.baseRevision, input.title, input.problem, input.proposal, input.successCriteria ?? null, input.rationale ?? null],
    );
    await c.query('UPDATE ideas SET current_revision_number = $2 WHERE id = $1', [idea.id, n]);
    idea.current_revision_number = n;
    if (idea.stage === 'development') await moveStage(c, idea, 'review');
    await log(c, actor, 'idea.revised', 'idea', idea.id, { revision: n, basedOn: input.baseRevision });
    await ping(c, actor, 'revision_submitted', idea, [idea.maintainer_membership_id], `${idea.id}:rev:${n}`);
    return { revision: n, stage: idea.stage };
  });
}

export function suggest(db: Database, actor: OrgActor, number: number, input: z.infer<typeof SuggestInput>, key?: string) {
  return mutate(db, actor, number, 'idea.suggest', input, key, async (c, idea) => {
    authorize(actor, 'idea.suggest_revision', accessFacts(idea));
    assertBase(idea, input.baseRevision);
    const n = await nextRevisionNumber(c, idea);
    await c.query(
      `INSERT INTO idea_revisions (organization_id, idea_id, number, author_membership_id, origin, based_on_number,
                                   title, problem, proposal, success_criteria, rationale, status)
       VALUES ($1, $2, $3, $4, 'suggestion', $5, $6, $7, $8, $9, $10, 'proposed')`,
      [actor.orgId, idea.id, n, actor.membershipId, input.baseRevision, input.title, input.problem, input.proposal, input.successCriteria ?? null, input.rationale],
    );
    await touch(c, idea);
    await log(c, actor, 'idea.suggestion_submitted', 'idea', idea.id, { revision: n, basedOn: input.baseRevision });
    await ping(c, actor, 'suggestion_submitted', idea, [idea.author_membership_id], `${idea.id}:sug:${n}`);
    return { revision: n, status: 'proposed' };
  });
}

export function decideSuggestion(
  db: Database,
  actor: OrgActor,
  number: number,
  revisionNumber: number,
  input: z.infer<typeof SuggestionDecisionInput>,
  key?: string,
) {
  return mutate(db, actor, number, `idea.suggestion:${revisionNumber}`, input, key, async (c, idea) => {
    authorize(actor, 'idea.decide_suggestion', accessFacts(idea));
    const r = await c.query<{ id: string; status: string; based_on_number: number; author_membership_id: string }>(
      `SELECT id, status, based_on_number, author_membership_id FROM idea_revisions
        WHERE idea_id = $1 AND number = $2 AND origin = 'suggestion'`,
      [idea.id, revisionNumber],
    );
    const s = r.rows[0];
    if (!s) throw notFound('Предложенная версия не найдена');
    if (s.status !== 'proposed') throw conflict('Предложение уже рассмотрено');
    if (input.accept) {
      assertTextEditable(idea);
      if (s.based_on_number !== idea.current_revision_number) {
        throw conflict('Предложение основано на устаревшей версии', { currentRevision: idea.current_revision_number });
      }
      await promote(c, idea, revisionNumber);
      // The suggester keeps permanent co-authorship credit for the adopted text.
      await recordContribution(c, actor, idea, s.author_membership_id, 'co_authorship', 'revision', s.id);
    } else {
      await c.query(`UPDATE idea_revisions SET status = 'declined' WHERE id = $1`, [s.id]);
      await touch(c, idea);
    }
    await log(c, actor, input.accept ? 'idea.suggestion_accepted' : 'idea.suggestion_declined', 'idea', idea.id, {
      revision: revisionNumber,
      note: input.note ?? null,
    });
    await ping(c, actor, 'suggestion_decided', idea, [s.author_membership_id], `${s.id}:decided`);
    return { revision: revisionNumber, status: input.accept ? 'current' : 'declined', stage: idea.stage };
  });
}

// ---------------------------------------------------------------------------
// Idea Verification Engine — field verification
// ---------------------------------------------------------------------------
export function startVerification(
  db: Database,
  actor: OrgActor,
  number: number,
  input: z.infer<typeof StartVerificationInput>,
  key?: string,
) {
  return mutate(db, actor, number, 'verification.start', input, key, async (c, idea) => {
    authorize(actor, 'verification.start', accessFacts(idea));
    if (idea.stage !== 'review') throw conflict('Проверку запускают на стадии обсуждения, без открытых доработок');
    await requireChecks(c, idea, 'start_verification');
    if (!idea.decision_owner_membership_id || idea.decision_owner_membership_id === idea.maintainer_membership_id) {
      throw new AppError('validation_failed', 'Для полевой проверки нужен отдельный ответственный за решение — назначьте его');
    }
    if (input.owner === idea.author_membership_id) {
      throw new AppError('validation_failed', 'Автор не может проводить проверку собственной идеи');
    }
    if (input.owner === idea.decision_owner_membership_id) {
      throw new AppError('validation_failed', 'Ответственный за решение не проводит проверку, которую будет оценивать');
    }
    const assignedLead = input.owner === idea.maintainer_membership_id;
    const owner = await c.query(
      `SELECT 1 FROM memberships WHERE id = $1 AND organization_id = app_org_id() AND status = 'active' AND (access = 'member' OR $2)`,
      [input.owner, assignedLead],
    );
    if (!owner.rowCount) throw new AppError('validation_failed', 'Ответственный за проверку должен быть сотрудником или назначенным проверяющим');
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO verifications (organization_id, idea_id, revision_number, purpose, owner_membership_id,
                                  created_by_membership_id, plan, success_criteria)
       VALUES ($1, $2, $3, 'hypothesis', $4, $5, $6, $7) RETURNING id`,
      [actor.orgId, idea.id, idea.current_revision_number, input.owner, actor.membershipId, input.plan, input.successCriteria],
    );
    const id = rows[0]!.id;
    await c.query(`UPDATE verifications SET status = 'running', started_at = clock_timestamp() WHERE id = $1`, [id]);
    await moveStage(c, idea, 'verification');
    await recordContribution(c, actor, idea, input.owner, 'verification', 'verification', id);
    await log(c, actor, 'verification.started', 'verification', id, { idea: idea.number, revision: idea.current_revision_number });
    await ping(c, actor, 'verification_started', idea, [idea.author_membership_id, input.owner], id);
    return { id, status: 'running', revision: idea.current_revision_number, stage: idea.stage };
  });
}

async function loadVerification(c: Client, idea: IdeaRow, id: string) {
  const { rows } = await c.query<{ id: string; status: string; owner_membership_id: string }>(
    'SELECT id, status, owner_membership_id FROM verifications WHERE id = $1 AND idea_id = $2 FOR UPDATE',
    [id, idea.id],
  );
  if (!rows[0]) throw notFound('Проверка не найдена');
  return rows[0];
}

export function recordEvidence(
  db: Database,
  actor: OrgActor,
  number: number,
  verificationId: string,
  input: z.infer<typeof EvidenceInput>,
  key?: string,
) {
  return mutate(db, actor, number, `verification.evidence:${verificationId}`, input, key, async (c, idea) => {
    const v = await loadVerification(c, idea, verificationId);
    authorize(actor, 'verification.record_evidence', accessFacts(idea), { verificationOwnerMembershipId: v.owner_membership_id });
    if (v.status !== 'running') throw conflict('Доказательства добавляются только в идущую проверку');
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO verification_evidence (organization_id, verification_id, kind, body, metric, value, unit, recorded_by_membership_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [actor.orgId, verificationId, input.kind, input.body, input.metric ?? null, input.value ?? null, input.unit ?? null, actor.membershipId],
    );
    await touch(c, idea);
    await log(c, actor, 'verification.evidence_recorded', 'verification', verificationId, { evidence: rows[0]!.id, kind: input.kind });
    return { id: rows[0]!.id, kind: input.kind };
  });
}

export function concludeVerification(
  db: Database,
  actor: OrgActor,
  number: number,
  verificationId: string,
  input: z.infer<typeof ConcludeInput>,
  key?: string,
) {
  return mutate(db, actor, number, `verification.conclude:${verificationId}`, input, key, async (c, idea) => {
    const v = await loadVerification(c, idea, verificationId);
    authorize(actor, 'verification.conclude', accessFacts(idea));
    if (v.status !== 'running') throw conflict('Проверка уже завершена');
    const ev = await c.query<{ kind: string }>('SELECT kind FROM verification_evidence WHERE verification_id = $1', [verificationId]);
    const kinds = new Set(ev.rows.map((r) => r.kind));
    if (input.outcome === 'positive' && !kinds.has('result') && !kinds.has('positive_observation')) {
      throw new AppError('validation_failed', 'Положительный вывод требует зафиксированных результатов или положительных наблюдений');
    }
    if (input.outcome === 'negative' && !kinds.has('result') && !kinds.has('negative_observation')) {
      throw new AppError('validation_failed', 'Отрицательный вывод требует зафиксированных результатов или отрицательных наблюдений');
    }
    await c.query(
      `UPDATE verifications SET status = 'completed', outcome = $2, conclusion = $3,
              concluded_by_membership_id = $4, completed_at = clock_timestamp() WHERE id = $1`,
      [verificationId, input.outcome, input.conclusion, actor.membershipId],
    );
    await moveStage(c, idea, 'decision');
    if (input.outcome === 'negative') {
      // A well-documented negative result is a contribution in its own right.
      await recordContribution(c, actor, idea, v.owner_membership_id, 'negative_result', 'verification', verificationId);
    }
    await log(c, actor, 'verification.concluded', 'verification', verificationId, { outcome: input.outcome });
    await ping(c, actor, 'verification_completed', idea, [idea.author_membership_id, idea.decision_owner_membership_id, v.owner_membership_id], verificationId);
    return { id: verificationId, status: 'completed', outcome: input.outcome, stage: idea.stage };
  });
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------
export function decide(db: Database, actor: OrgActor, number: number, input: z.infer<typeof DecideInput>, key?: string) {
  return mutate(db, actor, number, 'idea.decide', input, key, async (c, idea) => {
    authorize(actor, 'idea.decide', accessFacts(idea));
    if (!['review', 'decision'].includes(idea.stage)) throw conflict('Решение принимается на стадии обсуждения или решения');
    if (input.outcome === 'merge') await requireChecks(c, idea, 'decide');
    const { rows } = await c.query<{ id: string; verification_summary: unknown }>(
      `INSERT INTO decisions (organization_id, idea_id, revision_number, decided_by_membership_id, outcome, rationale)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, verification_summary`,
      [actor.orgId, idea.id, idea.current_revision_number, actor.membershipId, input.outcome, input.rationale],
    );
    const decision = rows[0]!;
    if (input.outcome === 'merge') {
      if (input.implementer) await setImplementer(c, actor, idea, input.implementer);
      await moveStage(c, idea, 'decision');
      await moveStage(c, idea, 'adoption');
    } else {
      await moveStage(c, idea, 'closed');
    }
    await log(c, actor, `decision.${input.outcome}`, 'decision', decision.id, { idea: idea.number, revision: idea.current_revision_number });
    const owners = await c.query<{ owner_membership_id: string }>('SELECT owner_membership_id FROM verifications WHERE idea_id = $1', [idea.id]);
    await ping(
      c,
      actor,
      input.outcome === 'merge' ? 'idea_merged' : 'idea_rejected',
      idea,
      [idea.author_membership_id, idea.raised_by_membership_id, idea.maintainer_membership_id, ...owners.rows.map((o) => o.owner_membership_id)],
      decision.id,
    );
    return {
      id: decision.id,
      outcome: input.outcome,
      revision: idea.current_revision_number,
      stage: idea.stage,
      verificationSummary: decision.verification_summary,
    };
  });
}

// ---------------------------------------------------------------------------
// Implementation ("в реализации" → "реализовано")
// ---------------------------------------------------------------------------
async function setImplementer(c: Client, actor: OrgActor, idea: IdeaRow, implementer: string): Promise<void> {
  const ok = await c.query(
    `SELECT 1 FROM memberships WHERE id = $1 AND organization_id = app_org_id() AND status = 'active' AND access = 'member'`,
    [implementer],
  );
  if (!ok.rowCount) throw new AppError('validation_failed', 'Исполнитель должен быть действующим сотрудником');
  await c.query('UPDATE ideas SET implementer_membership_id = $2 WHERE id = $1', [idea.id, implementer]);
  idea.implementer_membership_id = implementer;
  await log(c, actor, 'idea.assigned', 'idea', idea.id, { implementer });
  await ping(c, actor, 'assigned', idea, [implementer], `${idea.id}:impl:${implementer}`);
}

export function assignImplementer(db: Database, actor: OrgActor, number: number, input: z.infer<typeof ImplementerInput>, key?: string) {
  return mutate(db, actor, number, 'idea.implementer', input, key, async (c, idea) => {
    authorize(actor, 'idea.report_progress', accessFacts(idea));
    if (actor.membershipId !== idea.maintainer_membership_id && actor.membershipId !== idea.decision_owner_membership_id) {
      throw new AppError('forbidden', 'Исполнителя назначают ведущий или ответственный за решение');
    }
    if (idea.stage !== 'adoption') throw conflict('Исполнитель назначается после решения о внедрении');
    await setImplementer(c, actor, idea, input.implementer);
    return { number: idea.number, implementer: input.implementer, stage: idea.stage };
  });
}

/** The implementer (or a lead) reports that the change is in place. The report stays in history. */
export function completeImplementation(
  db: Database,
  actor: OrgActor,
  number: number,
  input: z.infer<typeof CompleteImplementationInput>,
  key?: string,
) {
  return mutate(db, actor, number, 'idea.complete', input, key, async (c, idea) => {
    authorize(actor, 'idea.complete_implementation', accessFacts(idea));
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body)
       VALUES ($1, $2, $3, $4, 'progress', $5) RETURNING id`,
      [actor.orgId, idea.id, idea.current_revision_number, actor.membershipId, input.report],
    );
    await moveStage(c, idea, 'impact_verification');
    if (idea.implementer_membership_id) {
      await recordContribution(c, actor, idea, idea.implementer_membership_id, 'implementation', 'idea', idea.id);
    }
    await log(c, actor, 'idea.implemented', 'idea', idea.id, { report: rows[0]!.id });
    await ping(
      c,
      actor,
      'implemented',
      idea,
      [idea.author_membership_id, idea.raised_by_membership_id, idea.maintainer_membership_id, idea.decision_owner_membership_id],
      `${idea.id}:implemented`,
    );
    return { number: idea.number, stage: idea.stage, status: 'implemented', reportId: rows[0]!.id };
  });
}

/**
 * The colleague named as "raised by" can decline the attribution (e.g. it was
 * recorded wrongly). The credit is revoked with a reason and they may then be
 * assigned to the item like anyone else. History keeps both facts.
 */
export function declineAttribution(db: Database, actor: OrgActor, number: number, key?: string) {
  return mutate(db, actor, number, 'idea.decline_attribution', {}, key, async (c, idea) => {
    if (idea.raised_by_membership_id !== actor.membershipId) {
      throw new AppError('forbidden', 'Отказаться от авторства вопроса может только тот, на кого он записан');
    }
    await c.query('UPDATE ideas SET raised_by_membership_id = NULL WHERE id = $1', [idea.id]);
    await c.query(
      `UPDATE contributions SET status = 'revoked', revoked_reason = 'Сотрудник отказался от авторства вопроса'
        WHERE idea_id = $1 AND kind = 'issue_found' AND membership_id = $2 AND status <> 'revoked'`,
      [idea.id, actor.membershipId],
    );
    await log(c, actor, 'idea.attribution_declined', 'idea', idea.id, {});
    idea.raised_by_membership_id = null;
    return { number: idea.number, raisedBy: null };
  });
}
