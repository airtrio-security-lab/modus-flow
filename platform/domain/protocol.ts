/**
 * MODUS ADVISOR · finding tasks in a meeting protocol (ADR-0013).
 *
 * The default method is a transparent rule-based parser. It is NOT artificial
 * intelligence and the interface says so («Разбор по шаблону, без ИИ»): it
 * looks for lines that read like a decision, an assignment, a problem or a
 * proposal and keeps each one verbatim as evidence. A person confirms every
 * candidate before it becomes an item.
 *
 * Every candidate, whatever produced it, carries the exact quote and its
 * offsets in the source text; `validateQuotes` drops anything a model
 * returned that is not literally present in the protocol.
 */
export interface Candidate {
  ord: number;
  quoteStart: number;
  quoteEnd: number;
  quote: string;
  title: string;
  kind: 'problem' | 'idea';
  raiser: string | null;
  /** Why the line was picked: shown next to the quote. */
  signal: string;
}

export const MAX_CANDIDATES = 30;

const BULLET = /^(?:[-–—•*·]|\d{1,2}[.)]|\[\s?\])\s+/;
const SPEAKER = /^([А-ЯЁA-Z][а-яёa-z-]+(?:\s+[А-ЯЁA-Z][а-яёa-z-]+)?)\s*:\s+(?=\S)/;
const ACTION_HEADER = /^(?:решили|решения|решение|поручения|поручили|задачи|итоги|что делаем|action items)\s*:?\s*$/i;
const NON_ACTION_HEADER = /^[^:]{2,40}:\s*$/;
const RAISED_BY = /\((?:поднял[аи]?|предложил[аи]?|автор)\s*:?\s*([А-ЯЁA-Z][а-яёa-z-]+(?:\s+[А-ЯЁA-Z][а-яёa-z-]+)?)\)/;

/** JS \b is ASCII-only; these lookarounds give word boundaries for Cyrillic. */
const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
const words = (alts: string, atStart = false) => new RegExp(`${atStart ? '^' : L}(?:${alts})${R}`, 'iu');

const START_DECISION = 'решили|решение|поручение|поручили|поручить';
const START_TASK = 'задача|todo|сделать';
const START_PROBLEM = 'проблема|жалоба|замечание';
const START_IDEA = 'предлагаю|предложение|предложила|предложили|предложил|идея';
const PROBLEM_WORDS = 'проблема|жалоба|не работает|не работают|завис\\p{L}*|лома\\p{L}*|сломал\\p{L}*|не хватает|нет\\s+\\p{L}+|приходится|теряем|задерж\\p{L}*|ошиб\\p{L}*|опаздыва\\p{L}*';

const signals: { re: RegExp; label: string }[] = [
  { re: words(START_DECISION, true), label: 'решение или поручение' },
  { re: words(START_TASK, true), label: 'задача' },
  { re: words(START_PROBLEM, true), label: 'проблема' },
  { re: words(START_IDEA, true), label: 'предложение' },
  { re: words('нужно|надо|необходимо|прошу|просьба'), label: '«нужно / надо»' },
  { re: words(PROBLEM_WORDS), label: 'описание проблемы' },
  { re: words('предлагаю|давайте|можно\\s+бы'), label: 'предложение' },
];
const problemRe = words(PROBLEM_WORDS);
const ideaRe = new RegExp(`^(?:${START_IDEA})${R}|${L}(?:предлагаю|давайте)${R}`, 'iu');
const STRIP_MARKER = new RegExp(`^(?:${START_DECISION}|${START_TASK}|${START_PROBLEM}|${START_IDEA})${R}\\s*[:—–-]?\\s*`, 'iu');

/** A one-line title from the line content: marker words stripped, first sentence, ≤ 120 chars. */
export function titleOf(content: string): string {
  let t = content
    .replace(RAISED_BY, '')
    .replace(STRIP_MARKER, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = (t.split(/(?<=[.!?…])\s/)[0] ?? t).replace(/[.…;,]+$/, '');
  if (t.length > 120) {
    const cut = t.slice(0, 120);
    t = `${cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : 120)}…`;
  }
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length >= 3 ? t : content.trim().slice(0, 120);
}

/** Rule-based extraction. Deterministic: the same text always gives the same candidates. */
export function extractByRules(text: string): Candidate[] {
  const out: Candidate[] = [];
  let pos = 0;
  let inActions = false;
  let lastSpeaker: string | null = null;
  for (const raw of text.split('\n')) {
    const lineStart = pos;
    pos += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    const lead = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (!trimmed) {
      inActions = false;
      lastSpeaker = null;
      continue;
    }
    if (ACTION_HEADER.test(trimmed)) {
      inActions = true;
      lastSpeaker = null;
      continue;
    }
    if (NON_ACTION_HEADER.test(trimmed) && !SPEAKER.test(`${trimmed} x`)) {
      inActions = false;
      continue;
    }
    let content = trimmed.replace(BULLET, '');
    const bullet = content !== trimmed;
    const sp = SPEAKER.exec(content);
    if (sp) {
      lastSpeaker = sp[1]!;
      content = content.slice(sp[0].length);
    } else if (!bullet) lastSpeaker = null;
    if (content.length < 15 || trimmed.length > 1000) continue;

    const hit = signals.find((s) => s.re.test(content));
    const signal = hit?.label ?? (inActions && bullet ? 'пункт в разделе решений' : null);
    if (!signal) continue;

    const quote = trimmed;
    const start = lineStart + lead;
    const raisedBy = RAISED_BY.exec(content)?.[1] ?? (sp ? sp[1]! : bullet ? lastSpeaker : null);
    out.push({
      ord: out.length + 1,
      quoteStart: start,
      quoteEnd: start + quote.length,
      quote,
      title: titleOf(content),
      kind: problemRe.test(content) && !ideaRe.test(content) ? 'problem' : 'idea',
      raiser: raisedBy,
      signal,
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export interface ModelItem {
  quote?: unknown;
  title?: unknown;
  kind?: unknown;
  raiser?: unknown;
}

/**
 * Keeps only model output whose quote is literally in the protocol. Offsets are
 * computed here, never taken from the model. Returns the kept candidates and how
 * many were dropped, so the interface can say so.
 */
export function validateQuotes(text: string, items: ModelItem[]): { candidates: Candidate[]; dropped: number } {
  const used = new Set<number>();
  const candidates: Candidate[] = [];
  let dropped = 0;
  for (const it of items) {
    const quote = typeof it.quote === 'string' ? it.quote.trim() : '';
    let at = quote.length >= 10 ? text.indexOf(quote) : -1;
    while (at >= 0 && used.has(at)) at = text.indexOf(quote, at + 1);
    if (at < 0 || candidates.length >= MAX_CANDIDATES) {
      dropped++;
      continue;
    }
    used.add(at);
    const rawTitle = typeof it.title === 'string' ? it.title.replace(/\s+/g, ' ').trim() : '';
    candidates.push({
      ord: candidates.length + 1,
      quoteStart: at,
      quoteEnd: at + quote.length,
      quote,
      title: rawTitle.length >= 3 && rawTitle.length <= 160 ? rawTitle : titleOf(quote),
      kind: it.kind === 'idea' ? 'idea' : 'problem',
      raiser: typeof it.raiser === 'string' && it.raiser.trim() && it.raiser.length <= 120 ? it.raiser.trim() : null,
      signal: 'найдено моделью, цитата сверена с текстом',
    });
  }
  return { candidates, dropped };
}
