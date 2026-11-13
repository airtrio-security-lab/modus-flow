import type { Client } from '../db/pool.ts';
import { assemblePath, type IdeaFacts, type SolutionPath, type SourceIn, type TransitionIn, type UseIn } from '../domain/knowledge-path.ts';
import { STATUS_INFO, type ItemStatus } from '../domain/status.ts';

/**
 * «Путь решения» (ADR-0040), the reading side. Every query runs as the reader, inside the reader's
 * transaction: row-level security decides what exists for them. An item they may not open returns no
 * row from `idea_overview`, and the branch is drawn closed — without a number, a title or an event.
 * Nothing is written and nothing new is stored: the path is a view of what the workflow recorded.
 */
const iso = (d: Date | null) => d?.toISOString() ?? null;

async function ideaFacts(c: Client, ideaId: string): Promise<IdeaFacts | null> {
  const i = (await c.query<{ number: number; title: string; status: string; published_at: Date }>('SELECT number, title, status, published_at FROM idea_overview WHERE id = $1', [ideaId])).rows[0];
  if (!i) return null;
  const council = await c.query<{ kind: string; recommendation: string | null; at: Date }>('SELECT kind, recommendation, created_at AS at FROM council_entries WHERE idea_id = $1 ORDER BY created_at', [ideaId]);
  const meetings = await c.query<{ at: Date }>('SELECT coalesce(scheduled_at, created_at) AS at FROM meetings WHERE idea_id = $1 ORDER BY 1', [ideaId]);
  const decisions = await c.query<{ outcome: string; at: Date }>('SELECT outcome, created_at AS at FROM decisions WHERE idea_id = $1 ORDER BY created_at', [ideaId]);
  const verifications = await c.query<{ purpose: string; status: string; outcome: string | null; evidence: number; at: Date }>(
    `SELECT v.purpose, v.status, v.outcome, coalesce(v.completed_at, v.started_at, v.created_at) AS at,
            (SELECT count(*)::int FROM verification_evidence e WHERE e.verification_id = v.id) AS evidence
       FROM verifications v WHERE v.idea_id = $1 ORDER BY v.created_at`,
    [ideaId],
  );
  // «Implemented» is the workflow's own fact (0012 app_idea_implemented); its date is the implementation report's.
  const done = await c.query<{ implemented: boolean; at: Date | null }>(
    `SELECT app_idea_implemented($1) AS implemented, (SELECT max(r.created_at) FROM reviews r WHERE r.idea_id = $1 AND r.kind = 'progress') AS at`,
    [ideaId],
  );
  const effect = await c.query<{ at: Date }>('SELECT created_at AS at FROM effect_approvals WHERE idea_id = $1 ORDER BY created_at LIMIT 1', [ideaId]);
  return {
    number: i.number,
    title: i.title,
    statusLabel: STATUS_INFO[i.status as ItemStatus]?.label ?? i.status,
    publishedAt: i.published_at.toISOString(),
    council: council.rows.map((r) => ({ kind: r.kind, recommendation: r.recommendation, at: r.at.toISOString() })),
    meetings: meetings.rows.map((r) => ({ at: r.at.toISOString() })),
    decisions: decisions.rows.map((r) => ({ outcome: r.outcome, at: r.at.toISOString() })),
    verifications: verifications.rows.map((r) => ({ purpose: r.purpose, status: r.status, outcome: r.outcome, evidence: r.evidence, at: r.at.toISOString() })),
    implementedAt: done.rows[0]?.implemented ? iso(done.rows[0].at) : null,
    effectAt: iso(effect.rows[0]?.at ?? null),
  };
}

/** Other sources come from the knowledge page's own reading of them (`legacy.sourceDetails`): one rule of visibility, not two. */
export interface OtherSource {
  type: 'meeting' | 'finding' | 'knowledge';
  label: string;
  link: string | null;
  available: boolean;
}

export async function solutionPath(c: Client, knowledgeId: string, others: OtherSource[], transitions: TransitionIn[]): Promise<SolutionPath> {
  const ideaSources = await c.query<{ source_id: string }>(`SELECT source_id FROM knowledge_sources WHERE knowledge_id = $1 AND source_type = 'idea' ORDER BY created_at`, [knowledgeId]);
  const sources: SourceIn[] = [];
  for (const s of ideaSources.rows) sources.push({ type: 'idea', idea: await ideaFacts(c, s.source_id) });
  for (const o of others) sources.push({ ...o, at: null });

  // Items started from this knowledge (0022) and re-applications recorded by a curator (0012): one list,
  // only the items the reader may open — `idea_overview` and both tables are under row-level security.
  const uses = await c.query<{ number: number; title: string; started_at: Date | null; recorded: boolean; implemented: boolean; effect: boolean; last_decision: string | null }>(
    `SELECT o.number, o.title, l.created_at AS started_at, (a.idea_id IS NOT NULL) AS recorded,
            app_idea_implemented(o.id) AS implemented, app_idea_effect_confirmed(o.id) AS effect,
            (SELECT d.outcome FROM decisions d WHERE d.idea_id = o.id ORDER BY d.created_at DESC LIMIT 1) AS last_decision
       FROM (SELECT idea_id FROM idea_method_links WHERE knowledge_id = $1
             UNION SELECT idea_id FROM knowledge_applications WHERE knowledge_id = $1) u
       JOIN idea_overview o ON o.id = u.idea_id
       LEFT JOIN idea_method_links l ON l.idea_id = o.id AND l.knowledge_id = $1
       LEFT JOIN knowledge_applications a ON a.idea_id = o.id AND a.knowledge_id = $1
      ORDER BY o.number`,
    [knowledgeId],
  );
  const usesIn: UseIn[] = uses.rows.map((u) => ({ number: u.number, title: u.title, startedAt: iso(u.started_at), recorded: u.recorded, implemented: u.implemented, effectConfirmed: u.effect, lastDecision: u.last_decision }));
  return assemblePath({ sources, transitions, uses: usesIn });
}

/** The knowledge an item was started from, as its reader may see it — or null. */
export async function methodOfItem(c: Client, ideaId: string): Promise<{ id: string; title: string; hall: string; startedAt: string } | null> {
  const r = (
    await c.query<{ id: string; title: string; level: string; at: Date }>(
      `SELECT k.id, k.title, k.level, l.created_at AS at FROM idea_method_links l JOIN knowledge_items k ON k.id = l.knowledge_id WHERE l.idea_id = $1`,
      [ideaId],
    )
  ).rows[0];
  if (!r) return null;
  return { id: r.id, title: r.title, hall: r.level === 'archive' ? 'Высший Архив' : 'Библиотека решений', startedAt: r.at.toISOString() };
}
