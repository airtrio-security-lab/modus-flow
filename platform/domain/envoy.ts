/**
 * «Путь Посла» (ADR-0032). Pure functions and the registry of ranks and events; no database.
 *
 * Every employee has a symbolic envoy. Its look grows with PROVEN usefulness of the person's items,
 * never with their number: XP is written by the database (migration 0020) only for confirmed events,
 * and the rank is computed here from the ledger sum. A rank is a picture and a word — it grants no right.
 * The castle XP (domain/progress.ts) is a different sum and never mixes with this one.
 */
export interface EnvoyRank {
  rank: number; // 1..7
  name: string;
  /** For «Ваш посол достиг ранга …!». */
  genitive: string;
  /** What the envoy wears at this rank — shown on the profile next to the figure. */
  attire: string;
}

export const ENVOY_RANKS: readonly EnvoyRank[] = [
  { rank: 1, name: 'Гонец', genitive: 'Гонца', attire: 'Простой дорожный плащ, кожаная сумка, свиток' },
  { rank: 2, name: 'Вестник', genitive: 'Вестника', attire: 'Качественный плащ, пояс, бронзовая застёжка' },
  { rank: 3, name: 'Доверенный посланник', genitive: 'Доверенного посланника', attire: 'Длинная мантия, герб подразделения, официальная печать' },
  { rank: 4, name: 'Герольд', genitive: 'Герольда', attire: 'Парадное одеяние, серебряный жезл, небольшое знамя' },
  { rank: 5, name: 'Посол Совета', genitive: 'Посла Совета', attire: 'Вышитый плащ, золотая цепь, украшенный свиток' },
  { rank: 6, name: 'Великий посол', genitive: 'Великого посла', attire: 'Торжественная мантия, золотой жезл, знаки отличия' },
  { rank: 7, name: 'Посол Великого Содружества', genitive: 'Посла Великого Содружества', attire: 'Церемониальное одеяние и символы всех цивилизаций Содружества' },
];

/** Starting thresholds (mirrors the default of organizations.envoy_rank_thresholds). */
export const DEFAULT_ENVOY_THRESHOLDS = [0, 20, 60, 140, 280, 500, 800] as const;

export type EnvoyEventKind = 'resolution' | 'implementation' | 'effect';

/**
 * Confirmed events and their starting XP (mirrors organizations.envoy_xp_*). `enabled: false` means
 * nothing writes it: the current model has no verifiable «problem resolved» event apart from an
 * implementation, so it waits for the owner's decision (ADR-0032).
 */
export const ENVOY_EVENTS: Record<EnvoyEventKind, { xp: number; enabled: boolean; label: string }> = {
  resolution: { xp: 5, enabled: false, label: 'проблема подтверждённо решена' },
  implementation: { xp: 20, enabled: true, label: 'подтверждено внедрение' },
  effect: { xp: 30, enabled: true, label: 'подтверждён измеримый положительный эффект' },
};

/** Things that never bring envoy XP — listed so the rule is visible where it is read. */
export const ENVOY_NO_XP = [
  'отправка обращения',
  'прибытие посла на аудиенцию',
  'принятие посла Королём',
  'комментарии и открытие приложения',
  'отклонение или закрытие обращения',
] as const;

export interface EnvoyRankInfo {
  rank: number;
  name: string;
  genitive: string;
  attire: string;
  /** XP at which this rank starts. */
  floor: number;
  /** XP of the next rank, or null at rank VII (XP keeps counting, the rank does not grow). */
  next: number | null;
  nextName: string | null;
  /** 0..1 of the way to the next rank; 1 at rank VII. */
  progress: number;
}

export function envoyThresholdsValid(t: readonly number[]): boolean {
  return t.length === 7 && t[0] === 0 && t.every((v, i) => i === 0 || v > t[i - 1]!);
}

export function envoyRankFor(xp: number, thresholds: readonly number[] = DEFAULT_ENVOY_THRESHOLDS): EnvoyRankInfo {
  const t = envoyThresholdsValid(thresholds) ? thresholds : DEFAULT_ENVOY_THRESHOLDS;
  let i = 0;
  for (let k = 0; k < t.length; k++) if (xp >= t[k]!) i = k;
  const r = ENVOY_RANKS[i]!;
  const floor = t[i]!;
  const next = t[i + 1] ?? null;
  return {
    rank: r.rank,
    name: r.name,
    genitive: r.genitive,
    attire: r.attire,
    floor,
    next,
    nextName: ENVOY_RANKS[i + 1]?.name ?? null,
    progress: next === null ? 1 : Math.max(0, Math.min(1, (xp - floor) / (next - floor))),
  };
}

export const envoyRankName = (rank: number) => ENVOY_RANKS[Math.max(1, Math.min(7, rank)) - 1]!.name;

/** «Ваш посол достиг ранга Герольда!» — always the rank actually reached. */
export const rankUpText = (rank: number) => `Ваш посол достиг ранга ${ENVOY_RANKS[Math.max(1, Math.min(7, rank)) - 1]!.genitive}!`;

/** One ledger line as a sentence with its basis: «+20 XP — подтверждено внедрение обращения №126». */
export function awardText(kind: EnvoyEventKind, xp: number, number: number): string {
  return `+${xp} XP — ${ENVOY_EVENTS[kind].label} обращения №${number}`;
}
