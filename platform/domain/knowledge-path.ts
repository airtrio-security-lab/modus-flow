/**
 * «Путь решения» (ADR-0040): how one person's experience became the organization's knowledge.
 *
 * Pure: no database, no clock. The module takes facts that are ALREADY recorded — the item, the
 * council's entries, the decisions, the verifications with their evidence, the implementation report,
 * the confirmed effect, the knowledge's own transitions, its re-applications — and lays them out as a
 * path with branches. It keeps no history of its own and concludes nothing that a fact does not say:
 *
 *   * a branch is a source of the knowledge; several sources are several branches, the unsuccessful
 *     one next to the successful one — negative experience is never dropped;
 *   * a source the reader may not open is a branch with no title and no events;
 *   * a step that did not happen is absent, not drawn as «pending»;
 *   * the visible depth is limited; what is folded is counted, never silently cut.
 *
 * No text written by people is copied here: a node carries the kind of the event, a count and a link
 * to the real record, where the text lives under that record's own access rules.
 */
export type Tone = 'ok' | 'no' | 'wait' | 'info';
export type NodeType = 'item' | 'council' | 'meeting' | 'finding' | 'decision' | 'verification' | 'implementation' | 'effect' | 'knowledge' | 'library' | 'application';

export interface PathNode {
  type: NodeType;
  /** The kind of the event, in words. */
  kind: string;
  title: string;
  detail: string | null;
  at: string | null;
  status: { tone: Tone; label: string };
  /** Where the fact is recorded. */
  source: string;
  link: string | null;
}
export interface PathBranch {
  source: { type: 'idea' | 'meeting' | 'finding' | 'knowledge'; label: string; link: string | null; available: boolean };
  outcome: { tone: Tone; label: string };
  nodes: PathNode[];
  /** Events of this branch folded away by the depth limit. */
  folded: number;
}
export interface SolutionPath {
  branches: PathBranch[];
  /** Sources beyond the visible limit. */
  foldedBranches: number;
  /** What happened to the knowledge itself, after the branches meet. */
  trunk: PathNode[];
  foldedTrunk: number;
  uses: PathUse[];
  foldedUses: number;
  note: string;
}
export interface PathUse {
  number: number;
  title: string;
  link: string;
  /** Started by its author with «Применить этот метод». */
  started: boolean;
  startedAt: string | null;
  /** A curator recorded it as a re-application. */
  recorded: boolean;
  status: { tone: Tone; label: string };
}

export const LIMITS = { branches: 6, nodes: 9, trunk: 6, uses: 8 } as const;

// ---------------------------------------------------------------------------
// Input: rows as the database returns them, already filtered by the reader's rights.
// ---------------------------------------------------------------------------
export interface IdeaFacts {
  number: number;
  title: string;
  statusLabel: string;
  publishedAt: string;
  council: { kind: string; recommendation: string | null; at: string }[];
  meetings: { at: string }[];
  decisions: { outcome: 'merge' | 'reject' | 'close' | string; at: string }[];
  verifications: { purpose: 'hypothesis' | 'impact' | string; status: string; outcome: string | null; evidence: number; at: string }[];
  implementedAt: string | null;
  effectAt: string | null;
}
export type SourceIn =
  | { type: 'idea'; idea: IdeaFacts | null }
  | { type: 'meeting' | 'finding' | 'knowledge'; label: string; link: string | null; available: boolean; at: string | null };
export interface TransitionIn {
  action: string;
  title: string;
  at: string;
}
export interface UseIn {
  number: number;
  title: string;
  startedAt: string | null;
  recorded: boolean;
  implemented: boolean;
  effectConfirmed: boolean;
  lastDecision: string | null;
}

const DECISION: Record<string, { tone: Tone; label: string }> = {
  merge: { tone: 'ok', label: 'внедрять' },
  reject: { tone: 'no', label: 'не внедрять' },
  close: { tone: 'info', label: 'закрыть' },
};
const OUTCOME: Record<string, { tone: Tone; label: string }> = {
  positive: { tone: 'ok', label: 'подтвердилось' },
  negative: { tone: 'no', label: 'не подтвердилось' },
  inconclusive: { tone: 'wait', label: 'вывод не сделан' },
};
const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10;
  const h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`;
};

const RECOMMENDATION: Record<string, string> = { implement: 'внедрить', pilot: 'провести пилот', clarify: 'уточнить', reject: 'отклонить', rework: 'доработать' };

function councilDetail(entries: { kind: string; recommendation: string | null; at: string }[]): string {
  const count = (k: string) => entries.filter((e) => e.kind === k).length;
  const parts = [
    count('recommendation') ? plural(count('recommendation'), 'рекомендация', 'рекомендации', 'рекомендаций') : '',
    count('argument_for') ? plural(count('argument_for'), 'довод «за»', 'довода «за»', 'доводов «за»') : '',
    count('argument_against') ? plural(count('argument_against'), 'довод «против»', 'довода «против»', 'доводов «против»') : '',
    count('dissent') ? plural(count('dissent'), 'особое мнение', 'особых мнения', 'особых мнений') : '',
  ].filter(Boolean);
  // The council's last recommendation is a recorded choice from a fixed list, not somebody's words.
  const last = entries.filter((e) => e.kind === 'recommendation' && e.recommendation).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  const counts = parts.length ? parts.join(', ') : plural(entries.length, 'запись', 'записи', 'записей');
  return last ? `${counts}; последняя рекомендация — ${RECOMMENDATION[last.recommendation!] ?? last.recommendation}` : counts;
}

/** The result of one source, from facts only. */
export function ideaOutcome(i: IdeaFacts): { tone: Tone; label: string } {
  const last = i.decisions.at(-1)?.outcome;
  if (i.effectAt) return { tone: 'ok', label: 'внедрено, результат подтверждён' };
  if (i.implementedAt) return { tone: 'ok', label: 'внедрено, результат ещё не подтверждён' };
  if (last === 'reject') return { tone: 'no', label: 'не внедрено' };
  if (last === 'close') return { tone: 'info', label: 'закрыто без внедрения' };
  if (last === 'merge') return { tone: 'wait', label: 'решено внедрять, внедрение не завершено' };
  return { tone: 'wait', label: 'решение не принято' };
}

function ideaBranch(i: IdeaFacts): PathBranch {
  const link = `#/items/${i.number}`;
  const src = `обращение №${i.number}`;
  const nodes: PathNode[] = [{ type: 'item', kind: 'Обращение', title: `Обращение №${i.number}`, detail: `«${i.title}»`, at: i.publishedAt, status: { tone: 'info', label: i.statusLabel }, source: src, link }];
  if (i.council.length) {
    const at = i.council.map((e) => e.at).sort().at(-1)!;
    nodes.push({ type: 'council', kind: 'Обсуждение в Совете', title: 'Обсуждение в Совете', detail: councilDetail(i.council), at, status: { tone: 'info', label: 'обсуждено' }, source: src, link: `#/council/${i.number}` });
  }
  for (const m of i.meetings) nodes.push({ type: 'meeting', kind: 'Заседание', title: 'Заседание по обращению', detail: null, at: m.at, status: { tone: 'info', label: 'материалы — у участников' }, source: src, link });
  for (const d of i.decisions) {
    const s = DECISION[d.outcome] ?? { tone: 'info' as Tone, label: d.outcome };
    nodes.push({ type: 'decision', kind: 'Решение', title: 'Решение уполномоченного сотрудника', detail: `Решение: ${s.label}`, at: d.at, status: s, source: src, link });
  }
  for (const v of i.verifications) {
    const done = v.status === 'completed' && v.outcome ? OUTCOME[v.outcome] : null;
    const status = done ?? (v.status === 'cancelled' ? { tone: 'info' as Tone, label: 'отменена' } : { tone: 'wait' as Tone, label: v.status === 'running' ? 'идёт' : 'запланирована' });
    const evidence = v.evidence ? `сохранено: ${plural(v.evidence, 'доказательство', 'доказательства', 'доказательств')}` : 'доказательства не сохранены';
    nodes.push({ type: 'verification', kind: 'Проверка', title: v.purpose === 'impact' ? 'Измерение эффекта' : 'Проверка гипотезы', detail: evidence, at: v.at, status, source: src, link });
  }
  if (i.implementedAt) nodes.push({ type: 'implementation', kind: 'Внедрение', title: 'Внедрение', detail: 'Исполнитель сообщил, что изменение внедрено', at: i.implementedAt, status: { tone: 'ok', label: 'внедрено' }, source: src, link });
  if (i.effectAt) nodes.push({ type: 'effect', kind: 'Результат', title: 'Результат подтверждён', detail: 'Эффект подтвердил ответственный за решение', at: i.effectAt, status: { tone: 'ok', label: 'подтверждено' }, source: src, link });
  // The item itself opens the branch; everything after it is in the order it happened.
  const [first, ...rest] = nodes;
  rest.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const ordered = [first!, ...rest];
  // Folding keeps the beginning and the end: how it started and how it ended are never hidden.
  const keep = ordered.length > LIMITS.nodes ? [...ordered.slice(0, LIMITS.nodes - 3), ...ordered.slice(-3)] : ordered;
  return { source: { type: 'idea', label: `Обращение №${i.number}`, link, available: true }, outcome: ideaOutcome(i), nodes: keep, folded: ordered.length - keep.length };
}

const TRUNK: Record<string, Tone> = {
  registered: 'info',
  library_accepted: 'ok',
  library_rejected: 'no',
  archive_approved: 'ok',
  archive_rejected: 'no',
  reverify_requested: 'wait',
  reconfirmed: 'ok',
  outdated: 'no',
  opened_to_organization: 'info',
};

export function useStatus(u: UseIn): { tone: Tone; label: string } {
  if (u.lastDecision === 'reject') return { tone: 'no', label: 'Не применено: по обращению решено не внедрять' };
  if (u.lastDecision === 'close' && !u.implemented) return { tone: 'info', label: 'Не применено: обращение закрыто без внедрения' };
  if (u.recorded && u.implemented) return { tone: 'ok', label: u.effectConfirmed ? 'Применение подтверждено: внедрено, результат подтверждён' : 'Применение подтверждено: внедрено' };
  return { tone: 'wait', label: 'Применение ещё не подтверждено' };
}

export function assemblePath(input: { sources: SourceIn[]; transitions: TransitionIn[]; uses: UseIn[] }): SolutionPath {
  const all: PathBranch[] = input.sources.map((s) => {
    if (s.type === 'idea') {
      return s.idea ? ideaBranch(s.idea) : { source: { type: 'idea', label: 'Источник недоступен вам', link: null, available: false }, outcome: { tone: 'info', label: 'закрыт для вас' }, nodes: [], folded: 0 };
    }
    if (!s.available) return { source: { type: s.type, label: s.label, link: null, available: false }, outcome: { tone: 'info', label: 'закрыт для вас' }, nodes: [], folded: 0 };
    const kind = s.type === 'meeting' ? 'Заседание' : s.type === 'finding' ? 'Находка заседания' : 'Знание';
    return {
      source: { type: s.type, label: s.label, link: s.link, available: true },
      outcome: { tone: 'info', label: 'источник' },
      nodes: [{ type: s.type, kind, title: s.label, detail: null, at: s.at, status: { tone: 'info', label: 'источник' }, source: kind.toLowerCase(), link: s.link }],
      folded: 0,
    };
  });
  // Sources with a recorded result first, in the order they began; closed ones last.
  const rank = (b: PathBranch) => (b.source.available ? 0 : 1);
  const sorted = [...all].sort((a, b) => rank(a) - rank(b) || (a.nodes[0]?.at ?? '').localeCompare(b.nodes[0]?.at ?? ''));
  const branches = sorted.slice(0, LIMITS.branches);

  const key = input.transitions.filter((t) => t.action in TRUNK).sort((a, b) => a.at.localeCompare(b.at));
  const shown = key.length > LIMITS.trunk ? [key[0]!, ...key.slice(-(LIMITS.trunk - 1))] : key;
  const trunk: PathNode[] = shown.map((t) => ({
    type: t.action === 'registered' ? 'knowledge' : 'library',
    kind: t.action === 'registered' ? 'Летопись' : t.action.startsWith('archive') ? 'Высший Архив' : 'Великая библиотека',
    title: t.title,
    detail: null,
    at: t.at,
    status: { tone: TRUNK[t.action]!, label: TRUNK[t.action] === 'ok' ? 'подтверждено' : TRUNK[t.action] === 'no' ? 'отклонено' : TRUNK[t.action] === 'wait' ? 'ждёт проверки' : 'записано' },
    source: 'Великая библиотека',
    link: null,
  }));

  const uses = [...input.uses].sort((a, b) => a.number - b.number);
  return {
    branches,
    foldedBranches: sorted.length - branches.length,
    trunk,
    foldedTrunk: input.transitions.length - trunk.length,
    uses: uses.slice(0, LIMITS.uses).map((u) => ({ number: u.number, title: u.title, link: `#/items/${u.number}`, started: u.startedAt !== null, startedAt: u.startedAt, recorded: u.recorded, status: useStatus(u) })),
    foldedUses: Math.max(0, uses.length - LIMITS.uses),
    note: 'Путь собран из записей, которые уже есть в системе и доступны вам. Шаги, которых не было, не показаны.',
  };
}
