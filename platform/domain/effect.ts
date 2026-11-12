/**
 * Measured effect (ADR-0031): pairs a «before» and an «after» measurement of the same metric from the
 * existing verification evidence. Pure functions, no database.
 *
 * The rules are deliberately strict, because a wrong number here would look like proven savings:
 *   * no baseline or no result → «not measured», never zero;
 *   * different units, or conditions the measurer did not state as comparable → no difference, no percent;
 *   * every metric stands on its own line; nothing is summed across metrics, so a cost that went down
 *     is never mixed with a revenue that went up;
 *   * «improved» is said only when the baseline names which direction is the improvement.
 */
export interface Measurement {
  id: string;
  kind: string;
  metric: string | null;
  value: number | string | null;
  unit: string | null;
  period: string | null;
  source: string | null;
  goal: 'decrease' | 'increase' | null;
  comparable: boolean | null;
  createdAt: string | Date;
  recordedBy?: string | null;
  verificationId?: string;
}

export interface EffectPoint {
  evidenceId: string;
  value: number;
  unit: string | null;
  period: string | null;
  source: string | null;
  recordedBy: string | null;
  at: string;
}

export interface EffectLine {
  metric: string;
  state: 'measured' | 'not_measured' | 'incomparable';
  /** Why there is no number: what is missing or what does not match. */
  reason: 'no_baseline' | 'no_result' | 'units' | 'conditions' | null;
  goal: 'decrease' | 'increase' | null;
  before: EffectPoint | null;
  after: EffectPoint | null;
  /** after − before, in the unit of the metric; only when measured. */
  delta: number | null;
  /** Relative change in percent of the baseline; null when the baseline is zero or the line is not measured. */
  percent: number | null;
  verdict: 'improved' | 'worsened' | 'unchanged' | 'changed' | null;
}

const key = (s: string | null) => (s ?? '').trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ');
const num = (v: number | string | null): number | null => {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const iso = (d: string | Date) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const point = (m: Measurement): EffectPoint => ({ evidenceId: m.id, value: num(m.value)!, unit: m.unit?.trim() || null, period: m.period, source: m.source, recordedBy: m.recordedBy ?? null, at: iso(m.createdAt) });

export function effectLines(evidence: Measurement[]): EffectLine[] {
  const rows = evidence
    .filter((m) => (m.kind === 'baseline' || m.kind === 'result') && key(m.metric) !== '' && num(m.value) !== null)
    .sort((a, b) => iso(a.createdAt).localeCompare(iso(b.createdAt)));
  const order: string[] = [];
  const by = new Map<string, Measurement[]>();
  for (const m of rows) {
    const k = key(m.metric);
    if (!by.has(k)) order.push(k);
    by.set(k, [...(by.get(k) ?? []), m]);
  }
  return order.map((k) => {
    const list = by.get(k)!;
    const baseline = [...list].reverse().find((m) => m.kind === 'baseline') ?? null;
    // The «after» is a result recorded later than the baseline it is compared with.
    const result = baseline
      ? ([...list].reverse().find((m) => m.kind === 'result' && iso(m.createdAt) >= iso(baseline.createdAt)) ?? null)
      : ([...list].reverse().find((m) => m.kind === 'result') ?? null);
    const line: EffectLine = {
      metric: (baseline ?? result)!.metric!.trim(),
      state: 'not_measured',
      reason: null,
      goal: baseline?.goal ?? null,
      before: baseline ? point(baseline) : null,
      after: result ? point(result) : null,
      delta: null,
      percent: null,
      verdict: null,
    };
    if (!baseline) return { ...line, reason: 'no_baseline' };
    if (!result) return { ...line, reason: 'no_result' };
    if (key(baseline.unit) !== key(result.unit)) return { ...line, state: 'incomparable', reason: 'units' };
    if (result.comparable !== true) return { ...line, state: 'incomparable', reason: 'conditions' };
    const before = num(baseline.value)!;
    const after = num(result.value)!;
    const delta = round(after - before);
    const verdict = delta === 0 ? 'unchanged' : !baseline.goal ? 'changed' : (baseline.goal === 'decrease') === delta < 0 ? 'improved' : 'worsened';
    return { ...line, state: 'measured', delta, percent: before === 0 ? null : round((delta / Math.abs(before)) * 100, 1), verdict };
  });
}

const round = (n: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/** The effect of an item is «measured» only when at least one metric has a comparable before and after. */
export function effectMeasured(lines: EffectLine[]): boolean {
  return lines.some((l) => l.state === 'measured');
}

const fmt = (n: number) => String(n).replace('.', ',');
/** One plain sentence per measured metric, for the knowledge draft. Nothing is written for unmeasured lines. */
export function effectSentences(lines: EffectLine[]): string[] {
  return lines
    .filter((l) => l.state === 'measured')
    .map((l) => {
      const u = l.before!.unit ? ` ${l.before!.unit}` : '';
      const pct = l.percent === null ? '' : ` (${l.delta! > 0 ? '+' : '−'}${fmt(Math.abs(l.percent))}%)`;
      return `${l.metric}: было ${fmt(l.before!.value)}${u}, стало ${fmt(l.after!.value)}${u}${pct}; условия измерений сопоставимы по записи измерявшего.`;
    });
}
