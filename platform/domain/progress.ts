/**
 * Castle levels (owner brief 2026-11-11). Pure functions: the thresholds and
 * names come from the organization's settings (starting values: 0 / 100 / 250 /
 * 500 / 900 XP — Поселение, Крепость, Цитадель, Королевский замок, Легендарная
 * крепость). XP itself is written only by database triggers on confirmed events.
 */
export interface LevelConfig {
  thresholds: number[];
  names: string[];
  xpPerImplementation: number;
  xpEffectMax: number;
}

export interface LevelInfo {
  level: number; // 1..5
  name: string;
  floor: number;
  next: number | null;
  nextName: string | null;
  /** 0..1 share of the way to the next level (1 at the top level). */
  progress: number;
}

export function levelFor(xp: number, cfg: Pick<LevelConfig, 'thresholds' | 'names'>): LevelInfo {
  let i = 0;
  for (let k = 0; k < cfg.thresholds.length; k++) if (xp >= cfg.thresholds[k]!) i = k;
  const floor = cfg.thresholds[i]!;
  const next = cfg.thresholds[i + 1] ?? null;
  return {
    level: i + 1,
    name: cfg.names[i]!,
    floor,
    next,
    nextName: cfg.names[i + 1] ?? null,
    progress: next === null ? 1 : Math.max(0, Math.min(1, (xp - floor) / (next - floor))),
  };
}

/** Thresholds must start at 0 and grow strictly (mirrors app_levels_ok in the database). */
export function thresholdsValid(t: readonly number[]): boolean {
  return t.length === 5 && t[0] === 0 && t.every((v, i) => i === 0 || v > t[i - 1]!);
}

/** XP per 10 people of the department; null when the size is unknown. */
export function per10(value: number, headcount: number | null): number | null {
  if (!headcount) return null;
  return Math.round((value / headcount) * 10 * 10) / 10;
}
