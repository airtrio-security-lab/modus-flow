import { methodOfItem } from './knowledge-path.ts';
import { notFound } from '../domain/errors.ts';
import { activeDeferral } from './deferral.ts';
import { runChecks, type CheckResult } from '../domain/checks.ts';
import type { IdeaAccessFacts, IdeaStage, OrgActor } from '../domain/model.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { orgTx } from './context.ts';
import { effectLines, effectMeasured, type Measurement } from '../domain/effect.ts';
import { loadContext } from './project-context.ts';

/** Read side of the organization workspace. All queries run under tenant RLS. */

export interface IdeaRow {
  id: string;
  number: number;
  kind: 'idea' | 'problem';
  stage: IdeaStage;
  author_membership_id: string;
  maintainer_membership_id: string | null;
  decision_owner_membership_id: string | null;
  raised_by_membership_id: string | null;
  implementer_membership_id: string | null;
  department_id: string | null;
  current_revision_number: number;
  published_at: Date;
  updated_at: Date;
}

export const accessFacts = (r: IdeaRow): IdeaAccessFacts => ({
  authorMembershipId: r.author_membership_id,
  maintainerMembershipId: r.maintainer_membership_id,
  decisionOwnerMembershipId: r.decision_owner_membership_id,
  raisedByMembershipId: r.raised_by_membership_id,
  implementerMembershipId: r.implementer_membership_id,
  stage: r.stage,
});

export async function loadIdea(c: Client, number: number, lock = false): Promise<IdeaRow> {
  const { rows } = await c.query<IdeaRow>(
    `SELECT id, number, kind, stage, author_membership_id, maintainer_membership_id,
            decision_owner_membership_id, raised_by_membership_id, implementer_membership_id,
            department_id, current_revision_number, published_at, updated_at
       FROM ideas WHERE organization_id = app_org_id() AND number = $1${lock ? ' FOR UPDATE' : ''}`,
    [number],
  );
  const row = rows[0];
  if (!row) throw notFound('Идея не найдена');
  return row;
}

export interface IdeaSummary {
  number: number;
  kind: string;
  title: string;
  stage: IdeaStage;
  author: string;
  publishedAt: string;
  updatedAt: string;
}

export async function listIdeas(db: Database, actor: OrgActor, stage?: IdeaStage): Promise<IdeaSummary[]> {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query<{
      number: number;
      kind: string;
      title: string;
      stage: IdeaStage;
      author: string;
      published_at: Date;
      updated_at: Date;
    }>(
      `SELECT i.number, i.kind, r.title, i.stage, e.display_name AS author, i.published_at, i.updated_at
         FROM ideas i
         JOIN idea_revisions r ON r.idea_id = i.id AND r.number = i.current_revision_number
         JOIN employees e ON e.membership_id = i.author_membership_id
        WHERE i.organization_id = app_org_id() AND ($1::text IS NULL OR i.stage = $1)
        ORDER BY i.number DESC LIMIT 200`,
      [stage ?? null],
    );
    return rows.map((r) => ({
      number: r.number,
      kind: r.kind,
      title: r.title,
      stage: r.stage,
      author: r.author,
      publishedAt: r.published_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  });
}

const person = (membershipId: string | null, name: string | null) =>
  membershipId ? { membershipId, name: name ?? '—' } : null;

/** Computes automated checks for an idea inside an existing transaction. */
export async function computeChecks(c: Client, idea: IdeaRow): Promise<CheckResult[]> {
  const revs = await c.query<{ number: number; title: string; problem: string; proposal: string | null; success_criteria: string | null }>(
    'SELECT number, title, problem, proposal, success_criteria FROM idea_revisions WHERE idea_id = $1 ORDER BY number',
    [idea.id],
  );
  const current = revs.rows.find((r) => r.number === idea.current_revision_number) ?? null;
  const blocking = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM reviews WHERE idea_id = $1 AND kind = 'request_changes' AND state = 'open'`,
    [idea.id],
  );
  const ver = await c.query<{ total: number; completed: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM verifications WHERE idea_id = $1 AND purpose = 'hypothesis' AND revision_number = $2`,
    [idea.id, idea.current_revision_number],
  );
  return runChecks({
    revision: current
      ? { title: current.title, problem: current.problem, proposal: current.proposal, successCriteria: current.success_criteria }
      : null,
    kind: idea.kind,
    currentRevisionNumber: idea.current_revision_number,
    revisionNumbers: revs.rows.map((r) => r.number),
    maintainerMembershipId: idea.maintainer_membership_id,
    decisionOwnerMembershipId: idea.decision_owner_membership_id,
    authorMembershipId: idea.author_membership_id,
    openBlockingReviews: blocking.rows[0]!.n,
    hasHypothesisVerification: ver.rows[0]!.total > 0,
    completedHypothesisVerification: ver.rows[0]!.completed > 0,
  });
}

export async function getIdea(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number);
    const names = await c.query<{ membership_id: string; display_name: string }>(
      'SELECT membership_id, display_name FROM employees WHERE organization_id = app_org_id() AND membership_id = ANY($1::uuid[])',
      [[idea.author_membership_id, idea.maintainer_membership_id, idea.decision_owner_membership_id].filter(Boolean)],
    );
    const nameOf = (id: string | null) => names.rows.find((n) => n.membership_id === id)?.display_name ?? null;

    const revisions = await c.query(
      `SELECT r.number, r.origin, r.status, r.based_on_number, r.title, r.problem, r.proposal,
              r.success_criteria, r.rationale, r.created_at, e.display_name AS author, r.author_membership_id
         FROM idea_revisions r JOIN employees e ON e.membership_id = r.author_membership_id
        WHERE r.idea_id = $1 ORDER BY r.number`,
      [idea.id],
    );
    const reviews = await c.query(
      `SELECT v.id, v.kind, v.revision_number, v.parent_review_id, v.body, v.state, v.resolution_note,
              v.created_at, v.resolved_at, e.display_name AS author, v.author_membership_id
         FROM reviews v JOIN employees e ON e.membership_id = v.author_membership_id
        WHERE v.idea_id = $1 ORDER BY v.created_at, v.id`,
      [idea.id],
    );
    // Every piece of evidence is returned — positive and negative alike.
    const verifications = await c.query(
      `SELECT v.id, v.purpose, v.revision_number, v.status, v.outcome, v.plan, v.success_criteria, v.conclusion,
              v.owner_membership_id, eo.display_name AS owner, ec.display_name AS concluded_by,
              v.started_at, v.completed_at, v.created_at,
              coalesce((SELECT jsonb_agg(jsonb_build_object(
                         'id', x.id, 'kind', x.kind, 'body', x.body, 'metric', x.metric, 'value', x.value,
                         'unit', x.unit, 'period', x.period, 'source', x.source, 'goal', x.goal, 'comparable', x.comparable,
                         'recordedBy', er.display_name, 'createdAt', x.created_at) ORDER BY x.created_at, x.id)
                          FROM verification_evidence x JOIN employees er ON er.membership_id = x.recorded_by_membership_id
                         WHERE x.verification_id = v.id), '[]'::jsonb) AS evidence
         FROM verifications v
         JOIN employees eo ON eo.membership_id = v.owner_membership_id
         LEFT JOIN employees ec ON ec.membership_id = v.concluded_by_membership_id
        WHERE v.idea_id = $1 ORDER BY v.created_at`,
      [idea.id],
    );
    const decisions = await c.query(
      `SELECT d.id, d.outcome, d.revision_number, d.rationale, d.verification_summary, d.created_at,
              e.display_name AS decided_by
         FROM decisions d JOIN employees e ON e.membership_id = d.decided_by_membership_id
        WHERE d.idea_id = $1 ORDER BY d.created_at`,
      [idea.id],
    );
    const contributions = await c.query(
      `SELECT c.kind, c.status, c.source_type, c.source_id, e.display_name AS member, c.created_at,
              c.id, c.membership_id AS "membershipId", c.confirmed_at AS "confirmedAt", ce.display_name AS "confirmedBy",
              -- ADR-0042: what the reader may confirm here (the database checks the same rules again).
              (c.status = 'recorded' AND c.kind <> 'authorship' AND c.membership_id <> app_membership_id()
                AND app_membership_id() IN (i.maintainer_membership_id, i.decision_owner_membership_id)
                AND (c.source_type <> 'verification'
                     OR EXISTS (SELECT 1 FROM verifications v WHERE v.id = c.source_id AND v.status = 'completed'))) AS "canConfirm"
         FROM contributions c JOIN employees e ON e.membership_id = c.membership_id
         JOIN ideas i ON i.id = c.idea_id
         LEFT JOIN employees ce ON ce.membership_id = c.confirmed_by_membership_id
        WHERE c.idea_id = $1 ORDER BY c.created_at, c.id`,
      [idea.id],
    );
    const overview = await c.query(
      `SELECT status, category, category_id AS "categoryId", department, department_id AS "departmentId",
              source_channel AS "sourceChannel", source_note AS "sourceNote",
              raised_by AS "raisedBy", raised_by_membership_id AS "raisedByMembershipId",
              implementer, implementer_membership_id AS "implementerMembershipId",
              first_response_due_at AS "firstResponseDueAt", first_response_at AS "firstResponseAt",
              resolution_due_at AS "resolutionDueAt", overdue_first_response AS "overdueFirstResponse",
              overdue_resolution AS "overdueResolution", stale
         FROM idea_overview WHERE id = $1`,
      [idea.id],
    );
    const attachments = await c.query(
      `SELECT a.id, a.file_name AS "fileName", a.content_type AS "contentType", a.size_bytes AS "sizeBytes",
              a.sha256, a.created_at AS "createdAt", e.display_name AS "uploadedBy"
         FROM attachments a JOIN employees e ON e.membership_id = a.uploaded_by_membership_id
        WHERE a.idea_id = $1 ORDER BY a.created_at`,
      [idea.id],
    );
    const escalations = await c.query(
      `SELECT x.kind, x.created_at AS "createdAt", e.display_name AS "escalatedTo"
         FROM escalations x LEFT JOIN employees e ON e.membership_id = x.escalated_to_membership_id
        WHERE x.idea_id = $1 ORDER BY x.created_at`,
      [idea.id],
    );
    // Measured effect (ADR-0031): «before» and «after» of the same metric, from the evidence above.
    const measurements = (verifications.rows as { id: string; evidence: Measurement[] }[]).flatMap((v) => v.evidence.map((e) => ({ ...e, verificationId: v.id })));
    const lines = effectLines(measurements);
    const approved = await c.query<{ at: Date; by: string }>(
      `SELECT a.created_at AS at, e.display_name AS by FROM effect_approvals a JOIN employees e ON e.membership_id = a.approved_by_membership_id WHERE a.idea_id = $1`,
      [idea.id],
    );
    return {
      ...(overview.rows[0] as Record<string, unknown>),
      context: await loadContext(c, idea.id),
      // «Применить этот метод» (ADR-0040): the knowledge this item was started from, if its reader may open it.
      method: await methodOfItem(c, idea.id),
      effect: {
        lines,
        measured: effectMeasured(lines),
        // The bonus approved by the decision owner (0007) is shown next to the measurements, never instead of them.
        approval: approved.rows[0] ? { by: approved.rows[0].by, at: approved.rows[0].at.toISOString() } : null,
      },
      attachments: attachments.rows,
      escalations: escalations.rows,
      deferral: await activeDeferral(c, idea.id),
      id: idea.id,
      number: idea.number,
      kind: idea.kind,
      stage: idea.stage,
      author: person(idea.author_membership_id, nameOf(idea.author_membership_id)),
      maintainer: person(idea.maintainer_membership_id, nameOf(idea.maintainer_membership_id)),
      decisionOwner: person(idea.decision_owner_membership_id, nameOf(idea.decision_owner_membership_id)),
      currentRevision: idea.current_revision_number,
      publishedAt: idea.published_at.toISOString(),
      updatedAt: idea.updated_at.toISOString(),
      revisions: revisions.rows,
      reviews: reviews.rows,
      verifications: verifications.rows,
      decisions: decisions.rows,
      contributions: contributions.rows,
      checks: await computeChecks(c, idea),
    };
  });
}
