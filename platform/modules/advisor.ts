import { createHash } from 'node:crypto';
import { z } from 'zod';
import { conflict, forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { extractByRules, type Candidate } from '../domain/protocol.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { hashRequest, idempotent } from './idempotency.ts';
import { loadIdea } from './ideas.ts';
import { createItem } from './intake.ts';
import { extractByModel, isRemote, modelLabel, modelReachable, type ModelConfig } from './advisor-model.ts';

/**
 * MODUS ADVISOR — the minimal assistant at the Council table (ADR-0013).
 *
 *   * a short questionnaire: skills, work preferences, hours a week;
 *   * a meeting protocol is stored verbatim (with its SHA-256) and split into
 *     candidate tasks, each with the exact quote it came from;
 *   * a lead confirms or dismisses every candidate; a confirmed one becomes an
 *     ordinary item (source «meeting»), routed by the usual rules;
 *   * for an item, executors are suggested from questionnaires and current
 *     load, with the reasons spelled out; a person confirms the choice.
 *
 * The advisor never decides, never closes items, never awards XP and never
 * assigns credit. Without a local model it works by transparent rules and
 * says so; it does not pretend that text matching is AI.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export const METHOD_LABEL = {
  rules: 'Разбор по шаблону (без ИИ)',
  model: 'Языковая модель',
} as const;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
export async function advisorStatus(model: ModelConfig | null, fetchImpl?: typeof fetch) {
  return {
    rules: { available: true, label: METHOD_LABEL.rules },
    model: model
      ? { configured: true, provider: model.provider, model: model.model, remote: isRemote(model), reachable: await modelReachable(model, fetchImpl) }
      : { configured: false, provider: null, model: null, remote: false, reachable: false },
    note: !model
      ? 'Модель не подключена: задачи ищутся по шаблону, исполнители подбираются по анкетам. Это правила, не ИИ.'
      : isRemote(model)
        ? `Подключена ${modelLabel(model)}. Тексты обращений, знаний и совещаний, которые вы отправляете на разбор, уходят за пределы компании.`
        : 'Локальная модель работает на этом компьютере; текст протокола никуда не отправляется.',
  };
}

// ---------------------------------------------------------------------------
// Questionnaire
// ---------------------------------------------------------------------------
export const ProfileInput = z
  .object({
    skills: z.array(text(2, 40)).max(12).default([]),
    preferences: text(0, 500).optional(),
    weeklyHours: z.number().int().min(0).max(60).nullable().optional(),
  })
  .strict();

export async function getMyProfile(db: Database, actor: OrgActor) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT skills, preferences, weekly_hours AS "weeklyHours", updated_at AS "updatedAt"
         FROM employee_profiles WHERE organization_id = app_org_id() AND membership_id = app_membership_id()`,
    );
    return rows[0] ?? { skills: [], preferences: null, weeklyHours: null, updatedAt: null };
  });
}

export async function saveMyProfile(db: Database, actor: OrgActor, input: z.infer<typeof ProfileInput>) {
  const seen = new Set<string>();
  const skills = input.skills.filter((s) => !seen.has(s.toLowerCase()) && !!seen.add(s.toLowerCase()));
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `INSERT INTO employee_profiles (organization_id, membership_id, skills, preferences, weekly_hours)
       VALUES (app_org_id(), app_membership_id(), $1, $2, $3)
       ON CONFLICT (organization_id, membership_id)
       DO UPDATE SET skills = EXCLUDED.skills, preferences = EXCLUDED.preferences,
                     weekly_hours = EXCLUDED.weekly_hours, updated_at = clock_timestamp()
       RETURNING skills, preferences, weekly_hours AS "weeklyHours", updated_at AS "updatedAt"`,
      [skills, input.preferences || null, input.weeklyHours ?? null],
    );
    return rows[0];
  });
}

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------
export const ProtocolInput = z
  .object({
    title: text(3, 200),
    text: z.string().min(20).max(20000),
    method: z.enum(['rules', 'model']).default('rules'),
  })
  .strict();

const isLead = (a: OrgActor) => a.access === 'member' && a.roles.some((r) => r === 'maintainer' || r === 'decision_owner' || r === 'org_admin');

export async function createProtocol(
  db: Database,
  actor: OrgActor,
  input: z.infer<typeof ProtocolInput>,
  key: string | undefined,
  model: ModelConfig | null,
  fetchImpl?: typeof fetch,
) {
  if (!isLead(actor)) throw forbidden('Протокол разбирает руководитель или ведущий обращений');
  const source = input.text.replace(/\r\n?/g, '\n');
  // Extraction runs before the transaction: a slow model must not hold a database connection.
  let found: { candidates: Candidate[]; dropped: number };
  if (input.method === 'model') {
    if (!model) throw conflict('Локальная модель не подключена. Выберите «Разбор по шаблону»');
    found = await extractByModel(model, source, fetchImpl);
  } else found = { candidates: extractByRules(source), dropped: 0 };

  return withTx(db, orgTx(actor), async (c) =>
    idempotent(c, actor.userId, `advisor.protocol:${actor.orgId}`, key, hashRequest({ ...input, text: sha256(source) }), async () => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO meeting_protocols (organization_id, created_by_membership_id, title, source_text, source_sha256, method, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [actor.orgId, actor.membershipId, input.title, source, sha256(source), input.method, input.method === 'model' ? model!.model : null],
      );
      const id = rows[0]!.id;
      for (const k of found.candidates) {
        await c.query(
          `INSERT INTO protocol_candidates (organization_id, protocol_id, ord, quote_start, quote_end, quote, proposed_title, proposed_kind, proposed_raiser)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [actor.orgId, id, k.ord, k.quoteStart, k.quoteEnd, k.quote, k.title.slice(0, 160), k.kind, k.raiser],
        );
      }
      await audit(c, {
        orgId: actor.orgId,
        actorUserId: actor.userId,
        action: 'advisor.protocol_parsed',
        entityType: 'meeting_protocol',
        entityId: id,
        data: { method: input.method, candidates: found.candidates.length, dropped: found.dropped },
      });
      return { status: 201, body: { id, candidates: found.candidates.length, dropped: found.dropped, method: input.method } };
    }),
  );
}

export async function listProtocols(db: Database, actor: OrgActor) {
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await c.query(
      `SELECT p.id, p.title, p.method, p.model, p.created_at AS "createdAt", e.display_name AS "createdBy",
              count(k.id)::int AS total,
              count(k.id) FILTER (WHERE k.status = 'proposed')::int AS proposed,
              count(k.id) FILTER (WHERE k.status = 'accepted')::int AS accepted
         FROM meeting_protocols p
         JOIN employees e ON e.membership_id = p.created_by_membership_id
         LEFT JOIN protocol_candidates k ON k.protocol_id = p.id
        WHERE p.organization_id = app_org_id()
        GROUP BY p.id, e.display_name ORDER BY p.created_at DESC LIMIT 50`,
    );
    return rows;
  });
}

export async function getProtocol(db: Database, actor: OrgActor, id: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const p = (
      await c.query(
        `SELECT p.id, p.title, p.source_text AS text, p.source_sha256 AS sha256, p.method, p.model,
                p.created_at AS "createdAt", e.display_name AS "createdBy"
           FROM meeting_protocols p JOIN employees e ON e.membership_id = p.created_by_membership_id
          WHERE p.organization_id = app_org_id() AND p.id = $1`,
        [id],
      )
    ).rows[0];
    if (!p) throw notFound('Протокол не найден');
    const candidates = await c.query(
      `SELECT k.id, k.ord, k.quote_start AS "quoteStart", k.quote_end AS "quoteEnd", k.quote,
              k.proposed_title AS title, k.proposed_kind AS kind, k.proposed_raiser AS raiser, k.status,
              i.number AS "itemNumber", d.display_name AS "decidedBy", k.decided_at AS "decidedAt"
         FROM protocol_candidates k
         LEFT JOIN ideas i ON i.id = k.item_id
         LEFT JOIN employees d ON d.membership_id = k.decided_by_membership_id
        WHERE k.protocol_id = $1 ORDER BY k.ord`,
      [id],
    );
    return { ...p, methodLabel: METHOD_LABEL[p.method as keyof typeof METHOD_LABEL], candidates: candidates.rows, canDecide: isLead(actor) };
  });
}

/** The person confirms the facts: what kind, the title, the wording, who raised it. */
export const AcceptCandidateInput = z
  .object({
    kind: z.enum(['idea', 'problem']),
    title: text(3, 160),
    problem: text(20, 5000),
    proposal: text(20, 5000).optional(),
    categoryId: z.uuid().optional(),
    departmentId: z.uuid().optional(),
    raisedBy: z.uuid().optional(),
  })
  .strict()
  .refine((v) => v.kind === 'problem' || !!v.proposal, { message: 'Для идеи опишите предлагаемое решение', path: ['proposal'] });

async function loadCandidate(c: Client, protocolId: string, candidateId: string) {
  const { rows } = await c.query<{ id: string; ord: number; status: string; title: string; quote: string }>(
    `SELECT k.id, k.ord, k.status, p.title, k.quote FROM protocol_candidates k JOIN meeting_protocols p ON p.id = k.protocol_id
      WHERE k.id = $2 AND k.protocol_id = $1 AND k.organization_id = app_org_id() FOR UPDATE OF k`,
    [protocolId, candidateId],
  );
  const k = rows[0];
  if (!k) throw notFound('Пункт протокола не найден');
  if (k.status !== 'proposed') throw conflict('По этому пункту уже принято решение');
  return k;
}

export async function acceptCandidate(db: Database, actor: OrgActor, protocolId: string, candidateId: string, input: z.infer<typeof AcceptCandidateInput>, key?: string) {
  if (!isLead(actor)) throw forbidden('Подтверждает пункты протокола руководитель или ведущий обращений');
  return withTx(db, orgTx(actor), async (c) =>
    idempotent(c, actor.userId, `advisor.accept:${candidateId}`, key, hashRequest(input), async () => {
      const k = await loadCandidate(c, protocolId, candidateId);
      const item = await createItem(c, actor, {
        kind: input.kind,
        title: input.title,
        problem: input.problem,
        proposal: input.proposal ?? null,
        successCriteria: null,
        categoryId: input.categoryId,
        departmentId: input.departmentId,
        sourceChannel: 'meeting',
        sourceNote: `Протокол «${k.title}», пункт ${k.ord}`.slice(0, 300),
        raisedBy: input.raisedBy,
      });
      await c.query(
        `UPDATE protocol_candidates SET status = 'accepted', item_id = $2, decided_by_membership_id = $3, decided_at = clock_timestamp() WHERE id = $1`,
        [candidateId, item.id, actor.membershipId],
      );
      await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'advisor.candidate_accepted', entityType: 'idea', entityId: item.id, data: { protocol: protocolId, candidate: candidateId } });
      return { status: 201, body: { item } };
    }),
  );
}

export async function dismissCandidate(db: Database, actor: OrgActor, protocolId: string, candidateId: string, key?: string) {
  if (!isLead(actor)) throw forbidden('Отклоняет пункты протокола руководитель или ведущий обращений');
  return withTx(db, orgTx(actor), async (c) =>
    idempotent(c, actor.userId, `advisor.dismiss:${candidateId}`, key, hashRequest({}), async () => {
      await loadCandidate(c, protocolId, candidateId);
      await c.query(
        `UPDATE protocol_candidates SET status = 'dismissed', decided_by_membership_id = $2, decided_at = clock_timestamp() WHERE id = $1`,
        [candidateId, actor.membershipId],
      );
      await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'advisor.candidate_dismissed', entityType: 'meeting_protocol', entityId: protocolId, data: { candidate: candidateId } });
      return { status: 201, body: { status: 'dismissed' } };
    }),
  );
}

// ---------------------------------------------------------------------------
// Executor suggestions
// ---------------------------------------------------------------------------
const norm = (s: string) => s.toLowerCase().replaceAll('ё', 'е');
/** A skill matches when every word of it (by its first 5 letters) occurs in the item text. */
export function skillMatches(skill: string, haystack: string): boolean {
  const words = norm(skill).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  return words.length > 0 && words.every((w) => haystack.includes(w.length > 5 ? w.slice(0, 5) : w));
}

export async function suggestExecutors(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number);
    const me = actor.membershipId;
    const leadsIt = me === idea.maintainer_membership_id || me === idea.decision_owner_membership_id;
    if (!leadsIt) throw forbidden('Подбор исполнителей видят ведущий обращения и ответственный за решение');
    const t = (
      await c.query<{ text: string }>(
        `SELECT concat_ws(' ', r.title, r.problem, r.proposal, o.category, o.department) AS text
           FROM idea_overview o JOIN idea_revisions r ON r.idea_id = o.id AND r.status = 'current'
          WHERE o.id = $1`,
        [idea.id],
      )
    ).rows[0]?.text ?? '';
    const hay = norm(t);
    const { rows } = await c.query<{
      membershipId: string;
      name: string;
      jobTitle: string | null;
      department: string | null;
      skills: string[];
      preferences: string | null;
      weeklyHours: number | null;
      load: number;
    }>(
      `SELECT e.membership_id AS "membershipId", e.display_name AS name, e.job_title AS "jobTitle", e.department,
              p.skills, p.preferences, p.weekly_hours AS "weeklyHours",
              (SELECT count(*)::int FROM ideas x WHERE x.organization_id = app_org_id()
                  AND x.implementer_membership_id = e.membership_id AND x.stage = 'adoption') AS load
         FROM employee_profiles p JOIN employees e ON e.membership_id = p.membership_id
        WHERE p.organization_id = app_org_id() AND e.status = 'active' AND e.access = 'member'`,
    );
    const confirmed = await c.query<{ candidate: string; name: string; confirmedBy: string; createdAt: Date; reasons: string[] }>(
      `SELECT x.candidate_membership_id AS candidate, e.display_name AS name, b.display_name AS "confirmedBy",
              x.created_at AS "createdAt", x.reasons
         FROM executor_confirmations x
         JOIN employees e ON e.membership_id = x.candidate_membership_id
         JOIN employees b ON b.membership_id = x.confirmed_by_membership_id
        WHERE x.idea_id = $1 ORDER BY x.created_at`,
      [idea.id],
    );
    const suggestions = rows
      .map((r) => {
        const matched = r.skills.filter((s) => skillMatches(s, hay));
        const reasons: string[] = [];
        if (matched.length) reasons.push(`Навыки из анкеты совпадают с текстом обращения: ${matched.join(', ')}`);
        if (r.weeklyHours !== null) reasons.push(`Указал(а) в анкете: ${r.weeklyHours} ч в неделю на улучшения`);
        reasons.push(r.load ? `Уже внедряет: ${r.load}` : 'Сейчас ничего не внедряет');
        if (r.preferences) reasons.push(`Предпочтения: ${r.preferences}`);
        if (r.membershipId === idea.raised_by_membership_id) reasons.push('Сам(а) поднял(а) этот вопрос');
        else if (r.membershipId === idea.author_membership_id) reasons.push('Автор обращения');
        return { ...r, matched, reasons, available: r.weeklyHours !== 0 };
      })
      .filter((r) => r.matched.length > 0 && r.available)
      .sort((a, b) => b.matched.length - a.matched.length || a.load - b.load || (b.weeklyHours ?? 0) - (a.weeklyHours ?? 0) || a.name.localeCompare(b.name, 'ru'))
      .slice(0, 5)
      .map(({ available: _a, ...r }) => r);
    const originator = me === idea.author_membership_id || me === idea.raised_by_membership_id;
    return {
      method: METHOD_LABEL.rules,
      explanation: 'Совпадение навыков из анкет с текстом обращения, затем меньшая текущая загрузка. Решение о назначении принимает человек.',
      profiles: rows.length,
      suggestions,
      confirmed: confirmed.rows,
      canConfirm: !originator && ['review', 'development', 'verification', 'decision', 'adoption'].includes(idea.stage),
    };
  });
}

export const ConfirmExecutorInput = z.object({ candidate: z.uuid(), reasons: z.array(text(1, 300)).max(8).default([]) }).strict();

export async function confirmExecutor(db: Database, actor: OrgActor, number: number, input: z.infer<typeof ConfirmExecutorInput>, key?: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true);
    return idempotent(c, actor.userId, `advisor.executor:${idea.id}`, key, hashRequest(input), async () => {
      const me = actor.membershipId;
      if (me !== idea.maintainer_membership_id && me !== idea.decision_owner_membership_id) throw forbidden('Исполнителя подтверждает ведущий или ответственный за решение');
      if (me === idea.author_membership_id || me === idea.raised_by_membership_id) throw forbidden('Для своего обращения исполнителя подтверждает другой руководитель');
      const exists = await c.query(
        `SELECT 1 FROM employees WHERE membership_id = $1 AND organization_id = app_org_id() AND status = 'active' AND access = 'member'`,
        [input.candidate],
      );
      if (!exists.rowCount) throw notFound('Сотрудник не найден');
      const dup = await c.query('SELECT 1 FROM executor_confirmations WHERE idea_id = $1 AND candidate_membership_id = $2', [idea.id, input.candidate]);
      if (dup.rowCount) throw conflict('Этот исполнитель уже подтверждён');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO executor_confirmations (organization_id, idea_id, candidate_membership_id, confirmed_by_membership_id, reasons)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [actor.orgId, idea.id, input.candidate, me, input.reasons],
      );
      await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'advisor.executor_confirmed', entityType: 'idea', entityId: idea.id, data: { candidate: input.candidate } });
      return { status: 201, body: { id: rows[0]!.id } };
    });
  });
}
