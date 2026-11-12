/**
 * Cinematic notifications (ADR-0031): the one registry of which confirmed server fact plays which
 * short video, to whom, and what happens when the person closes it.
 *
 * Rules that this module enforces and that its tests prove:
 * - a scene follows a fact the server has already stored and addressed to this reader (a row of
 *   their own `/notifications`, or an audience in their own `/audiences`). The video never decides,
 *   grants, approves or awards anything; closing it changes no data;
 * - one fact plays at most once per person on a device: it is written down the moment it is shown;
 * - nothing from before the person first used this device for the organization plays, and nothing
 *   older than three days plays at all — history is read in «Уведомления», not replayed;
 * - a fact without a verified scene gets no substitute: it is a plain text notice, or nothing.
 *
 * No DOM, no React, no imports: the rules are tested directly (test/platform/cinematics.test.ts).
 */

export type SceneId =
  | 'council-invitation'
  | 'changes-requested'
  | 'assignment'
  | 'castle-level-up'
  | 'implementation-approved'
  | 'implementation-completed'
  | 'knowledge-in-library'
  | 'knowledge-archived'
  | 'envoy-sent'
  | 'envoy-arrived'
  | 'envoy-accepted'
  | 'notification';

export interface Scene {
  id: SceneId;
  /** Web version, 720×1280 H.264 + AAC, `faststart` (web/public/cinematics). */
  src: string;
  /** Last frame: the still picture for reduced motion and «облегчённая графика», and the poster. */
  poster: string;
  seconds: number;
  /** What the voice says (Russian), transcribed from the file itself by two speech models. */
  voice: string;
  /** `partial`: one word was not recognised with confidence (see ADR-0031); the meaning is clear. */
  voiceCheck: 'verified' | 'partial';
  /** The voice addresses the reader this way; anyone who chose another form hears no voice. */
  address?: 'milord';
  /** `prompt` asks «Хотите посмотреть сейчас?» and gets «Сейчас» / «Позже». */
  kind: 'individual' | 'celebration' | 'prompt';
  /** The original from the owner's archive `MODUS_FLOW_cinematics_for_Claude.zip`. */
  source: { file: string; sha256: string };
}

const scene = (id: SceneId, seconds: number, voice: string, kind: Scene['kind'], file: string, sha256: string, extra: Partial<Scene> = {}): Scene => ({
  id,
  src: `/cinematics/${id}.mp4`,
  poster: `/cinematics/${id}.jpg`,
  seconds,
  voice,
  voiceCheck: 'verified',
  kind,
  source: { file, sha256 },
  ...extra,
});

export const SCENES: Readonly<Record<SceneId, Scene>> = {
  'council-invitation': scene('council-invitation', 4.96, 'Вас приглашают обсудить вопрос на Совете.', 'individual', '14_council_invitation.mp4', '88d7dae6fffe64f43842b8fa9d485b0535d2c79f263b37596c3da0bd0442f0ee'),
  'changes-requested': scene('changes-requested', 3.92, 'Совет просит уточнений.', 'individual', '12_changes_requested.mp4', '0ac98ed98363ae9a74cab9a0058e17b8700a8c6a922eda026cbf1ed62f710f61'),
  assignment: scene('assignment', 3.92, 'Вам поручено дело!', 'individual', '07_assignment_created.mp4', '0c04c262485b3318eb31c72913af4a256f60b17b79b742c2a3e59a69ef51e184'),
  'castle-level-up': scene('castle-level-up', 3.92, 'Замок достиг нового уровня!', 'celebration', '05_castle_level_up.mp4', '4fedfae33cf4453cc8c6bd55e47056ce4e72de6e103437bd688a4d74477838ea'),
  // The archive's names of 02 and 08 are swapped: the voice decides, not the name (both show a seal).
  'implementation-approved': scene('implementation-approved', 4.96, 'Внедрение одобрено.', 'individual', '02_envoy_accepted.mp4', '43fe57f75f9a0e6c5827aa7a8d8eff818ff16bf9ddc5f93268d3ba4b119585d9'),
  'implementation-completed': scene('implementation-completed', 4.96, 'Внедрение успешно завершено.', 'celebration', '03_implementation_completed.mp4', '5521536ec660fbc6aedbbdfd86d99da4259c6b8cb42b7c89c405bd86806a4984'),
  'knowledge-in-library': scene('knowledge-in-library', 3.92, 'Новое знание пополнило библиотеку.', 'celebration', '10_knowledge_in_library.mp4', '0bddc7750e0c3e1c9282eb4b1a107456322087e855fc67405c068c4987dc7ccd'),
  'knowledge-archived': scene('knowledge-archived', 3.92, '… принят в Высший Архив.', 'celebration', '01_knowledge_archived.mp4', '2196472a9ee65c624c4660ea4ab31e5766569c0417d3ce84e27502c9f5ac9a16', { voiceCheck: 'partial' }),
  'envoy-sent': scene('envoy-sent', 4.96, 'Ваш посол отправлен!', 'individual', '13_envoy_sent.mp4', '73216e5ce2456a64e6de41661bcc6d63f521c6b24f953e58e28467d0910cd8ce'),
  'envoy-arrived': scene('envoy-arrived', 4.96, 'Милорд, к вам прибыл посол!', 'individual', '11_envoy_arrived.mp4', '0d4fe63db0553664dbe3a3da54190bdec85063b3b346caf8372e0fe771169a4b', { address: 'milord' }),
  'envoy-accepted': scene('envoy-accepted', 4.96, 'Король принял вашего посла.', 'individual', '08_implementation_approved.mp4', 'a7fae23dd31593c077d10b2a4af4e10983edf50e5fcbb38c59c2141ecb02e041'),
  notification: scene('notification', 4.96, 'К вам пришло уведомление. Хотите посмотреть сейчас?', 'prompt', '16_notification_variant_a.mp4', 'fd126bbd16632835a229d2168f18cc441500342ae14660acf4ea28c0232e41e8'),
};

/**
 * Notification events (platform/domain/model.ts) with their own scene. The guard says what the
 * server has already checked when it wrote the row (app_notify verifies the record and the
 * recipient); the scene only announces it.
 */
export const BY_EVENT: Readonly<Record<string, { scene: SceneId; guard: string }>> = {
  meeting_called: { scene: 'council-invitation', guard: 'Читатель приглашён на это заседание; заседание не отменено и ему доступно' },
  changes_requested: { scene: 'changes-requested', guard: 'Рецензия «нужны уточнения» записана по обращению читателя' },
  assigned: { scene: 'assignment', guard: 'Читатель назначен ведущим, решающим или исполнителем' },
  castle_level_up: { scene: 'castle-level-up', guard: 'База начислила XP и замок перешёл порог уровня; читатель — автор или инициатор' },
  idea_merged: { scene: 'implementation-approved', guard: 'Уполномоченный записал решение «внедрять» (стадия «внедрение»); это не завершение работ' },
  implemented: { scene: 'implementation-completed', guard: 'Исполнитель сообщил, что изменение внедрено (стадия «проверка эффекта»); эффект ещё не подтверждён' },
  knowledge_in_library: { scene: 'knowledge-in-library', guard: 'Знание принято в Библиотеку решений; это не Высший Архив' },
  knowledge_archived: { scene: 'knowledge-archived', guard: 'Знание утверждено в Высший Архив' },
};

/** A real event with no verified video: an ordinary text notice, never a borrowed scene. */
export const TEXT_ONLY: readonly string[] = ['meeting_cancelled'];

/**
 * Archive files that are deliberately NOT connected, with the reason. Adding one needs a server
 * event that exists and an owner decision (ADR-0031, «Вопросы владельцу»).
 */
export const NOT_CONNECTED: readonly { file: string; voice: string; reason: string }[] = [
  { file: '04_contribution_recognized.mp4', voice: 'Ваш вклад признан.', reason: 'Событие contribution_confirmed объявлено, но сервер его нигде не создаёт' },
  { file: '06_proposal_under_review.mp4', voice: 'Предложение на рассмотрение.', reason: 'Автору не приходит отдельное событие «обращение взято на рассмотрение»' },
  { file: '09_knowledge_library_alt.mp4', voice: 'Решение внесено в библиотеку.', reason: 'Второй вариант для knowledge_in_library; одно событие — одна сцена' },
  { file: '15_great_council_gathered.mp4', voice: 'Великий Совет собран!', reason: 'Нет проверенного серверного факта «заседание началось»; приглашение им не является' },
  { file: '17_notification_variant_b.mp4', voice: 'К вам пришло уведомление. Хотите посмотреть сейчас?', reason: 'Второй вариант общего уведомления; выбран вариант A' },
];

/** What the person sees first when several facts arrive together: what asks them to act. */
const PRIORITY: Readonly<Record<SceneId | 'text', number>> = {
  'council-invitation': 100,
  assignment: 95,
  'changes-requested': 90,
  'envoy-arrived': 85,
  text: 80,
  notification: 70,
  'implementation-approved': 60,
  'implementation-completed': 58,
  'castle-level-up': 56,
  'envoy-accepted': 54,
  'knowledge-archived': 52,
  'knowledge-in-library': 50,
  'envoy-sent': 40,
};

/** Older facts are history: they are read in «Уведомления», not replayed. */
export const FRESH_MS = 72 * 3600 * 1000;
/** At most this many scenes follow one another; the rest wait in «Уведомления». */
export const BATCH = 3;

// ---------------------------------------------------------------------------
// Input: the reader's own server data, as the web app already receives it.
// ---------------------------------------------------------------------------
export interface NoteIn {
  id: string;
  event: string;
  headline: string;
  message: string;
  urgent: boolean;
  ideaNumber: number | null;
  meetingId: string | null;
  knowledgeId: string | null;
  meeting: { cancelled: boolean } | null;
  meetingClosed: boolean;
  createdAt: string;
  readAt: string | null;
}
export interface AudienceIn {
  id: string;
  ideaNumber: number;
  title: string;
  role: 'sender' | 'king';
  status: 'requested' | 'accepted';
  requestedAt: string;
  acceptedAt: string | null;
}

export interface Cue {
  /** Exactly one per fact and reader-side state: `n:<notification id>` or `a:<audience id>:<status>`. */
  key: string;
  scene: Scene | null;
  title: string;
  text: string;
  href: string;
  linkLabel: string;
  at: number;
  priority: number;
  /** For audiences: the key of the existing SVG scene, so it does not play the same fact again. */
  audienceId?: string;
}

const link = (n: Pick<NoteIn, 'ideaNumber' | 'meetingId' | 'knowledgeId' | 'event'>): { href: string; linkLabel: string } => {
  if (n.event === 'castle_level_up') return { href: '#/kingdom', linkLabel: 'Открыть город' };
  if (n.meetingId) return { href: `#/meetings/${n.meetingId}`, linkLabel: 'Открыть заседание' };
  if (n.knowledgeId) return { href: `#/library/${n.knowledgeId}`, linkLabel: 'Открыть знание' };
  if (n.ideaNumber) return { href: `#/items/${n.ideaNumber}`, linkLabel: 'Открыть обращение' };
  return { href: '#/inbox', linkLabel: 'Открыть уведомления' };
};

/** One notification row → what to show, or null (nothing beyond the inbox, as before). */
export function cueForNote(n: NoteIn): Cue | null {
  const at = Date.parse(n.createdAt);
  const base = { key: `n:${n.id}`, title: n.headline, text: n.message, at, ...link(n) };
  const own = BY_EVENT[n.event];
  if (own) {
    // An invitation to a meeting that has since been cancelled, or that the reader may no longer
    // open, is not announced: the cancellation (or nothing) is the current fact.
    if (n.event === 'meeting_called' && (!n.meeting || n.meeting.cancelled || n.meetingClosed)) return null;
    return { ...base, scene: SCENES[own.scene], priority: PRIORITY[own.scene] };
  }
  if (TEXT_ONLY.includes(n.event)) return { ...base, scene: null, priority: PRIORITY.text };
  // Urgent facts without a scene of their own (the server's URGENT list): the general envelope,
  // which asks «Хотите посмотреть сейчас?». Routine facts stay in the inbox only.
  if (n.urgent) return { ...base, scene: SCENES.notification, priority: PRIORITY.notification };
  return null;
}

/** One audience as the reader sees it → what to show. Accepting an envoy is not approving the idea. */
export function cueForAudience(a: AudienceIn, me: { membershipId: string; currentKing: string | null }): Cue | null {
  const item = { href: `#/items/${a.ideaNumber}`, linkLabel: 'Открыть обращение' };
  if (a.role === 'sender' && a.status === 'requested')
    return { key: `a:${a.id}:requested`, scene: SCENES['envoy-sent'], title: 'Посол отправлен', text: `Обращение №${a.ideaNumber} «${a.title}» направлено Королю на аудиенцию. Это не меняет его статус.`, at: Date.parse(a.requestedAt), priority: PRIORITY['envoy-sent'], audienceId: a.id, ...item };
  if (a.role === 'sender' && a.status === 'accepted' && a.acceptedAt)
    return { key: `a:${a.id}:accepted`, scene: SCENES['envoy-accepted'], title: 'Король принял вашего посла', text: `Обращение №${a.ideaNumber} принято к ознакомлению. Это подтверждение приёма, не решение и не обещание внедрения.`, at: Date.parse(a.acceptedAt), priority: PRIORITY['envoy-accepted'], audienceId: a.id, ...item };
  // Only the person who is the King now receives the envoy; a former King is not called.
  if (a.role === 'king' && a.status === 'requested' && me.currentKing === me.membershipId)
    return { key: `a:${a.id}:requested`, scene: SCENES['envoy-arrived'], title: 'Прибыл посол', text: `Посол с обращением №${a.ideaNumber} «${a.title}» ждёт аудиенции. Приём посла не означает одобрения.`, at: Date.parse(a.requestedAt), priority: PRIORITY['envoy-arrived'], audienceId: a.id, href: '#/inbox', linkLabel: 'Принять в посланиях' };
  return null;
}

// ---------------------------------------------------------------------------
// Memory on the device: what was shown, and since when this device takes part.
// ---------------------------------------------------------------------------
export type Outcome = 'shown' | 'played' | 'opened' | 'skipped' | 'later' | 'text' | 'failed' | 'batched';
export interface Ledger {
  v: 1;
  seen: Record<string, Outcome>;
  order: string[];
}
const LEDGER_CAP = 400;
export const emptyLedger = (): Ledger => ({ v: 1, seen: {}, order: [] });

export function parseLedger(raw: string | null): Ledger {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Ledger>) : null;
    if (v && v.v === 1 && v.seen && typeof v.seen === 'object' && Array.isArray(v.order)) return { v: 1, seen: { ...v.seen }, order: [...v.order] };
  } catch {
    /* a broken record starts again: worst case one scene plays once more */
  }
  return emptyLedger();
}

/** Write an outcome down; the oldest keys are forgotten past the cap (they are long out of the window). */
export function remember(l: Ledger, key: string, outcome: Outcome): Ledger {
  const seen = { ...l.seen, [key]: outcome };
  const order = l.order.includes(key) ? l.order : [...l.order, key];
  while (order.length > LEDGER_CAP) delete seen[order.shift()!];
  return { v: 1, seen, order };
}

/**
 * Since when this device takes part for this organization. The first visit of any person starts it,
 * so a colleague who signs in later on the same computer still sees what happened after that. A
 * database seeded again (the demo's `--fresh`) has new member ids: then the device starts again and
 * the seeded history is not replayed. Returns null while it cannot tell yet (no directory).
 */
export interface DeviceSince {
  since: number;
  members: string[];
}
export function deviceSince(prev: DeviceSince | null, me: string, directory: readonly string[] | null, now: number): DeviceSince | null {
  if (!prev) return { since: now, members: [me] };
  const add = (m: string[]) => (m.includes(me) ? m : [...m, me].slice(-200));
  if (prev.members.includes(me)) return prev;
  if (!directory) return null;
  if (prev.members.some((id) => directory.includes(id))) return { since: prev.since, members: add(prev.members) };
  return { since: now, members: [me] };
}

/**
 * Everything to show now, most important first, the rest written down as `batched`. A fact is a
 * candidate only if it is the reader's own, unread (for notifications), not older than the window,
 * newer than the device's start, and not written down before.
 */
export function plan(input: {
  notes: readonly NoteIn[];
  audiences: readonly AudienceIn[];
  membershipId: string;
  currentKing: string | null;
  ledger: Ledger;
  since: number;
  now: number;
  /** Business wording (ADR-0016): the person switched the game off; scenes are game wording. */
  style: 'royal' | 'business';
}): { show: Cue[]; batched: Cue[] } {
  if (input.style === 'business') return { show: [], batched: [] };
  const fresh = (c: Cue) => Number.isFinite(c.at) && c.at > input.since && input.now - c.at <= FRESH_MS && !(c.key in input.ledger.seen);
  const cues = [
    ...input.notes.filter((n) => !n.readAt).map(cueForNote),
    ...input.audiences.map((a) => cueForAudience(a, { membershipId: input.membershipId, currentKing: input.currentKing })),
  ]
    .filter((c): c is Cue => c !== null && fresh(c))
    .sort((a, b) => b.priority - a.priority || b.at - a.at);
  return { show: cues.slice(0, BATCH), batched: cues.slice(BATCH) };
}

// ---------------------------------------------------------------------------
// How it plays on this device.
// ---------------------------------------------------------------------------
export interface Settings {
  /** «Кинематографические уведомления» on this device. */
  enabled: boolean;
  /** Voice on. Browsers may still block sound until the person interacts with the page. */
  sound: boolean;
}
export const DEFAULT_SETTINGS: Settings = { enabled: true, sound: true };

export function parseSettings(raw: string | null): Settings {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    return { enabled: v.enabled !== false, sound: v.sound !== false };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export type Mode = 'video' | 'still' | 'text' | 'off';
/** Full graphics: the video. Reduced motion or «облегчённая графика»: its still frame. No scene: text. */
export function modeFor(cue: Cue, env: { settings: Settings; lite: boolean; reducedMotion: boolean }): Mode {
  if (!env.settings.enabled) return 'off';
  if (!cue.scene) return 'text';
  return env.lite || env.reducedMotion ? 'still' : 'video';
}

/** The voice plays only if the person wants sound and the scene addresses them the way they chose. */
export function soundFor(scene: Scene, env: { settings: Settings; addressForm: string | null }): boolean {
  if (!env.settings.sound) return false;
  if (scene.address && env.addressForm !== scene.address) return false;
  return true;
}

/** What the person did → what is written down. None of these changes any data on the server. */
export type Action = 'now' | 'later' | 'skip' | 'open' | 'close' | 'next' | 'failed';
export function outcomeOf(action: Action, ended: boolean): Outcome {
  if (action === 'now' || action === 'open') return 'opened';
  if (action === 'later') return 'later';
  if (action === 'failed') return 'failed';
  if (action === 'skip') return 'skipped';
  return ended ? 'played' : 'skipped';
}
/** After «Сейчас», «Открыть», «Позже» or «Пропустить» the rest of the batch waits in «Уведомления». */
export const continuesBatch = (action: Action) => action === 'next';
