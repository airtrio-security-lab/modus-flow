/**
 * Personal and confidential data in organizational memory (ADR-0018).
 *
 * A pattern detector, not AI: it finds identifiers (e-mail, phone, IIN/BIN and other long
 * numbers, card and account numbers, document numbers), special categories (health),
 * pay and disciplinary details, home addresses and dates of birth, employees' surnames,
 * and confidentiality markers — at any length. People belong in the card's people fields
 * (references that can be pseudonymized), not in free text.
 *
 * It never returns the matched text to callers outside the server: findings carry a kind,
 * a label and a position, so messages and the admin scan can name WHERE and WHAT KIND,
 * not the data itself.
 */

export type SensitiveKind =
  | 'email' | 'phone' | 'id_number' | 'card' | 'iban' | 'document' | 'birth' | 'address'
  | 'health' | 'pay' | 'discipline' | 'person' | 'confidential';

export const KIND_LABEL: Record<SensitiveKind, string> = {
  email: 'адрес электронной почты',
  phone: 'номер телефона',
  id_number: 'длинный номер (ИИН, БИН, счёт или документ)',
  card: 'номер банковской карты',
  iban: 'номер счёта (IBAN)',
  document: 'реквизиты документа',
  birth: 'дата рождения',
  address: 'адрес',
  health: 'сведения о здоровье',
  pay: 'сведения о заработной плате',
  discipline: 'дисциплинарные или правовые сведения о человеке',
  person: 'фамилия сотрудника в тексте',
  confidential: 'пометка о конфиденциальности',
};
export const CONFIDENTIAL_KINDS: SensitiveKind[] = ['confidential'];

export interface Finding {
  kind: SensitiveKind;
  start: number;
  end: number;
  /** The matched text. Server-side only: never put it into a response, a log or an error. */
  value: string;
}

// \b does not work next to Cyrillic letters, so word edges are explicit look-arounds.
const B = '(?<![\\p{L}\\d])';
const E = '(?![\\p{L}\\d])';
const W = (src: string) => new RegExp(src.replaceAll('‹', B).replaceAll('›', E), 'giu');
const RULES: [SensitiveKind, RegExp][] = [
  ['email', /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/giu],
  ['iban', /\bKZ\d{2}[A-Z0-9]{13,16}\b/gi],
  ['card', /\b\d{4}(?:[ -]?\d{4}){2}[ -]?\d{1,7}\b/g],
  ['phone', /(?:\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g],
  ['id_number', /\b\d{9,}\b/g],
  ['document', W('‹(?:паспорт\\p{L}*|удостоверени\\p{L}*|ИИН|БИН)›\\s*(?:№|N|номер)?\\s*\\d')],
  ['birth', W('(?:‹дат\\p{L}* рождени\\p{L}*|‹д\\.\\s?р\\.|‹родил(?:ся|ась)›|\\b\\d{1,2}\\.\\d{1,2}\\.(?:19|20)\\d{2}\\s*г\\.?\\s*р\\.?)')],
  ['address', W('‹(?:ул\\.|улиц\\p{L}*|проспект\\p{L}*|пр-т|мкр\\.?|микрорайон\\p{L}*|кв\\.|квартир\\p{L}*|дом›)\\s*[\\p{L}\\d .,-]{0,30}\\d')],
  ['health', W('‹(?:диагноз\\p{L}*|больничн\\p{L}*|инвалидн\\p{L}*|беременн\\p{L}*|заболевани\\p{L}*|болезн\\p{L}*|лечени\\p{L}*|госпитализ\\p{L}*|психиатр\\p{L}*|нарколог\\p{L}*|медицинск\\p{L}* справк\\p{L}*|ВИЧ›|инсульт\\p{L}*|инфаркт\\p{L}*)')],
  ['pay', W('‹(?:зарплат\\p{L}*|заработн\\p{L}* плат\\p{L}*|оклад\\p{L}*|преми(?:я|и|ю|ей)›|надбавк\\p{L}*|удержани\\p{L}* из|алимент\\p{L}*)')],
  ['discipline', W('‹(?:выговор\\p{L}*|уволен\\p{L}*|увольнени\\p{L}*|дисциплинарн\\p{L}*|судим\\p{L}*|задержан\\p{L}* полици\\p{L}*|уголовн\\p{L}*|штраф\\p{L}* (?:сотрудник|работник)\\p{L}*)')],
  ['confidential', W('(?:‹конфиденциальн\\p{L}*|‹коммерческ\\p{L}* тайн\\p{L}*|\\bNDA\\b|‹не для распространения|‹для служебного пользования|‹ДСП›|‹секретн\\p{L}*)')],
];

const SURNAME_ENDINGS = '(?:а|у|ым|ой|ом|е|ых|ым|ою|ов|ова|ову|овым|овой|ой)?';
const norm = (s: string) => s.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Surnames of the organization's people, case-sensitive (Russian names are capitalized). */
function personRules(people: string[]): RegExp[] {
  const rules: RegExp[] = [];
  for (const name of people) {
    const parts = norm(name).split(/\s+/).filter((p) => /^\p{Lu}\p{Ll}{2,}/u.test(p));
    // The surname is taken as the last capitalized word of «Имя Фамилия»; short or one-word names are skipped.
    if (parts.length < 2) continue;
    const surname = parts[parts.length - 1]!;
    if (surname.length < 4) continue;
    const stem = surname.replace(/(а|я)$/u, '');
    rules.push(new RegExp(`(?<![\\p{L}])${esc(stem)}${SURNAME_ENDINGS}(?![\\p{L}])`, 'gu'));
  }
  return rules;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function findSensitive(text: string, opts: { people?: string[] } = {}): Finding[] {
  if (!text) return [];
  const t = norm(text);
  const out: Finding[] = [];
  const taken = (s: number, e: number) => out.some((f) => s < f.end && e > f.start);
  for (const [kind, re] of RULES) {
    for (const m of t.matchAll(re)) {
      const s = m.index!;
      const e = s + m[0].length;
      if (taken(s, e)) continue;
      // A number shaped like a card that fails the Luhn check is still a long personal-looking number.
      const k: SensitiveKind = kind === 'card' && !luhn(m[0].replace(/\D/g, '')) ? 'id_number' : kind;
      out.push({ kind: k, start: s, end: e, value: text.slice(s, e) });
    }
  }
  for (const re of personRules(opts.people ?? [])) {
    for (const m of t.matchAll(re)) {
      const s = m.index!;
      const e = s + m[0].length;
      if (!taken(s, e)) out.push({ kind: 'person', start: s, end: e, value: text.slice(s, e) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Russian list of kinds, without values: «номер телефона, сведения о здоровье». */
export const kindsText = (fs: { kind: SensitiveKind }[]) => [...new Set(fs.map((f) => KIND_LABEL[f.kind]))].join(', ');

/**
 * Closed-meeting content that must not reach an organization-wide card, at any length:
 * numbers (amounts, quantities, dates) and sensitive findings of the meeting material that
 * reappear in the card. (Copies of 12+ words are refused earlier, when the card is written.)
 */
export function meetingOverlap(card: string, material: string, people: string[] = []): ('number' | SensitiveKind)[] {
  const out = new Set<'number' | SensitiveKind>();
  const clean = (s: string) => norm(s).replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, ' ');
  const c = clean(card);
  const m = clean(material);
  const nums = (s: string) => new Set((s.match(/\d+(?:[.,]\d+)?/g) ?? []).filter((x) => x.replace(/\D/g, '').length >= 2));
  const cardNums = nums(c);
  for (const n of nums(m)) if (cardNums.has(n)) out.add('number');
  for (const f of findSensitive(m, { people })) {
    if (new RegExp(`(?<![\\p{L}\\d])${esc(norm(f.value))}(?![\\p{L}\\d])`, f.kind === 'person' ? 'u' : 'iu').test(c)) out.add(f.kind);
  }
  return [...out];
}

export const OVERLAP_LABEL: Record<string, string> = { number: 'числа из закрытого заседания', ...KIND_LABEL };

export const LEGAL_BASES = ['subject_request', 'consent_withdrawn', 'retention_expired', 'unlawful_processing', 'authority_order'] as const;
export const LEGAL_BASIS_TITLE: Record<(typeof LEGAL_BASES)[number], string> = {
  subject_request: 'Требование субъекта персональных данных',
  consent_withdrawn: 'Отзыв согласия',
  retention_expired: 'Истёк срок хранения',
  unlawful_processing: 'Неправомерная обработка',
  authority_order: 'Предписание уполномоченного органа или суда',
};
