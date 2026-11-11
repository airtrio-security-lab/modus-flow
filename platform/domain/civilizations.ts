/**
 * The registry of civilizations (ADR-0019, ADR-0020): architecture, council place, titles and
 * invitation wording for each district style. One data model and one process for all of them:
 * a civilization changes pictures and words only — never XP, levels, rights or the workflow.
 * It is chosen by the department and never derived from who works there.
 *
 * Titles are words, not a ladder: historical names do not always form a strict hierarchy, so each
 * one is tied to a real function or to the person's own choice, and none of them grants anything.
 *
 * To add a civilization: a migration widens the CHECK on departments.civilization, the art goes to
 * web/src/components/civ.tsx (castle, houses, council hall, scene), and an entry below.
 */
export interface CivilizationTitles {
  /** Head of the department (departments.head_membership_id). Camelot uses the person's own address form. */
  head: string;
  /** Deputy — named by an organization admin (game_titles rank «deputy»). */
  deputy: string;
  /** Authorized participant: maintainer or decision-owner role in the department. */
  authorized: string;
  /** Master specialist: confirmed results (implemented as implementer, or confirmed as executor). */
  master: string;
  /** Honorary title for confirmed achievements, shown only when the person chooses to show it. */
  honor: string | null;
  /** Beginner title, only when the person chose it themselves. */
  novice: string | null;
  /** Everyone else in the district. */
  member: string;
}
export interface Civilization {
  id: 'camelot' | 'japan' | 'mongolia' | 'kazakh';
  name: string;
  motto: string;
  /** Where the small council of a department in this style meets. */
  hall: string;
  /** Invitation to the small council; `addr` is how the reader is addressed. */
  invite: (addr: string) => string;
  titles: CivilizationTitles;
}

export const CIVILIZATIONS: readonly Civilization[] = [
  {
    id: 'camelot',
    name: 'Камелот — Рыцарское королевство',
    motto: 'Замок, башни и стены, рыцарский двор, оружейная и мастерские',
    hall: 'Зал рыцарей',
    invite: (a) => `${a}, вас призывают в зал Камелота`,
    titles: { head: 'Лорд', deputy: 'Сенешаль', authorized: 'Рыцарь', master: 'Мастер гильдии', honor: null, novice: 'Оруженосец', member: 'Житель Камелота' },
  },
  {
    id: 'japan',
    name: 'Японское княжество',
    motto: 'Замок, сады и мосты, многоярусные крыши',
    hall: 'Зал даймё',
    invite: (a) => `${a}, вас ожидают в зале совета`,
    titles: { head: 'Даймё', deputy: 'Каро', authorized: 'Самурай', master: 'Такуми', honor: null, novice: null, member: 'Житель княжества' },
  },
  {
    id: 'kazakh',
    name: 'Казахское ханство',
    motto: 'Большая ханская юрта, ставка и поселение, орнаменты',
    hall: 'Ханская юрта',
    invite: (a) => `${a}, в Орде созывается совет`,
    titles: { head: 'Хан', deputy: 'Султан', authorized: 'Би', master: 'Шебер', honor: 'Батыр', novice: null, member: 'Житель Орды' },
  },
  {
    id: 'mongolia',
    name: 'Монгольская держава',
    motto: 'Ставка правителя, юрты, туги и степные сооружения',
    hall: 'Совет нойонов',
    invite: (a) => `${a}, вас приглашают на совет`,
    titles: { head: 'Хан', deputy: 'Нойон', authorized: 'Нойон', master: 'Дархан', honor: 'Баатур', novice: null, member: 'Житель державы' },
  },
];
export type CivilizationId = Civilization['id'];
export const CIVILIZATION_IDS = CIVILIZATIONS.map((c) => c.id) as [CivilizationId, ...CivilizationId[]];
/** Old ids kept readable in the audit log: «europe» was renamed to Камелот in 0015. */
const ALIASES: Record<string, CivilizationId> = { europe: 'camelot' };
export const civilization = (id: string | null | undefined): Civilization =>
  CIVILIZATIONS.find((c) => c.id === (ALIASES[id ?? ''] ?? id)) ?? CIVILIZATIONS[0]!;
export const civilizationName = (id: string) => (id === 'europe' ? 'Средневековая Европа (ныне Камелот)' : civilization(id).name);

/** The company council: one for everyone, owned by no civilization. */
export const GREAT_COUNCIL = {
  name: 'Большой Круглый стол',
  hall: 'Зал Большого Круглого стола',
  /** `null` addresses the heads of districts together: «Главы владений, …». */
  invite: (addr: string | null) => `${addr ?? 'Главы владений'}, вас созывают к Большому Круглому столу`,
};

/** Neutral title for people who switched game titles off. */
export const NEUTRAL_TITLE = 'Сотрудник';

export const ESCALATION_REASONS = {
  cross_department: 'Межотдельский вопрос: затрагивает несколько подразделений',
  strategic: 'Стратегическое изменение',
  shared_resources: 'Общие ресурсы компании',
  higher_authority: 'Нужны более высокие полномочия',
  other: 'Другая причина',
} as const;
export type EscalationReason = keyof typeof ESCALATION_REASONS;
