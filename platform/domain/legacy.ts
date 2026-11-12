/**
 * «Наследие Королевства» (ADR-0017): vocabulary and pure rules of organizational memory.
 * One model, three levels. The database (0012_legacy.sql) enforces the same rules;
 * this file gives them names, Russian wording and the copy guard.
 */
import { z } from 'zod';

export const LEVELS = ['chronicle', 'library', 'archive'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_TITLE: Record<Level, string> = { chronicle: 'Летопись', library: 'Библиотека решений', archive: 'Высший Архив' };
/** What the level says about checking — shown next to every search result. */
export const LEVEL_PROOF: Record<Level, string> = {
  chronicle: 'зарегистрировано, не проверено',
  library: 'проверено Архивариусом',
  archive: 'утверждено как наследие',
};

export const KINDS = ['problem', 'decision', 'method', 'improvement', 'discovery', 'lesson', 'history'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_TITLE: Record<Kind, string> = {
  problem: 'Проблема',
  decision: 'Решение',
  method: 'Метод',
  improvement: 'Улучшение',
  discovery: 'Открытие',
  lesson: 'Урок из ошибки',
  history: 'Историческое решение',
};

export const ARCHIVE_CATEGORIES = ['method', 'improvement', 'reapplied', 'discovery', 'lesson', 'history'] as const;
export const ARCHIVE_CATEGORY_TITLE: Record<(typeof ARCHIVE_CATEGORIES)[number], string> = {
  method: 'Проверенный воспроизводимый метод',
  improvement: 'Подтверждённое улучшение',
  reapplied: 'Повторно успешно применённое решение',
  discovery: 'Важное инженерное открытие',
  lesson: 'Существенная ошибка с доказанным уроком',
  history: 'Исторически значимое решение',
};

export const STATUS_TITLE = { active: 'действует', needs_review: 'требует повторной проверки', outdated: 'устарело' } as const;

export const ACTIONS = [
  'library_proposed', 'library_accepted', 'library_rejected',
  'archive_proposed', 'archive_approved', 'archive_rejected',
  'reverify_requested', 'reconfirmed', 'outdated', 'opened_to_organization',
] as const;
export type Action = (typeof ACTIONS)[number];
export const ACTION_TITLE: Record<Action | 'registered' | 'revised' | 'source_added' | 'application_added', string> = {
  registered: 'Зарегистрировано в Летописи',
  revised: 'Новая версия карточки',
  source_added: 'Добавлен источник',
  application_added: 'Записано повторное применение',
  library_proposed: 'Предложено в Библиотеку',
  library_accepted: 'Архивариус внёс в Библиотеку',
  library_rejected: 'Архивариус вернул на доработку',
  archive_proposed: 'Архивариус представил заключение для Высшего Архива',
  archive_approved: 'Включение в Высший Архив утверждено',
  archive_rejected: 'Включение в Высший Архив отклонено',
  reverify_requested: 'Запрошена повторная проверка',
  reconfirmed: 'Подтверждено повторно',
  outdated: 'Отмечено как устаревшее',
  opened_to_organization: 'Открыто всей организации',
};

const t = (max: number) => z.string().trim().max(max).optional();
/** The structured card. Every field is written by a person; nothing here is generated. */
export const Card = z
  .object({
    problem: t(3000),
    options: t(3000),
    argumentsFor: t(3000),
    argumentsAgainst: t(3000),
    decision: t(3000),
    initiator: z.uuid().optional(),
    responsible: z.array(z.uuid()).max(10).optional(),
    reasons: t(3000),
    actions: z.array(z.object({ what: z.string().trim().min(2).max(300), due: z.iso.date().optional() }).strict()).max(20).optional(),
    results: t(3000),
    positive: t(3000),
    negative: t(3000),
    evidence: t(3000),
    // Higher Archive — the archivist's conclusion
    archiveCategory: z.enum(ARCHIVE_CATEGORIES).optional(),
    proof: t(2000),
    applicability: t(2000),
    lastChecked: z.iso.date().optional(),
    basis: t(2000),
  })
  .strict();
export type CardT = z.infer<typeof Card>;

const TEXT_FIELDS = ['problem', 'options', 'argumentsFor', 'argumentsAgainst', 'decision', 'reasons', 'results', 'positive', 'negative', 'evidence', 'proof', 'applicability', 'basis'] as const;

export function cardText(card: CardT): string {
  return [...TEXT_FIELDS.map((f) => card[f] ?? ''), ...(card.actions ?? []).map((a) => a.what)].join('\n');
}

const words = (s: string) => s.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Longest run of consecutive words shared by `text` and `source`. Used to stop full
 * passages of a meeting transcript from moving into knowledge, where they would
 * outlive the transcript's retention period and its access limits.
 */
export function longestSharedRun(text: string, source: string): number {
  const a = words(text);
  const b = words(source);
  if (!a.length || !b.length) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}
/** A quote of up to 11 words is a citation; 12 and more is a copy of the record. */
export const MAX_QUOTED_WORDS = 11;

/**
 * Brief historical note assembled from the card fields by a fixed template.
 * It is labelled as a template everywhere it is shown: it is not AI analysis.
 */
export function templateNote(x: { title: string; level: Level; card: CardT; createdAt: string; applications: number }): string {
  const c = x.card;
  const parts = [`«${x.title}» — ${LEVEL_TITLE[x.level].toLowerCase()}, с ${x.createdAt.slice(0, 10)}.`];
  if (c.problem) parts.push(`Проблема: ${firstSentence(c.problem)}`);
  if (c.decision) parts.push(`Решение: ${firstSentence(c.decision)}`);
  if (c.reasons) parts.push(`Почему: ${firstSentence(c.reasons)}`);
  if (c.results) parts.push(`Результат: ${firstSentence(c.results)}`);
  if (c.positive || c.negative) parts.push(`Чему научились: ${firstSentence(c.positive ?? c.negative ?? '')}`);
  if (x.applications) parts.push(`Применено повторно: ${x.applications}.`);
  return parts.join(' ');
}
function firstSentence(s: string) {
  const m = s.trim().match(/^.{1,220}?[.!?](\s|$)/s);
  return (m ? m[0] : s.trim().slice(0, 220)).trim();
}
