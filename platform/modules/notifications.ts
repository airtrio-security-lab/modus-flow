import { withTx, type Client, type Database } from '../db/pool.ts';
import { NOTIFICATION_EVENTS, type NotificationEvent, type OrgActor } from '../domain/model.ts';
import { orgTx } from './context.ts';
import { effectiveTitles, type EffectiveTitle } from './titles.ts';
import { z } from 'zod';

/**
 * Notifications Engine. Rules:
 *  - every notification has explicit recipients chosen by the workflow (no broadcast);
 *  - the actor never notifies themselves;
 *  - recipients' subscription settings are honoured;
 *  - rows hold no free text: messages are rendered at read time from the event
 *    type, the actor's name and the organization-visible idea title, so private
 *    Lab content can never travel through a notification;
 *  - (recipient, dedupe_key) is unique, so retries do not duplicate.
 * Delivery to external channels (e-mail, messengers) is a future outbox consumer.
 */
export async function notify(
  c: Client,
  actor: OrgActor,
  event: NotificationEvent,
  ideaId: string | null,
  recipients: Iterable<string | null | undefined>,
  dedupeSuffix: string,
): Promise<number> {
  const targets = [...new Set([...recipients].filter((r): r is string => !!r && r !== actor.membershipId))];
  if (targets.length === 0 || ideaId === null) return 0;
  // app_notify (migration 0003) is the only write path: it verifies that the
  // event is backed by a workflow record created by the actor and that every
  // recipient may see the idea. Direct INSERTs are not granted.
  const { rows } = await c.query<{ n: number }>('SELECT app_notify($1, $2, $3::uuid[], $4) AS n', [event, ideaId, targets, dedupeSuffix]);
  return rows[0]!.n;
}

/** Members holding any of the given roles (e.g. who triages newly published ideas). */
export async function membersWithRoles(c: Client, orgId: string, roles: readonly string[]): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM memberships
      WHERE organization_id = $1 AND status = 'active' AND access = 'member' AND roles && $2::text[]`,
    [orgId, roles],
  );
  return rows.map((r) => r.id);
}

const TEMPLATES: Record<NotificationEvent, (actor: string, title: string) => string> = {
  idea_published: (a, t) => `${a} предлагает на обсуждение новую идею «${t}»`,
  comment_added: (a, t) => `${a} оставляет комментарий к идее «${t}»`,
  changes_requested: (a, t) => `${a} просит доработать идею «${t}»`,
  assigned: (a, t) => `${a} назначает вас ответственным по идее «${t}»`,
  verification_started: (a, t) => `${a} запускает проверку идеи «${t}»`,
  verification_completed: (a, t) => `Проверка идеи «${t}» завершена (${a})`,
  idea_merged: (a, t) => `${a} принимает решение о внедрении идеи «${t}»`,
  idea_rejected: (a, t) => `${a} отклоняет идею «${t}» с объяснением`,
  contribution_confirmed: (a, t) => `${a} подтверждает ваш вклад в идею «${t}»`,
  honor_board_recognition: (_a, t) => `Ваш вклад в идею «${t}» отмечен на доске почёта`,
  objection_raised: (a, t) => `${a} возражает против замечания по идее «${t}»`,
  revision_submitted: (a, t) => `${a} публикует новую версию идеи «${t}»`,
  suggestion_submitted: (a, t) => `${a} предлагает свою версию идеи «${t}»`,
  suggestion_decided: (a, t) => `${a} рассматривает ваше предложение по идее «${t}»`,
  status_report: (a, t) => `${a} сообщает о ходе работы по «${t}»`,
  implemented: (a, t) => `${a} сообщает: «${t}» реализовано`,
  raised_on_behalf: (a, t) => `${a} зафиксировал(а) ваш вопрос «${t}» — следите за статусом`,
  escalated: (_a, t) => `Обращение «${t}» просрочено или зависло — требуется внимание`,
  council_recommendation: (a, t) => `${a} оставляет рекомендацию Совета по «${t}»`,
  council_handoff: (a, t) => `${a} передаёт вам решение по «${t}» после обсуждения в Совете`,
  castle_level_up: (_a, t) => `Внедрение «${t}» подняло замок подразделения на новый уровень`,
  meeting_called: (a, t) => `${a} созывает заседание «${t}» с записью: подтвердите или отклоните согласие`,
  meeting_recording_started: (a, t) => `${a} включил(а) запись заседания «${t}»`,
  meeting_findings_ready: (a, t) => `${a} подготовил(а) находки по заседанию «${t}» — их проверит руководитель`,
  meeting_rescheduled: (a, t) => `${a} переносит заседание «${t}»`,
  meeting_cancelled: (a, t) => `${a} отменяет заседание «${t}»`,
  deadline_soon: (_a, t) => `Срок решения по «${t}» наступает в ближайшие сутки`,
  castle_xp: (_a, t) => `Внедрение «${t}» принесло опыт замку подразделения`,
  knowledge_submitted: (a, t) => `${a} (Архивариус) представляет заключение о включении «${t}» в Высший Архив — нужно ваше решение`,
  knowledge_in_library: (a, t) => `${a} (Архивариус) вносит «${t}» в Библиотеку решений`,
  knowledge_archived: (a, t) => `${a} утверждает включение «${t}» в Высший Архив`,
  knowledge_reverify: (a, t) => `${a} запрашивает повторную проверку знания «${t}»`,
};

/**
 * Game headline for each event (owner brief «Живое королевство»). The headline is
 * decoration: the business message below it always says what happened and who did it.
 * No headline names the King: «Король направил послание» appears only for a real
 * message from the person holding that title, which this version does not send.
 */
export const HEADLINES: Record<NotificationEvent, string> = {
  idea_published: 'В замок прибыл посол',
  comment_added: 'Новое слово в обсуждении',
  changes_requested: 'Совет просит уточнить',
  assigned: 'Получено поручение',
  verification_started: 'Начато испытание',
  verification_completed: 'Испытание завершено',
  idea_merged: 'Решение зафиксировано',
  idea_rejected: 'Решение зафиксировано',
  contribution_confirmed: 'Вклад признан',
  honor_board_recognition: 'Вклад признан',
  objection_raised: 'Возражение',
  revision_submitted: 'Посол принёс новую версию',
  suggestion_submitted: 'Предложена новая версия',
  suggestion_decided: 'Ответ на ваше предложение',
  status_report: 'Вести с работ',
  implemented: 'Внедрение завершено',
  raised_on_behalf: 'Ваш вопрос записан',
  escalated: 'Приближается срок',
  council_recommendation: 'Совет даёт совет',
  council_handoff: 'Решение Совета ждёт вас',
  castle_level_up: 'Замок повысил уровень',
  meeting_called: 'Созван Королевский совет',
  meeting_recording_started: 'Идёт запись заседания',
  meeting_findings_ready: 'Находки заседания ждут проверки',
  meeting_rescheduled: 'Заседание перенесено',
  meeting_cancelled: 'Заседание отменено',
  deadline_soon: 'Приближается срок',
  castle_xp: 'Замок получил XP',
  knowledge_submitted: 'Новое знание ждёт Совета',
  knowledge_in_library: 'Том внесён в Библиотеку',
  knowledge_archived: 'Том занял место в Высшем Архиве',
  knowledge_reverify: 'Знание требует проверки',
};

/** Plain business headlines for people who switched the game wording off. */
export const BUSINESS_HEADLINES: Record<NotificationEvent, string> = {
  idea_published: 'Новое обращение',
  comment_added: 'Новый комментарий',
  changes_requested: 'Требуется уточнение',
  assigned: 'Вам назначена задача',
  verification_started: 'Требуется заключение по проверке',
  verification_completed: 'Проверка завершена',
  idea_merged: 'Решение принято',
  idea_rejected: 'Решение принято',
  contribution_confirmed: 'Вклад подтверждён',
  honor_board_recognition: 'Вклад отмечен',
  objection_raised: 'Возражение',
  revision_submitted: 'Новая версия обращения',
  suggestion_submitted: 'Предложена версия обращения',
  suggestion_decided: 'Ответ на ваше предложение',
  status_report: 'Отчёт о ходе работ',
  implemented: 'Внедрено',
  raised_on_behalf: 'Ваш вопрос зарегистрирован',
  escalated: 'Срок нарушен',
  council_recommendation: 'Рекомендация',
  council_handoff: 'Нужно ваше решение',
  castle_level_up: 'Подразделение достигло нового уровня',
  meeting_called: 'Приглашение на заседание',
  meeting_recording_started: 'Начата запись заседания',
  meeting_findings_ready: 'Находки заседания ждут проверки',
  meeting_rescheduled: 'Заседание перенесено',
  meeting_cancelled: 'Заседание отменено',
  deadline_soon: 'Срок через сутки',
  castle_xp: 'Подразделению начислен опыт',
  knowledge_submitted: 'Заключение Архивариуса на утверждение',
  knowledge_in_library: 'Решение внесено в Библиотеку',
  knowledge_archived: 'Утверждено в Высший Архив',
  knowledge_reverify: 'Требуется повторная проверка',
};

/** Groups for the inbox filter and for switching optional messages off. */
export const CATEGORY: Record<NotificationEvent, 'council' | 'items' | 'decisions' | 'deadlines' | 'castle' | 'legacy'> = {
  meeting_called: 'council', meeting_rescheduled: 'council', meeting_cancelled: 'council', meeting_recording_started: 'council',
  meeting_findings_ready: 'council', council_recommendation: 'council', council_handoff: 'decisions',
  idea_published: 'items', raised_on_behalf: 'items', comment_added: 'items', revision_submitted: 'items', suggestion_submitted: 'items',
  suggestion_decided: 'items', objection_raised: 'items', status_report: 'items', changes_requested: 'items',
  idea_merged: 'decisions', idea_rejected: 'decisions', assigned: 'decisions', verification_started: 'decisions',
  verification_completed: 'decisions', implemented: 'decisions',
  escalated: 'deadlines', deadline_soon: 'deadlines',
  castle_xp: 'castle', castle_level_up: 'castle', contribution_confirmed: 'castle', honor_board_recognition: 'castle',
  knowledge_submitted: 'legacy', knowledge_in_library: 'legacy', knowledge_archived: 'legacy', knowledge_reverify: 'legacy',
};
/** Never switched off (also enforced by app_notification_enabled in the database). */
export const MANDATORY: readonly NotificationEvent[] = [
  'assigned', 'idea_merged', 'idea_rejected', 'council_handoff', 'changes_requested', 'escalated',
  'deadline_soon', 'meeting_called', 'meeting_rescheduled', 'meeting_cancelled', 'verification_started',
];
/** Urgent: may unfold once in the inbox (short, non-blocking animation). */
export const URGENT: readonly NotificationEvent[] = ['meeting_called', 'council_handoff', 'assigned', 'deadline_soon', 'escalated'];

export type AddressForm = 'title' | 'milord' | 'milady' | 'master' | 'neutral';
export interface Preferences {
  style: 'royal' | 'business';
  addressForm: AddressForm;
  groupRepeats: boolean;
  muted: NotificationEvent[];
}

/**
 * How a message addresses its reader. Only the reader's own choice or their game title is used —
 * never a guess from a name. A title changes the wording, never the rights.
 */
export function addressFor(form: AddressForm, title: EffectiveTitle | null): string {
  if (form === 'milord') return 'Милорд';
  if (form === 'milady') return 'Миледи';
  if (form === 'master') return 'Мастер';
  if (form === 'neutral' || !title) return 'Коллега';
  if (title.rank === 'king') return 'Ваше Величество';
  return title.title;
}

interface Ctx {
  addr: string;
  topic: string;
  required: boolean;
  /** 'метода' for methods, 'знания' otherwise (knowledge messages). */
  noun?: string;
}
const ROYAL: Partial<Record<NotificationEvent, (x: Ctx) => string>> = {
  meeting_called: (x) =>
    `${x.addr}, вас призывают к Круглому столу! Совет собирается для рассмотрения вопроса: «${x.topic}». ` +
    (x.required ? 'Ваше мнение необходимо для принятия решения.' : 'Ваше мнение поможет принять решение; участие — по желанию.'),
  meeting_rescheduled: (x) => `${x.addr}, Круглый стол «${x.topic}» переносится.`,
  meeting_cancelled: (x) => `${x.addr}, Совет «${x.topic}» отменён.`,
  meeting_recording_started: (x) => `${x.addr}, летописец начал запись Совета «${x.topic}».`,
  meeting_findings_ready: (x) => `${x.addr}, писари подготовили находки Совета «${x.topic}».`,
  idea_published: (x) => `${x.addr}, в замок прибыл посол с вопросом «${x.topic}».`,
  council_handoff: (x) => `${x.addr}, Совет завершил обсуждение «${x.topic}»: решение за вами.`,
  assigned: (x) => `${x.addr}, вам вручено поручение: «${x.topic}».`,
  deadline_soon: (x) => `${x.addr}, приближается срок по «${x.topic}».`,
  escalated: (x) => `${x.addr}, срок по «${x.topic}» истёк — вопрос ждёт вашей руки.`,
  changes_requested: (x) => `${x.addr}, Совет просит уточнить «${x.topic}».`,
  idea_merged: (x) => `${x.addr}, решение по «${x.topic}» утверждено: внедрять.`,
  idea_rejected: (x) => `${x.addr}, по «${x.topic}» принято решение не внедрять.`,
  implemented: (x) => `${x.addr}, инициатива «${x.topic}» внедрена.`,
  castle_xp: (x) => `${x.addr}, ваш замок получил опыт за «${x.topic}».`,
  castle_level_up: (x) => `${x.addr}, замок поднялся на новый уровень благодаря «${x.topic}»!`,
  verification_started: (x) => `${x.addr}, от вас ждут заключения: испытание «${x.topic}».`,
  council_recommendation: (x) => `${x.addr}, Совет дал совет по «${x.topic}».`,
  raised_on_behalf: (x) => `${x.addr}, ваш вопрос «${x.topic}» записан в летопись.`,
  // Owner brief «Наследие Королевства»: the four royal messages, each backed by a real transition.
  knowledge_submitted: (x) => `${x.addr}, Архивариус представил новое знание для рассмотрения Советом: «${x.topic}».`,
  knowledge_in_library: (x) => `${x.addr}, ваше решение «${x.topic}» внесено в Библиотеку.`,
  knowledge_archived: (x) => `${x.addr}, Совет утвердил включение ${x.noun ?? 'знания'} «${x.topic}» в Высший Архив.`,
  knowledge_reverify: (x) => `${x.addr}, внимание: ранее принятый ${x.noun === 'метода' ? 'метод' : 'вывод'} «${x.topic}» требует повторной проверки.`,
};

export interface MeetingInvite {
  title: string;
  organizer: string;
  scheduledAt: string | null;
  ideaNumber: number | null;
  ideaTitle: string | null;
  reason: string;
  required: boolean;
  action: string;
  attendance: 'pending' | 'confirmed' | 'declined';
  consent: 'pending' | 'given' | 'declined';
  cancelled: boolean;
  cancelReason: string | null;
}

export interface InboxItem {
  id: string;
  event: NotificationEvent;
  category: (typeof CATEGORY)[NotificationEvent];
  /** Plain business text: always present (decisions and deadlines must read without the game). */
  message: string;
  /** Game wording addressed to the reader; null in business style or when no wording exists. */
  royal: string | null;
  headline: string;
  urgent: boolean;
  ideaNumber: number | null;
  meetingId: string | null;
  /** Knowledge the message is about — opened only while the reader may still see it. */
  knowledgeId: string | null;
  /** Meeting details, only while the reader still has access to the meeting. */
  meeting: MeetingInvite | null;
  /** The reader was invited but has no access any more (removed). */
  meetingClosed: boolean;
  createdAt: string;
  readAt: string | null;
}

export async function loadPreferences(c: Client): Promise<Preferences> {
  const p = (
    await c.query<{ style: 'royal' | 'business'; address_form: AddressForm; group_repeats: boolean }>(
      'SELECT style, address_form, group_repeats FROM notification_preferences WHERE organization_id = app_org_id() AND membership_id = app_membership_id()',
    )
  ).rows[0];
  const muted = (
    await c.query<{ event_type: NotificationEvent }>(
      `SELECT event_type FROM notification_subscriptions
        WHERE organization_id = app_org_id() AND membership_id = app_membership_id() AND idea_id IS NULL AND NOT enabled`,
    )
  ).rows.map((r) => r.event_type);
  return { style: p?.style ?? 'royal', addressForm: p?.address_form ?? 'title', groupRepeats: p?.group_repeats ?? true, muted };
}

export async function inbox(c: Client, limit = 80): Promise<InboxItem[]> {
  const prefs = await loadPreferences(c);
  const me = (await c.query<{ m: string }>('SELECT app_membership_id() AS m')).rows[0]!.m;
  const title = (await effectiveTitles(c)).get(me) ?? null;
  const addr = addressFor(prefs.addressForm, title);
  const { rows } = await c.query<{
    id: string;
    event_type: NotificationEvent;
    actor_name: string | null;
    actor_id: string | null;
    title: string | null;
    number: number | null;
    meeting_id: string | null;
    knowledge_id: string | null;
    k_title: string | null;
    k_noun: string | null;
    m_title: string | null;
    m_scope: string | null;
    m_scheduled: Date | null;
    m_cancelled: Date | null;
    m_cancel_reason: string | null;
    m_organizer: string | null;
    m_idea_number: number | null;
    m_idea_title: string | null;
    m_reason: string | null;
    m_required: boolean | null;
    p_attendance: MeetingInvite['attendance'] | null;
    p_consent: MeetingInvite['consent'] | null;
    created_at: Date;
    read_at: Date | null;
  }>(
    `SELECT n.id, n.event_type, CASE WHEN n.event_type LIKE 'knowledge\_%' THEN app_knowledge_person(n.actor_membership_id) ELSE u.display_name END AS actor_name, n.actor_membership_id AS actor_id, r.title, i.number, n.meeting_id, k.id AS knowledge_id, k.title AS k_title,
            CASE WHEN k.kind = 'method' THEN 'метода' ELSE 'знания' END AS k_noun,
            mt.title AS m_title, mt.scope AS m_scope, mt.scheduled_at AS m_scheduled, mt.cancelled_at AS m_cancelled,
            mt.cancel_reason AS m_cancel_reason, ou.display_name AS m_organizer, mi.number AS m_idea_number, mr.title AS m_idea_title,
            CASE
              WHEN mt.id IS NULL THEN NULL
              WHEN mi.decision_owner_membership_id = app_membership_id() THEN 'вы принимаете решение по этому обращению'
              WHEN mi.maintainer_membership_id = app_membership_id() THEN 'вы ведёте это обращение'
              WHEN app_membership_id() IN (mi.author_membership_id, mi.raised_by_membership_id) THEN 'вы подняли этот вопрос'
              WHEN EXISTS (SELECT 1 FROM departments d WHERE d.id = mt.department_id AND d.head_membership_id = app_membership_id())
                THEN 'вы глава этого замка'
              WHEN EXISTS (SELECT 1 FROM departments d WHERE d.head_membership_id = app_membership_id() AND d.active)
                THEN 'вы глава подразделения, решение касается нескольких замков'
              ELSE 'организатор пригласил вас как участника'
            END AS m_reason,
            CASE WHEN mt.id IS NULL THEN NULL ELSE
              (om.roles && ARRAY['org_admin']::text[])
              OR (mt.scope = 'royal' AND om.roles && ARRAY['decision_owner']::text[])
              OR (mt.scope = 'castle' AND EXISTS (SELECT 1 FROM departments d WHERE d.id = mt.department_id AND d.head_membership_id = mt.organizer_membership_id))
            END AS m_required,
            mp.attendance AS p_attendance, mp.consent AS p_consent, n.created_at, n.read_at
       FROM notifications n
       LEFT JOIN memberships am ON am.id = n.actor_membership_id
       LEFT JOIN users u ON u.id = am.user_id
       LEFT JOIN ideas i ON i.id = n.idea_id
       LEFT JOIN idea_revisions r ON r.idea_id = i.id AND r.number = i.current_revision_number
       LEFT JOIN meetings mt ON mt.id = n.meeting_id
       LEFT JOIN memberships om ON om.id = mt.organizer_membership_id
       LEFT JOIN users ou ON ou.id = om.user_id
       LEFT JOIN ideas mi ON mi.id = mt.idea_id
       LEFT JOIN idea_revisions mr ON mr.idea_id = mi.id AND mr.number = mi.current_revision_number
       LEFT JOIN meeting_participants mp ON mp.meeting_id = mt.id AND mp.membership_id = app_membership_id()
       LEFT JOIN knowledge_items k ON k.id = n.knowledge_id -- RLS: only knowledge the reader may still see
      WHERE n.recipient_membership_id = app_membership_id()
      ORDER BY n.created_at DESC LIMIT $1`,
    [limit],
  );
  const titles = await effectiveTitles(c);
  return rows.map((r) => {
    const topic = r.title ?? r.m_title ?? r.k_title ?? (r.event_type.startsWith('knowledge_') ? 'знание недоступно' : '—');
    const royalFn = prefs.style === 'royal' ? ROYAL[r.event_type] : undefined;
    const required = !!r.m_required;
    const actorTitle = r.actor_id ? titles.get(r.actor_id) : null;
    let headline = (prefs.style === 'royal' ? HEADLINES : BUSINESS_HEADLINES)[r.event_type];
    if (prefs.style === 'royal' && r.event_type === 'meeting_called') {
      // The headline names the King or the Regent only when the real sender holds that title.
      headline =
        actorTitle?.rank === 'king' ? 'Король созывает Совет' : actorTitle?.rank === 'regent' ? 'Регент созывает Совет' : r.m_scope === 'castle' ? 'Созван малый совет замка' : 'Созван Королевский совет';
    }
    const meeting: MeetingInvite | null =
      r.m_title !== null
        ? {
            title: r.m_title,
            organizer: r.m_organizer ?? '—',
            scheduledAt: r.m_scheduled?.toISOString() ?? null,
            ideaNumber: r.m_idea_number,
            ideaTitle: r.m_idea_title,
            reason: r.m_reason ?? '',
            required,
            action: r.m_cancelled
              ? 'Ничего делать не нужно: заседание отменено'
              : r.p_consent === 'pending'
                ? 'Подтвердите участие и ответьте, согласны ли вы на запись'
                : r.p_attendance === 'pending'
                  ? 'Подтвердите участие'
                  : 'Ознакомьтесь с вопросом до заседания',
            attendance: r.p_attendance ?? 'pending',
            consent: r.p_consent ?? 'pending',
            cancelled: !!r.m_cancelled,
            cancelReason: r.m_cancel_reason,
          }
        : null;
    return {
      id: r.id,
      event: r.event_type,
      category: CATEGORY[r.event_type],
      message: TEMPLATES[r.event_type](r.actor_name ?? 'Система', topic),
      royal: royalFn ? royalFn({ addr, topic, required, noun: r.k_noun ?? undefined }) : null,
      headline,
      urgent: URGENT.includes(r.event_type),
      ideaNumber: r.number,
      meetingId: r.meeting_id,
      knowledgeId: r.knowledge_id,
      meeting,
      meetingClosed: r.meeting_id !== null && r.m_title === null,
      createdAt: r.created_at.toISOString(),
      readAt: r.read_at?.toISOString() ?? null,
    };
  });
}

export const PreferencesInput = z
  .object({
    style: z.enum(['royal', 'business']),
    addressForm: z.enum(['title', 'milord', 'milady', 'master', 'neutral']),
    groupRepeats: z.boolean(),
    muted: z.array(z.enum(NOTIFICATION_EVENTS)).max(40).default([]),
  })
  .strict();

export async function getPreferences(db: Database, actor: OrgActor) {
  return withTx(db, orgTx(actor), async (c) => {
    const prefs = await loadPreferences(c);
    const title = (await effectiveTitles(c)).get(actor.membershipId) ?? null;
    return {
      ...prefs,
      address: addressFor(prefs.addressForm, title),
      title: title?.title ?? null,
      mandatory: MANDATORY,
      categories: CATEGORY,
      channels: [
        { id: 'app', label: 'В приложении', available: true },
        { id: 'email', label: 'Электронная почта', available: false, note: 'не подключена' },
        { id: 'messenger', label: 'Мессенджер', available: false, note: 'не подключён' },
      ],
      note: 'Игровое обращение меняет только слова. Права в системе задаются ролями.',
    };
  });
}

export async function savePreferences(db: Database, actor: OrgActor, input: z.infer<typeof PreferencesInput>) {
  const muted = input.muted.filter((e) => !MANDATORY.includes(e));
  return withTx(db, orgTx(actor), async (c) => {
    await c.query(
      `INSERT INTO notification_preferences (organization_id, membership_id, style, address_form, group_repeats)
       VALUES (app_org_id(), app_membership_id(), $1, $2, $3)
       ON CONFLICT (organization_id, membership_id) DO UPDATE
         SET style = EXCLUDED.style, address_form = EXCLUDED.address_form, group_repeats = EXCLUDED.group_repeats, updated_at = clock_timestamp()`,
      [input.style, input.addressForm, input.groupRepeats],
    );
    // Optional events: the existing per-event subscriptions (global rows, idea_id NULL).
    await c.query(
      'DELETE FROM notification_subscriptions WHERE organization_id = app_org_id() AND membership_id = app_membership_id() AND idea_id IS NULL',
    );
    for (const e of muted) {
      await c.query(
        `INSERT INTO notification_subscriptions (organization_id, membership_id, event_type, enabled) VALUES (app_org_id(), app_membership_id(), $1, false)`,
        [e],
      );
    }
    return { ...input, muted };
  });
}

export const listInbox = (db: Database, actor: OrgActor) => withTx(db, orgTx(actor), (c) => inbox(c));

/** Marks notifications as read; RLS limits the update to the caller's own inbox. */
export async function markRead(db: Database, actor: OrgActor, ids: string[]): Promise<number> {
  return withTx(db, orgTx(actor), async (c) => {
    const { rowCount } = await c.query(
      'UPDATE notifications SET read_at = now() WHERE id = ANY($1::uuid[]) AND read_at IS NULL',
      [ids],
    );
    return rowCount ?? 0;
  });
}
