/**
 * Meeting transcripts and findings (ADR-0014). Pure functions, no I/O.
 *
 * A transcript is a list of segments, one line each:
 *   [мм:сс] Имя Фамилия: что сказано
 * The timestamp and the speaker are optional. Whatever produced the text (a
 * local engine, a person typing, a prepared demo file) is stored next to it.
 *
 * Findings by rules are a transparent template, not AI: one finding per line,
 * the type decided by explicit wording. A decision is recorded only when the
 * words say it was decided («решили», «утвердили», «договорились»); a proposal
 * stays an idea. Names, dates and owners are never invented: an owner is taken
 * only from «ответственный: Имя Фамилия», a deadline only from a date phrase.
 */
export interface Segment {
  startMs: number | null;
  speaker: string | null;
  /** Offset of the spoken text (after the timestamp and the speaker) in the transcript. */
  offset: number;
  text: string;
}

export const FINDING_TYPES = [
  'idea',
  'problem',
  'task',
  'deadline',
  'owner_candidate',
  'proposed_solution',
  'decision',
  'risk',
  'objection',
  'open_question',
  'insight',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];
/** Types that may become an item after a person confirms them. The rest are kept in memory. */
export const ITEM_TYPES: readonly FindingType[] = ['idea', 'problem', 'task', 'proposed_solution', 'decision'];

export interface Finding {
  ord: number;
  type: FindingType;
  quoteStart: number;
  quoteEnd: number;
  quote: string;
  title: string;
  kind: 'idea' | 'problem';
  startMs: number | null;
  speaker: string | null;
  confidence: 'high' | 'medium' | 'low';
  basis: string;
}

const TS = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s+/;
const SPEAKER = /^([А-ЯЁA-Z][а-яёa-z-]+(?:\s+[А-ЯЁA-Z][а-яёa-z-]+)?)\s*:\s+(?=\S)/;
const BULLET = /^(?:[-–—•*·]|\d{1,2}[.)])\s+/;

export function parseTranscript(text: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  for (const raw of text.split('\n')) {
    const lineStart = pos;
    pos += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    let i = line.length - line.trimStart().length;
    let rest = line.slice(i);
    if (!rest.trim()) continue;
    let startMs: number | null = null;
    const ts = TS.exec(rest);
    if (ts) {
      const [a, b, c] = [Number(ts[1]), Number(ts[2]), ts[3] === undefined ? null : Number(ts[3])];
      startMs = (c === null ? a * 60 + b : a * 3600 + b * 60 + c) * 1000;
      i += ts[0].length;
      rest = rest.slice(ts[0].length);
    }
    let speaker: string | null = null;
    const sp = SPEAKER.exec(rest);
    if (sp) {
      speaker = sp[1]!;
      i += sp[0].length;
      rest = rest.slice(sp[0].length);
    }
    const bl = BULLET.exec(rest);
    if (bl) {
      i += bl[0].length;
      rest = rest.slice(bl[0].length);
    }
    const body = rest.trimEnd();
    if (body) out.push({ startMs, speaker, offset: lineStart + i, text: body });
  }
  return out;
}

export const formatMs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
const w = (alts: string, start = false) => new RegExp(`${start ? '^' : L}(?:${alts})${R}`, 'iu');
const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
const DATE = new RegExp(`${L}(?:до|к|не позднее)\\s+(?:\\d{1,2}(?:\\.\\d{1,2})?(?:\\s+(?:${MONTHS}))?|понедельника|вторника|среды|четверга|пятницы|субботы|конца\\s+(?:недели|месяца))${R}`, 'iu');
const OWNER = /ответственн\p{L}*\s*[:—–-]\s*([А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+)?)/u;

interface Rule {
  type: FindingType;
  re: RegExp;
  confidence: Finding['confidence'];
  basis: string;
}
const RULES: Rule[] = [
  { type: 'decision', re: w('решили|решение|утвердили|утверждаем|договорились', true), confidence: 'high', basis: 'прямо сказано, что решили' },
  { type: 'objection', re: w('я против|не согласен|не согласна|возражаю|не соглашусь', false), confidence: 'medium', basis: 'прямое возражение' },
  { type: 'task', re: w('поручить|поручение|поручаю|поручим|задача|сделать|возьмёт на себя|возьму на себя', true), confidence: 'medium', basis: 'поручение или задача' },
  { type: 'owner_candidate', re: w('ответственн\\p{L}*', true), confidence: 'medium', basis: 'назван ответственный' },
  { type: 'deadline', re: w('срок|дедлайн', true), confidence: 'medium', basis: 'назван срок' },
  { type: 'risk', re: w('риск|рискуем|опасно|может\\s+(?:сломаться|встать|не\\s+успеть)|иначе\\s+встанет'), confidence: 'medium', basis: 'назван риск' },
  { type: 'open_question', re: w('не решили|открытый вопрос|надо уточнить|непонятно|вопрос открыт'), confidence: 'medium', basis: 'вопрос не закрыт' },
  { type: 'idea', re: w('предлагаю|предложение|идея', false), confidence: 'medium', basis: 'прямое предложение' },
  { type: 'proposed_solution', re: w('давайте|можно\\s+бы|можно\\s+поставить|можно\\s+сделать|решение\\s*[—–-]'), confidence: 'low', basis: 'похоже на вариант решения' },
  { type: 'insight', re: w('выяснилось|оказывается|заметили|каждый раз|чаще всего|в среднем'), confidence: 'low', basis: 'наблюдение' },
  { type: 'problem', re: w('проблема|жалоба|не работает|не работают|завис\\p{L}*|лома\\p{L}*|сломал\\p{L}*|не хватает|приходится|теряем|задерж\\p{L}*|ошиб\\p{L}*|опаздыва\\p{L}*'), confidence: 'low', basis: 'описание проблемы по ключевым словам' },
];
const ACTION_HEADER = /^(?:решили|решения|поручения|задачи|итоги|договорились)\s*:?\s*$/iu;
const STRIP = new RegExp(
  `^(?:решили|решение|утвердили|договорились|поручить|поручение|задача|сделать|предлагаю|предложение|идея|проблема|риск|срок)${R}\\s*[:—–-]?\\s*`,
  'iu',
);

export function titleFromText(t: string): string {
  let s = t.replace(STRIP, '').replace(/\s+/g, ' ').trim();
  s = (s.split(/(?<=[.!?…])\s/)[0] ?? s).replace(/[.…;,]+$/, '');
  if (s.length > 120) {
    const cut = s.slice(0, 120);
    s = `${cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : 120)}…`;
  }
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.length >= 3 ? s : t.trim().slice(0, 120);
}

export function extractFindings(text: string, max = 40): Finding[] {
  const out: Finding[] = [];
  let inActions = false;
  for (const seg of parseTranscript(text)) {
    if (ACTION_HEADER.test(seg.text)) {
      inActions = true;
      continue;
    }
    if (seg.text.length < 12) continue;
    let rule = RULES.find((r) => r.re.test(seg.text));
    if (!rule && seg.text.trimEnd().endsWith('?')) rule = { type: 'open_question', re: /$/, confidence: 'medium', basis: 'вопрос без ответа в этой реплике' };
    if (!rule && inActions) rule = { type: 'decision', re: /$/, confidence: 'high', basis: 'пункт в разделе «Решили»' };
    if (!rule) continue;
    let { type, basis, confidence } = rule;
    if (inActions && type !== 'decision' && type !== 'objection') basis = `${basis}; в разделе «Решили»`;
    const owner = OWNER.exec(seg.text)?.[1];
    if (owner) basis = `${basis}; ответственный по тексту: ${owner}`;
    const due = DATE.exec(seg.text)?.[0];
    if (due) basis = `${basis}; срок по тексту: ${due}`;
    if (type === 'owner_candidate' && !owner) continue;
    if (type === 'deadline' && !due) continue;
    const kind = type === 'problem' || type === 'risk' || type === 'objection' ? 'problem' : 'idea';
    out.push({
      ord: out.length + 1,
      type,
      quoteStart: seg.offset,
      quoteEnd: seg.offset + seg.text.length,
      quote: seg.text,
      title: titleFromText(seg.text),
      kind,
      startMs: seg.startMs,
      speaker: seg.speaker,
      confidence,
      basis,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** Segment that contains a character offset (for timestamps and speakers of model findings). */
export function segmentAt(segments: Segment[], offset: number): Segment | undefined {
  return segments.find((s) => offset >= s.offset && offset < s.offset + s.text.length);
}

/** Normalized quote for duplicate detection across analyses of one meeting. */
export const normQuote = (q: string) => q.toLowerCase().replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
