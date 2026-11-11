import { z } from 'zod';
import { AppError, forbidden, notFound } from '../domain/errors.ts';
import {
  ACTIONS,
  ACTION_TITLE,
  ARCHIVE_CATEGORY_TITLE,
  Card,
  cardText,
  KINDS,
  KIND_TITLE,
  LEVEL_PROOF,
  LEVEL_TITLE,
  LEVELS,
  longestSharedRun,
  MAX_QUOTED_WORDS,
  STATUS_TITLE,
  templateNote,
  type Action,
  type CardT,
  type Level,
} from '../domain/legacy.ts';
import type { OrgActor } from '../domain/model.ts';
import { STATUS_INFO, type ItemStatus } from '../domain/status.ts';
import { CONFIDENTIAL_KINDS, findSensitive, kindsText, meetingOverlap, OVERLAP_LABEL } from '../domain/privacy.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { membersWithRoles } from './notifications.ts';

/**
 * «Наследие Королевства» (ADR-0017). One knowledge model, three halls:
 *   Летопись (chronicle) → Библиотека решений (library) → Высший Архив (archive).
 * Knowledge references its sources (items, meetings, findings); it never copies a
 * transcript, so retention and access rules of the source keep working. Every level
 * change is a deliberate act of a person with a system role, checked by the database
 * (0012_legacy.sql) and kept in an append-only history. Game titles grant nothing.
 * The helper («Помощник Архивариуса») matches words and fills a template — it is
 * labelled as such and is not AI analysis. The AI archivist is not connected.
 */

// The database explains refusals in English (they are also guards for any other client);
// the people using the app read Russian.
const RU: [RegExp, string][] = [
  [/needs the archivist role or a lead role/, 'Вносить в Летопись может Архивариус или руководитель'],
  [/at least one source/, 'Укажите хотя бы один источник: знание без происхождения не регистрируется'],
  [/a source is not visible to you/, 'Один из источников вам недоступен — сослаться можно только на то, что вы видите'],
  [/archived knowledge is revised only after a re-verification request/, 'Знание Высшего Архива меняется только после запроса повторной проверки'],
  [/a review is pending/, 'Сначала решите текущее рассмотрение'],
  [/the original item is not a re-application/, 'Исходное обращение не считается повторным применением'],
  [/say why/, 'Укажите причину (не короче 5 символов)'],
  [/only an active chronicle entry/, 'В Библиотеку предлагается только действующая запись Летописи'],
  [/the card needs the problem, the decision and the reasons/, 'Для Библиотеки заполните проблему, решение и причины выбора (от 10 символов)'],
  [/the archivist checks entries/, 'Запись в Библиотеку проверяет Архивариус'],
  [/nothing proposed/, 'Нет предложения на рассмотрении'],
  [/the proposer does not accept their own proposal/, 'Предложивший не принимает собственное предложение — нужна вторая пара глаз'],
  [/the archivist prepares the conclusion/, 'Заключение для Высшего Архива готовит Архивариус'],
  [/only verified library knowledge/, 'В Высший Архив представляется только проверенное знание Библиотеки'],
  [/the conclusion needs proof/, 'Заключение: нужны доказанность, область применимости, дата последней проверки, основания и категория'],
  [/a method needs at least one confirmed re-application/, 'Метод: нужно хотя бы одно повторное применение на другом обращении с подтверждённым внедрением'],
  [/an improvement needs the effect/, 'Улучшение: эффект исходного обращения должен быть подтверждён ответственным'],
  [/a lesson needs the negative experience/, 'Урок: опишите отрицательный опыт'],
  [/approved by a decision owner or an admin/, 'Включение в Высший Архив утверждает ответственный за решения или администратор'],
  [/no conclusion to decide/, 'Нет заключения на утверждение'],
  [/the author of the conclusion does not approve it/, 'Автор заключения не утверждает его сам'],
  [/no right to change the status/, 'Нет права менять статус знания'],
  [/the archivist reconfirms/, 'Повторно подтверждает Архивариус'],
  [/reconfirmed through a new conclusion/, 'Знание Высшего Архива подтверждается новым заключением и утверждением'],
  [/an approver opens knowledge/, 'Открыть знание всей организации может ответственный за решения или администратор'],
  [/not allowed to revise|not allowed to add|not allowed to record|knowledge not found/, 'Нет доступа к этому знанию'],
  [/only an organization admin grants the archivist role/, 'Роль Архивариуса назначает администратор организации'],
  [/member not found/, 'Сотрудник не найден'],
];
async function db_<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err?.code === '42501' || err?.code === '23514') {
      const hit = RU.find(([re]) => re.test(err.message ?? ''));
      if (hit) throw new AppError(err.code === '42501' ? 'forbidden' : 'validation_failed', hit[1]);
    }
    throw e;
  }
}

const has = (a: OrgActor, ...roles: string[]) => a.access === 'member' && a.roles.some((r) => roles.includes(r));
const isArchivist = (a: OrgActor) => has(a, 'archivist');
const isApprover = (a: OrgActor) => has(a, 'decision_owner', 'org_admin');
const canCurate = (a: OrgActor) => has(a, 'archivist', 'maintainer', 'decision_owner', 'org_admin');

const SourceRef = z.union([
  z.object({ type: z.literal('idea'), number: z.number().int().positive(), note: z.string().trim().max(300).optional() }).strict(),
  z.object({ type: z.enum(['meeting', 'finding', 'knowledge']), id: z.uuid(), note: z.string().trim().max(300).optional() }).strict(),
]);
type SourceRefT = z.infer<typeof SourceRef>;

async function resolveSource(c: Client, s: SourceRefT): Promise<{ type: string; id: string; note: string | null }> {
  if (s.type === 'idea') {
    const { rows } = await c.query<{ id: string }>('SELECT id FROM ideas WHERE organization_id = app_org_id() AND number = $1', [s.number]);
    if (!rows[0]) throw notFound(`Обращение №${s.number} не найдено`);
    return { type: 'idea', id: rows[0].id, note: s.note ?? null };
  }
  return { type: s.type, id: s.id, note: s.note ?? null };
}

/**
 * The copy guard: no 12+ consecutive words of a meeting transcript (or of a finding's quote)
 * may move into the card. Knowledge outlives a transcript's retention period and its
 * participant-only access; a retold conclusion with a link to the source does not.
 */
async function assertNoTranscriptCopy(c: Client, title: string, card: CardT, sources: { type: string; id: string }[]) {
  const meetings = sources.filter((s) => s.type === 'meeting').map((s) => s.id);
  const findings = sources.filter((s) => s.type === 'finding').map((s) => s.id);
  if (!meetings.length && !findings.length) return;
  const { rows } = await c.query<{ text: string }>(
    `SELECT t.text FROM meeting_transcripts t
      WHERE t.organization_id = app_org_id() AND t.purged_at IS NULL AND t.text IS NOT NULL
        AND (t.meeting_id = ANY ($1::uuid[]) OR t.id IN (
              SELECT pr.transcript_id FROM protocol_candidates pc JOIN meeting_protocols pr ON pr.id = pc.protocol_id WHERE pc.id = ANY ($2::uuid[])))
     UNION ALL
     SELECT pc.quote FROM protocol_candidates pc WHERE pc.id = ANY ($2::uuid[]) AND pc.quote IS NOT NULL`,
    [meetings, findings],
  );
  const text = `${title}\n${cardText(card)}`;
  for (const r of rows) {
    const run = longestSharedRun(text, r.text);
    if (run > MAX_QUOTED_WORDS) {
      throw new AppError(
        'validation_failed',
        `В карточку перенесён фрагмент расшифровки заседания (${run} слов подряд). Перескажите вывод своими словами и оставьте ссылку на источник: ` +
          'расшифровка удаляется по сроку хранения и видна только участникам, а знание остаётся.',
      );
    }
  }
}

async function assertPeople(c: Client, card: CardT) {
  const ids = [...new Set([card.initiator, ...(card.responsible ?? [])].filter((x): x is string => !!x))];
  if (!ids.length) return;
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM employees WHERE organization_id = app_org_id() AND membership_id = ANY ($1::uuid[])`,
    [ids],
  );
  if (rows[0]!.n !== ids.length) throw new AppError('validation_failed', 'Автор инициативы и ответственные — сотрудники этой организации');
}

// ---------------------------------------------------------------------------
// Personal and confidential data (ADR-0018): checked at any length, on every text that
// enters knowledge. Messages name the place and the kind, never the data.
// ---------------------------------------------------------------------------
export const FIELD_TITLE: Record<string, string> = {
  title: 'Название', change_reason: 'Причина изменения', problem: 'Исходная проблема', options: 'Рассмотренные варианты',
  argumentsFor: 'Аргументы за', argumentsAgainst: 'Аргументы против', decision: 'Принятое решение', reasons: 'Причины выбора',
  actions: 'Действия и сроки', results: 'Результаты', positive: 'Положительный опыт', negative: 'Отрицательный опыт',
  evidence: 'Доказательства', proof: 'Доказанность', applicability: 'Область применимости', basis: 'Основания включения',
  reason: 'Причина', note: 'Примечание',
};
export async function orgPeople(c: Client): Promise<string[]> {
  const { rows } = await c.query<{ n: string }>('SELECT display_name AS n FROM employees WHERE organization_id = app_org_id()');
  return rows.map((r) => r.n);
}
export function cardTexts(title: string, card: CardT): [string, string][] {
  const out: [string, string][] = [['title', title]];
  for (const [k, v] of Object.entries(card)) if (typeof v === 'string' && FIELD_TITLE[k]) out.push([k, v]);
  if (card.actions?.length) out.push(['actions', card.actions.map((a) => a.what).join('\n')]);
  return out;
}
/** Refuses personal data in new text; confidentiality markers are refused only where the text would be organization-wide. */
async function assertNoPersonalData(c: Client, texts: [string, string | null | undefined][], opts: { organizationWide?: boolean } = {}) {
  const people = await orgPeople(c);
  const hits: string[] = [];
  for (const [field, text] of texts) {
    if (!text) continue;
    const fs = findSensitive(text, { people }).filter((f) => opts.organizationWide || !CONFIDENTIAL_KINDS.includes(f.kind));
    if (fs.length) hits.push(`«${FIELD_TITLE[field] ?? field}»: ${kindsText(fs)}`);
  }
  if (hits.length) {
    throw new AppError(
      'validation_failed',
      `Уберите персональные или конфиденциальные сведения — ${hits.join('; ')}. Людей указывайте в полях «Автор инициативы» и «Ответственные»: ` +
        'так их можно обезличить, а текст карточки остаётся без персональных данных.',
    );
  }
}

const cleanCard = (card: CardT): CardT => Object.fromEntries(Object.entries(card).filter(([, v]) => v !== '' && v !== undefined && !(Array.isArray(v) && !v.length))) as CardT;

// ---------------------------------------------------------------------------
// Registration, versions, sources, re-applications
// ---------------------------------------------------------------------------
export const RegisterInput = z
  .object({
    kind: z.enum(KINDS),
    title: z.string().trim().min(3).max(200),
    card: Card,
    sources: z.array(SourceRef).min(1).max(20),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export async function register(db: Database, actor: OrgActor, input: z.infer<typeof RegisterInput>) {
  if (!canCurate(actor)) throw forbidden('Вносить в Летопись может Архивариус или руководитель');
  return withTx(db, orgTx(actor), async (c) => {
    const card = cleanCard(input.card);
    const sources: { type: string; id: string; note: string | null }[] = [];
    for (const s of input.sources) sources.push(await resolveSource(c, s));
    await assertPeople(c, card);
    await assertNoTranscriptCopy(c, input.title, card, sources);
    await assertNoPersonalData(c, [...cardTexts(input.title, card), ['reason', input.reason], ...sources.map((s): [string, string | null] => ['note', s.note])]);
    const { rows } = await db_(() =>
      c.query<{ id: string }>('SELECT app_knowledge_register($1, $2, $3::jsonb, $4::jsonb, $5) AS id', [
        input.kind,
        input.title,
        JSON.stringify(card),
        JSON.stringify(sources),
        input.reason ?? null,
      ]),
    );
    const id = rows[0]!.id;
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'knowledge.registered', entityType: 'knowledge', entityId: id, data: { kind: input.kind, sources: sources.length } });
    return { id, level: 'chronicle' as Level };
  });
}

export const ReviseInput = z.object({ title: z.string().trim().min(3).max(200), card: Card, reason: z.string().trim().min(3).max(500) }).strict();

export async function revise(db: Database, actor: OrgActor, id: string, input: z.infer<typeof ReviseInput>) {
  return withTx(db, orgTx(actor), async (c) => {
    const card = cleanCard(input.card);
    const src = await c.query<{ type: string; id: string }>('SELECT source_type AS type, source_id AS id FROM knowledge_sources WHERE knowledge_id = $1', [id]);
    await assertPeople(c, card);
    await assertNoTranscriptCopy(c, input.title, card, src.rows);
    const open = (await c.query<{ v: string }>('SELECT visibility AS v FROM knowledge_items WHERE id = $1', [id])).rows[0]?.v === 'organization';
    await assertNoPersonalData(c, [...cardTexts(input.title, card), ['change_reason', input.reason]], { organizationWide: open });
    const { rows } = await db_(() => c.query<{ v: number }>('SELECT app_knowledge_revise($1, $2, $3::jsonb, $4) AS v', [id, input.title, JSON.stringify(card), input.reason]));
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'knowledge.revised', entityType: 'knowledge', entityId: id, data: { version: rows[0]!.v } });
    return { version: rows[0]!.v };
  });
}

export const SourceInput = SourceRef;
export async function addSource(db: Database, actor: OrgActor, id: string, input: SourceRefT) {
  return withTx(db, orgTx(actor), async (c) => {
    const s = await resolveSource(c, input);
    await assertNoPersonalData(c, [['note', s.note]]);
    await db_(() => c.query('SELECT app_knowledge_add_source($1, $2, $3, $4)', [id, s.type, s.id, s.note]));
    return { added: true };
  });
}

export const ApplicationInput = z.object({ ideaNumber: z.number().int().positive(), note: z.string().trim().min(5).max(500) }).strict();
/** A re-application of the method on another item. It counts as confirmed only once that item is implemented. */
export async function addApplication(db: Database, actor: OrgActor, id: string, input: z.infer<typeof ApplicationInput>) {
  return withTx(db, orgTx(actor), async (c) => {
    const s = await resolveSource(c, { type: 'idea', number: input.ideaNumber });
    await assertNoPersonalData(c, [['note', input.note]]);
    await db_(() => c.query('SELECT app_knowledge_add_application($1, $2, $3)', [id, s.id, input.note]));
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'knowledge.application_added', entityType: 'knowledge', entityId: id, data: { idea: input.ideaNumber } });
    return { added: true };
  });
}

// ---------------------------------------------------------------------------
// Transitions and the royal messages they trigger
// ---------------------------------------------------------------------------
export const ActInput = z.object({ action: z.enum(ACTIONS), reason: z.string().trim().max(1000).optional() }).strict();

/** People whose decision the knowledge records: the decision makers, owners and authors of its items, and the card's people. */
async function owners(c: Client, id: string): Promise<string[]> {
  const { rows } = await c.query<{ m: string }>(
    `SELECT DISTINCT m FROM (
       SELECT d.decided_by_membership_id AS m FROM knowledge_sources s JOIN decisions d ON d.idea_id = s.source_id WHERE s.knowledge_id = $1 AND s.source_type = 'idea'
       UNION SELECT i.decision_owner_membership_id FROM knowledge_sources s JOIN ideas i ON i.id = s.source_id WHERE s.knowledge_id = $1 AND s.source_type = 'idea'
       UNION SELECT i.author_membership_id FROM knowledge_sources s JOIN ideas i ON i.id = s.source_id WHERE s.knowledge_id = $1 AND s.source_type = 'idea'
       UNION SELECT k.created_by_membership_id FROM knowledge_items k WHERE k.id = $1
       UNION SELECT (v.card->>'initiator')::uuid FROM knowledge_items k JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version WHERE k.id = $1 AND v.card ? 'initiator'
       UNION SELECT jsonb_array_elements_text(v.card->'responsible')::uuid FROM knowledge_items k JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
              WHERE k.id = $1 AND jsonb_typeof(v.card->'responsible') = 'array'
     ) x WHERE m IS NOT NULL`,
    [id],
  );
  return rows.map((r) => r.m);
}

/** Stable order of places: versions (by number, then card order), then transitions, sources, applications. */
export function locOrder(loc: { t: string; v?: number; f?: string }): number {
  const fields = Object.keys(FIELD_TITLE);
  if (loc.t === 'version') return loc.v! * 100 + Math.max(0, fields.indexOf(loc.f!));
  return 1e6 + ['transition', 'source', 'application'].indexOf(loc.t);
}

/** Human-readable place of a text location: «версия 2, «Исходная проблема»». */
export function placeOf(loc: { t: string; v?: number; f?: string }): string {
  if (loc.t === 'version') return `версия ${loc.v}, «${FIELD_TITLE[loc.f!] ?? loc.f}»`;
  if (loc.t === 'transition') return 'причина в истории переходов';
  if (loc.t === 'source') return 'примечание к источнику';
  return 'примечание к повторному применению';
}

/**
 * Before knowledge is opened to the whole organization, EVERY version and note is checked —
 * old versions stay readable in the history. Refused if any contains personal data, a
 * confidentiality marker, or content of a closed source meeting (numbers, sensitive details or
 * a 6+ word phrase), whatever its length.
 */
async function assertReadyForOrganization(c: Client, id: string) {
  const people = await orgPeople(c);
  const all = (await c.query<{ loc: { t: string; v?: number; f?: string }; body: string }>('SELECT loc, body FROM app_knowledge_all_text($1)', [id])).rows
  all.sort((a, b) => locOrder(a.loc) - locOrder(b.loc));
  const material = (await c.query<{ body: string }>('SELECT body FROM app_knowledge_meeting_material($1)', [id])).rows.map((r) => r.body).join('\n');
  const hits: string[] = [];
  for (const r of all) {
    if (!r.body || r.loc.f === 'change_reason' && /^\[удалено/.test(r.body)) continue;
    const kinds = new Set(findSensitive(r.body, { people }).map((f) => f.kind as string));
    if (material && r.loc.t === 'version') for (const k of meetingOverlap(r.body, material, people)) kinds.add(k);
    if (kinds.size) hits.push(`${placeOf(r.loc)}: ${[...kinds].map((k) => OVERLAP_LABEL[k]).join(', ')}`);
  }
  if (hits.length) {
    throw new AppError(
      'validation_failed',
      `Нельзя открыть всей организации: ${hits.slice(0, 6).join('; ')}${hits.length > 6 ? ` и ещё ${hits.length - 6}` : ''}. ` +
        'Перескажите без этих сведений в новой версии; прежние версии с ними удаляет администратор по законному основанию.',
    );
  }
}

async function notifyKnowledge(c: Client, actor: OrgActor, event: string, id: string, recipients: string[], dedupe: string) {
  const targets = [...new Set(recipients.filter((r) => r && r !== actor.membershipId))];
  if (!targets.length) return 0;
  const { rows } = await c.query<{ n: number }>('SELECT app_notify_knowledge($1, $2, $3::uuid[], $4) AS n', [event, id, targets, dedupe]);
  return rows[0]!.n;
}

export async function act(db: Database, actor: OrgActor, id: string, input: z.infer<typeof ActInput>) {
  return withTx(db, orgTx(actor), async (c) => {
    await assertNoPersonalData(c, [['reason', input.reason]]);
    // Rights first: the content check must not tell an unauthorized person what the knowledge contains.
    if (input.action === 'opened_to_organization' && !isApprover(actor)) throw forbidden('Открыть знание всей организации может ответственный за решения или администратор');
    if (input.action === 'opened_to_organization') await assertReadyForOrganization(c, id);
    const { rows } = await db_(() => c.query<{ level: Level }>('SELECT app_knowledge_act($1, $2, $3) AS level', [id, input.action, input.reason ?? null]));
    const level = rows[0]!.level;
    const tr = (await c.query<{ id: string }>('SELECT id FROM knowledge_transitions WHERE knowledge_id = $1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0]!.id;
    let notified = 0;
    if (input.action === 'archive_proposed') {
      notified = await notifyKnowledge(c, actor, 'knowledge_submitted', id, await membersWithRoles(c, actor.orgId, ['decision_owner', 'org_admin']), tr);
    } else if (input.action === 'library_accepted') {
      notified = await notifyKnowledge(c, actor, 'knowledge_in_library', id, await owners(c, id), tr);
    } else if (input.action === 'archive_approved') {
      const conclusionBy = await c.query<{ m: string }>(
        `SELECT actor_membership_id AS m FROM knowledge_transitions WHERE knowledge_id = $1 AND action = 'archive_proposed' ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      notified = await notifyKnowledge(c, actor, 'knowledge_archived', id, [...(await owners(c, id)), ...(await membersWithRoles(c, actor.orgId, ['archivist'])), ...conclusionBy.rows.map((r) => r.m)], tr);
    } else if (input.action === 'reverify_requested') {
      const applied = await c.query<{ m: string }>('SELECT recorded_by_membership_id AS m FROM knowledge_applications WHERE knowledge_id = $1', [id]);
      notified = await notifyKnowledge(c, actor, 'knowledge_reverify', id, [...(await owners(c, id)), ...(await membersWithRoles(c, actor.orgId, ['archivist'])), ...applied.rows.map((r) => r.m)], tr);
    }
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: `knowledge.${input.action}`, entityType: 'knowledge', entityId: id, data: { level } });
    return { level, action: input.action, notified };
  });
}

// ---------------------------------------------------------------------------
// Reading: the three halls with one search, and the knowledge page
// ---------------------------------------------------------------------------
export const ListQuery = z
  .object({
    q: z.string().trim().max(200).optional(),
    level: z.enum(LEVELS).optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(['active', 'needs_review', 'outdated']).optional(),
  })
  .strict();

/** Last check older than this is shown as a hint («давно не проверялось») — never a transition by itself. */
export const STALE_DAYS = 365;

export async function list(db: Database, actor: OrgActor, f: z.infer<typeof ListQuery>) {
  return withTx(db, orgTx(actor), async (c) => {
    const q = f.q?.trim() || null;
    const { rows } = await c.query<{
      id: string;
      level: Level;
      status: keyof typeof STATUS_TITLE;
      review: string;
      kind: (typeof KINDS)[number];
      title: string;
      visibility: string;
      card: CardT;
      current_version: number;
      last_verified_at: Date | null;
      updated_at: Date;
      created_at: Date;
      sources: { type: string; number: number | null }[];
      applications: number;
      score: number | null;
    }>(
      `SELECT k.id, k.level, k.status, k.review, k.kind, k.title, k.visibility, v.card, k.current_version, k.last_verified_at, k.updated_at, k.created_at,
              (SELECT coalesce(jsonb_agg(jsonb_build_object('type', s.source_type, 'number', i.number) ORDER BY s.created_at), '[]')
                 FROM knowledge_sources s LEFT JOIN ideas i ON s.source_type = 'idea' AND i.id = s.source_id WHERE s.knowledge_id = k.id) AS sources,
              (SELECT count(*)::int FROM knowledge_applications a WHERE a.knowledge_id = k.id) AS applications,
              CASE WHEN $1::text IS NULL THEN NULL ELSE round(greatest(word_similarity($1, k.title), word_similarity($1, v.card::text))::numeric, 2)::float END AS score
         FROM knowledge_items k
         JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
        WHERE k.organization_id = app_org_id()
          AND ($2::text IS NULL OR k.level = $2) AND ($3::text IS NULL OR k.kind = $3) AND ($4::text IS NULL OR k.status = $4)
          AND ($1::text IS NULL
               OR to_tsvector('russian', v.title || ' ' || v.card::text) @@ plainto_tsquery('russian', $1)
               OR word_similarity($1, k.title) > 0.4 OR word_similarity($1, v.card::text) > 0.55)
        ORDER BY score DESC NULLS LAST, k.updated_at DESC
        LIMIT 200`,
      [q, f.level ?? null, f.kind ?? null, f.status ?? null],
    );
    const now = Date.now();
    const items = rows.map((r) => ({
      id: r.id,
      level: r.level,
      hall: LEVEL_TITLE[r.level],
      proof: LEVEL_PROOF[r.level],
      status: r.status,
      statusTitle: STATUS_TITLE[r.status],
      review: r.review,
      kind: r.kind,
      kindTitle: KIND_TITLE[r.kind],
      title: r.title,
      summary: (r.card.decision ?? r.card.problem ?? '').slice(0, 220),
      visibility: r.visibility,
      version: r.current_version,
      sources: r.sources.map((s) => (s.type === 'idea' ? `обращение №${s.number}` : s.type === 'meeting' ? 'заседание' : s.type === 'finding' ? 'находка заседания' : 'знание')),
      applications: r.applications,
      lastVerifiedAt: r.last_verified_at?.toISOString() ?? null,
      stale: r.level !== 'chronicle' && r.status === 'active' && now - (r.last_verified_at ?? r.created_at).getTime() > STALE_DAYS * 864e5,
      updatedAt: r.updated_at.toISOString(),
    }));
    const counts = Object.fromEntries(LEVELS.map((l) => [l, items.filter((i) => i.level === l).length]));
    return {
      items,
      counts,
      roles: { archivist: isArchivist(actor), approver: isApprover(actor), curator: canCurate(actor) },
      note: 'Поиск по словам среди знаний, доступных вам. Уровень проверки указан у каждого результата.',
    };
  });
}

interface TimelineEvent {
  at: string;
  what: string;
  who: string | null;
  source: string;
  link: string | null;
}

async function sourceDetails(c: Client, id: string) {
  const { rows } = await c.query<{ id: string; source_type: string; source_id: string; note: string | null; created_at: Date; added_by: string }>(
    `SELECT s.id, s.source_type, s.source_id, s.note, s.created_at, app_knowledge_person(e.membership_id) AS added_by
       FROM knowledge_sources s JOIN employees e ON e.membership_id = s.added_by_membership_id
      WHERE s.knowledge_id = $1 ORDER BY s.created_at`,
    [id],
  );
  const sources = [];
  const timeline: TimelineEvent[] = [];
  for (const s of rows) {
    if (s.source_type === 'idea') {
      const i = (
        await c.query<{ number: number; title: string; status: string; stage: string; author: string; published_at: Date }>(
          `SELECT o.number, o.title, o.status, o.stage, app_knowledge_person(o.author_membership_id) AS author, o.published_at FROM idea_overview o WHERE o.id = $1`,
          [s.source_id],
        )
      ).rows[0];
      if (!i) {
        sources.push({ type: 'idea', label: 'Обращение недоступно', available: false, note: s.note, addedBy: s.added_by, link: null });
        continue;
      }
      const link = `#/items/${i.number}`;
      const src = `обращение №${i.number}`;
      sources.push({ type: 'idea', label: `№${i.number} «${i.title}»`, detail: STATUS_INFO[i.status as ItemStatus]?.label ?? i.status, available: true, note: s.note, addedBy: s.added_by, link });
      timeline.push({ at: i.published_at.toISOString(), what: `Поднят вопрос «${i.title}»`, who: i.author, source: src, link });
      const facts = await c.query<{ at: Date; what: string; who: string | null }>(
        `SELECT ce.created_at AS at, CASE ce.kind WHEN 'recommendation' THEN 'Рекомендация Совета' WHEN 'argument_for' THEN 'Довод «за» в Совете' WHEN 'argument_against' THEN 'Довод «против» в Совете' WHEN 'dissent' THEN 'Особое мнение в Совете' ELSE 'Совет передал решение' END AS what, app_knowledge_person(e.membership_id) AS who
           FROM council_entries ce JOIN employees e ON e.membership_id = ce.author_membership_id WHERE ce.idea_id = $1
         UNION ALL
         SELECT d.created_at, CASE d.outcome WHEN 'merge' THEN 'Решение: внедрять' WHEN 'reject' THEN 'Решение: не внедрять' ELSE 'Решение: закрыть' END, app_knowledge_person(e.membership_id)
           FROM decisions d JOIN employees e ON e.membership_id = d.decided_by_membership_id WHERE d.idea_id = $1
         UNION ALL
         SELECT r.created_at, 'Отчёт о внедрении', app_knowledge_person(e.membership_id)
           FROM reviews r JOIN employees e ON e.membership_id = r.author_membership_id WHERE r.idea_id = $1 AND r.kind = 'progress'
         UNION ALL
         SELECT ea.created_at, 'Эффект подтверждён ответственным', app_knowledge_person(e.membership_id)
           FROM effect_approvals ea JOIN employees e ON e.membership_id = ea.approved_by_membership_id WHERE ea.idea_id = $1
         UNION ALL
         SELECT coalesce(m.scheduled_at, m.created_at), 'Заседание «' || m.title || '»', app_knowledge_person(e.membership_id)
           FROM meetings m JOIN employees e ON e.membership_id = m.organizer_membership_id WHERE m.idea_id = $1`,
        [s.source_id],
      );
      for (const f of facts.rows) timeline.push({ at: f.at.toISOString(), what: f.what, who: f.who, source: src, link });
    } else if (s.source_type === 'meeting') {
      // RLS on meetings: only participants see the title. Others see that a closed meeting exists.
      const m = (
        await c.query<{ title: string; at: Date; purged: boolean; organizer: string }>(
          `SELECT m.title, coalesce(m.scheduled_at, m.created_at) AS at, app_knowledge_person(e.membership_id) AS organizer,
                  EXISTS (SELECT 1 FROM meeting_transcripts t WHERE t.meeting_id = m.id AND t.purged_at IS NOT NULL) AS purged
             FROM meetings m JOIN employees e ON e.membership_id = m.organizer_membership_id WHERE m.id = $1`,
          [s.source_id],
        )
      ).rows[0];
      if (!m) {
        sources.push({ type: 'meeting', label: 'Закрытое заседание — доступно только участникам', available: false, note: s.note, addedBy: s.added_by, link: null });
        continue;
      }
      const link = `#/meetings/${s.source_id}`;
      sources.push({
        type: 'meeting',
        label: `Заседание «${m.title}»`,
        detail: m.purged ? 'расшифровка удалена по сроку хранения; подтверждённые выводы сохранены' : 'материалы заседания — у участников',
        available: true,
        note: s.note,
        addedBy: s.added_by,
        link,
      });
      timeline.push({ at: m.at.toISOString(), what: `Заседание «${m.title}»`, who: m.organizer, source: 'заседание', link });
    } else if (s.source_type === 'finding') {
      const f = (
        await c.query<{ title: string; type: string | null; status: string; meeting_id: string; decided_at: Date | null; number: number | null }>(
          `SELECT pc.proposed_title AS title, pc.finding_type AS type, pc.status, t.meeting_id, pc.decided_at, i.number
             FROM protocol_candidates pc JOIN meeting_protocols pr ON pr.id = pc.protocol_id JOIN meeting_transcripts t ON t.id = pr.transcript_id
             LEFT JOIN ideas i ON i.id = pc.item_id
            WHERE pc.id = $1 AND app_meeting_participant(t.meeting_id)`,
          [s.source_id],
        )
      ).rows[0];
      if (!f) {
        sources.push({ type: 'finding', label: 'Находка закрытого заседания — доступна только участникам', available: false, note: s.note, addedBy: s.added_by, link: null });
        continue;
      }
      const link = `#/meetings/${f.meeting_id}`;
      sources.push({ type: 'finding', label: `Находка «${f.title}»`, detail: f.status === 'accepted' ? `подтверждена человеком${f.number ? `, обращение №${f.number}` : ''}` : 'не подтверждена', available: true, note: s.note, addedBy: s.added_by, link });
      if (f.decided_at) timeline.push({ at: f.decided_at.toISOString(), what: `Находка заседания «${f.title}» ${f.status === 'accepted' ? 'подтверждена' : 'рассмотрена'}`, who: null, source: 'заседание', link });
    } else {
      const k = (await c.query<{ title: string; level: Level }>('SELECT title, level FROM knowledge_items WHERE id = $1', [s.source_id])).rows[0];
      sources.push(
        k
          ? { type: 'knowledge', label: `«${k.title}» (${LEVEL_TITLE[k.level]})`, available: true, note: s.note, addedBy: s.added_by, link: `#/library/${s.source_id}` }
          : { type: 'knowledge', label: 'Знание недоступно', available: false, note: s.note, addedBy: s.added_by, link: null },
      );
    }
  }
  return { sources, timeline };
}

export async function get(db: Database, actor: OrgActor, id: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const k = (
      await c.query<{
        id: string;
        level: Level;
        status: keyof typeof STATUS_TITLE;
        review: 'none' | 'library_proposed' | 'archive_proposed';
        kind: (typeof KINDS)[number];
        title: string;
        visibility: 'sources' | 'organization';
        current_version: number;
        last_verified_at: Date | null;
        created_at: Date;
        creator: string;
      }>(
        `SELECT k.id, k.level, k.status, k.review, k.kind, k.title, k.visibility, k.current_version, k.last_verified_at, k.created_at, app_knowledge_person(e.membership_id) AS creator
           FROM knowledge_items k JOIN employees e ON e.membership_id = k.created_by_membership_id
          WHERE k.id = $1 AND k.organization_id = app_org_id()`,
        [id],
      )
    ).rows[0];
    if (!k) throw notFound('Знание не найдено или недоступно вам');
    const versions = (
      await c.query<{ version: number; title: string; card: CardT; change_reason: string; author: string; created_at: Date }>(
        `SELECT v.version, v.title, v.card, v.change_reason, app_knowledge_person(e.membership_id) AS author, v.created_at
           FROM knowledge_versions v JOIN employees e ON e.membership_id = v.author_membership_id
          WHERE v.knowledge_id = $1 ORDER BY v.version DESC`,
        [id],
      )
    ).rows;
    const transitions = (
      await c.query<{ id: string; action: keyof typeof ACTION_TITLE; from_level: Level | null; to_level: Level | null; to_status: string | null; version: number; reason: string | null; actor: string; actor_id: string; created_at: Date }>(
        `SELECT t.id, t.action, t.from_level, t.to_level, t.to_status, t.version, t.reason, app_knowledge_person(e.membership_id) AS actor, t.actor_membership_id AS actor_id, t.created_at
           FROM knowledge_transitions t JOIN employees e ON e.membership_id = t.actor_membership_id
          WHERE t.knowledge_id = $1 ORDER BY t.created_at`,
        [id],
      )
    ).rows;
    const applications = (
      await c.query<{ number: number; title: string; note: string | null; recorded_by: string; implemented: boolean; created_at: Date }>(
        `SELECT o.number, o.title, a.note, app_knowledge_person(e.membership_id) AS recorded_by, app_idea_implemented(a.idea_id) AS implemented, a.created_at
           FROM knowledge_applications a JOIN idea_overview o ON o.id = a.idea_id JOIN employees e ON e.membership_id = a.recorded_by_membership_id
          WHERE a.knowledge_id = $1 ORDER BY a.created_at`,
        [id],
      )
    ).rows;
    const { sources, timeline } = await sourceDetails(c, id);
    const card = versions[0]!.card;
    const people = card.initiator || card.responsible?.length
      ? (
          await c.query<{ id: string; name: string }>('SELECT membership_id AS id, app_knowledge_person(membership_id) AS name FROM employees WHERE membership_id = ANY ($1::uuid[])', [
            [card.initiator, ...(card.responsible ?? [])].filter(Boolean),
          ])
        ).rows
      : [];
    const name = (m?: string) => people.find((p) => p.id === m)?.name ?? null;
    for (const t of transitions) timeline.push({ at: t.created_at.toISOString(), what: ACTION_TITLE[t.action], who: t.actor, source: 'Великая библиотека', link: null });
    for (const a of applications) timeline.push({ at: a.created_at.toISOString(), what: `Метод применён повторно: №${a.number} «${a.title}»${a.implemented ? ' — внедрено' : ' — ещё не внедрено'}`, who: a.recorded_by, source: `обращение №${a.number}`, link: `#/items/${a.number}` });
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    const lastBy = (action: string) => [...transitions].reverse().find((t) => t.action === action)?.actor_id;
    const me = actor.membershipId;
    const can: Partial<Record<Action | 'revise' | 'addSource' | 'addApplication', boolean>> = {
      revise: canCurate(actor) && k.review === 'none' && !(k.level === 'archive' && k.status === 'active'),
      addSource: canCurate(actor),
      addApplication: canCurate(actor),
      library_proposed: canCurate(actor) && k.level === 'chronicle' && k.review === 'none' && k.status !== 'outdated',
      library_accepted: isArchivist(actor) && k.review === 'library_proposed' && lastBy('library_proposed') !== me,
      library_rejected: isArchivist(actor) && k.review === 'library_proposed',
      archive_proposed: isArchivist(actor) && k.review === 'none' && k.status !== 'outdated' && (k.level === 'library' || (k.level === 'archive' && k.status === 'needs_review')),
      archive_approved: isApprover(actor) && k.review === 'archive_proposed' && lastBy('archive_proposed') !== me,
      archive_rejected: isApprover(actor) && k.review === 'archive_proposed' && lastBy('archive_proposed') !== me,
      reverify_requested: (canCurate(actor) || isApprover(actor)) && k.review === 'none' && k.status === 'active' && k.level !== 'chronicle',
      reconfirmed: isArchivist(actor) && k.status === 'needs_review' && k.level === 'library',
      outdated: (canCurate(actor) || isApprover(actor)) && k.review === 'none' && k.status !== 'outdated',
      opened_to_organization: isApprover(actor) && k.visibility === 'sources',
    };
    return {
      id: k.id,
      level: k.level,
      hall: LEVEL_TITLE[k.level],
      proof: LEVEL_PROOF[k.level],
      status: k.status,
      statusTitle: STATUS_TITLE[k.status],
      review: k.review,
      kind: k.kind,
      kindTitle: KIND_TITLE[k.kind],
      archiveCategoryTitle: card.archiveCategory ? ARCHIVE_CATEGORY_TITLE[card.archiveCategory] : null,
      title: k.title,
      visibility: k.visibility,
      visibilityNote:
        k.visibility === 'organization'
          ? 'Открыто всей организации по решению ответственного. Материалы закрытых заседаний по-прежнему видят только их участники.'
          : 'Видят только сотрудники, которым доступны все источники. Высший Архив не публичен по умолчанию.',
      version: k.current_version,
      card,
      initiator: name(card.initiator),
      responsible: (card.responsible ?? []).map((m) => name(m)).filter(Boolean),
      lastVerifiedAt: k.last_verified_at?.toISOString() ?? null,
      createdAt: k.created_at.toISOString(),
      creator: k.creator,
      sources,
      applications: applications.map((a) => ({ number: a.number, title: a.title, note: a.note, recordedBy: a.recorded_by, implemented: a.implemented, at: a.created_at.toISOString() })),
      versions: versions.map((v) => ({ version: v.version, title: v.title, card: v.card, reason: v.change_reason, author: v.author, at: v.created_at.toISOString() })),
      transitions: transitions.map((t) => ({ action: t.action, title: ACTION_TITLE[t.action], fromLevel: t.from_level, toLevel: t.to_level, toStatus: t.to_status, version: t.version, reason: t.reason, actor: t.actor, at: t.created_at.toISOString() })),
      timeline,
      can,
      roles: { archivist: isArchivist(actor), approver: isApprover(actor), curator: canCurate(actor) },
    };
  });
}

// ---------------------------------------------------------------------------
// «Помощник Архивариуса» — word matching and a template, labelled as such
// ---------------------------------------------------------------------------
export async function helper(db: Database, actor: OrgActor, id: string) {
  return withTx(db, orgTx(actor), async (c) => {
    const k = (
      await c.query<{ title: string; level: Level; card: CardT; created_at: Date; applications: number }>(
        `SELECT k.title, k.level, v.card, k.created_at, (SELECT count(*)::int FROM knowledge_applications a WHERE a.knowledge_id = k.id) AS applications
           FROM knowledge_items k JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version WHERE k.id = $1`,
        [id],
      )
    ).rows[0];
    if (!k) throw notFound('Знание не найдено или недоступно вам');
    const probe = `${k.title} ${k.card.problem ?? ''}`.slice(0, 500);
    const similar = (
      await c.query<{ id: string; title: string; level: Level; decision: string | null; score: number }>(
        `SELECT x.id, x.title, x.level, v.card->>'decision' AS decision,
                round(greatest(word_similarity($2, x.title), word_similarity($2, coalesce(v.card->>'problem', '')))::numeric, 2)::float AS score
           FROM knowledge_items x JOIN knowledge_versions v ON v.knowledge_id = x.id AND v.version = x.current_version
          WHERE x.id <> $1 AND x.organization_id = app_org_id()
            AND (word_similarity($2, x.title) > 0.3 OR word_similarity($2, coalesce(v.card->>'problem', '')) > 0.3)
          ORDER BY score DESC LIMIT 5`,
        [id, probe],
      )
    ).rows;
    const items = (
      await c.query<{ number: number; title: string; status: string; score: number }>(
        `SELECT o.number, o.title, o.status, round(greatest(word_similarity($2, o.title), word_similarity($2, o.problem))::numeric, 2)::float AS score
           FROM idea_overview o
          WHERE o.organization_id = app_org_id()
            AND NOT EXISTS (SELECT 1 FROM knowledge_sources s WHERE s.knowledge_id = $1 AND s.source_type = 'idea' AND s.source_id = o.id)
            AND NOT EXISTS (SELECT 1 FROM knowledge_applications a WHERE a.knowledge_id = $1 AND a.idea_id = o.id)
            AND (word_similarity($2, o.title) > 0.35 OR word_similarity($2, o.problem) > 0.4)
          ORDER BY score DESC LIMIT 5`,
        [id, probe],
      )
    ).rows;
    // «Possible contradiction»: a similar problem with a decision that shares few words. A hint to check, not a verdict.
    const contradictions = [];
    for (const s of similar) {
      if (!s.decision || !k.card.decision || s.score < 0.45) continue;
      const overlap = (await c.query<{ x: number }>('SELECT similarity($1, $2)::float AS x', [k.card.decision, s.decision])).rows[0]!.x;
      if (overlap < 0.2) contradictions.push({ id: s.id, title: s.title, level: s.level, note: 'похожая проблема, но решение сформулировано иначе — сверьте' });
    }
    return {
      mode: 'template',
      label: 'Помощник Архивариуса без ИИ: совпадение слов и шаблон. Это не смысловой анализ — выводы делает человек.',
      ai: { connected: false, note: 'AI-Архивариус не подключён: нет разрешённой интеграции с языковой моделью.' },
      similar: similar.map((s) => ({ id: s.id, title: s.title, hall: LEVEL_TITLE[s.level], score: s.score })),
      items: items.map((i) => ({ number: i.number, title: i.title, status: i.status, score: i.score, suggestion: 'возможная связь или повторное применение — проверьте' })),
      contradictions,
      note: templateNote({ title: k.title, level: k.level, card: k.card, createdAt: k.created_at.toISOString(), applications: k.applications }),
      noteLabel: 'Справка собрана по шаблону из полей карточки — не AI',
    };
  });
}

/**
 * A draft card from an item, for «Внести в Летопись». Only organization-visible item data:
 * the problem, the proposal, council arguments, the decision and the implementation report.
 * The person edits it; nothing is saved until they register it.
 */
export async function draftFromItem(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    const i = (
      await c.query<{ id: string; title: string; problem: string; proposal: string | null; author_membership_id: string; decision_owner_membership_id: string | null; implementer_membership_id: string | null }>(
        `SELECT o.id, o.title, o.problem, o.proposal, o.author_membership_id, o.decision_owner_membership_id, o.implementer_membership_id
           FROM idea_overview o WHERE o.organization_id = app_org_id() AND o.number = $1`,
        [number],
      )
    ).rows[0];
    if (!i) throw notFound(`Обращение №${number} не найдено`);
    const council = (await c.query<{ kind: string; recommendation: string | null; body: string }>('SELECT kind, recommendation, body FROM council_entries WHERE idea_id = $1 ORDER BY created_at', [i.id])).rows;
    const decision = (await c.query<{ outcome: string; rationale: string }>('SELECT outcome, rationale FROM decisions WHERE idea_id = $1 ORDER BY created_at DESC LIMIT 1', [i.id])).rows[0];
    const report = (await c.query<{ body: string }>(`SELECT body FROM reviews WHERE idea_id = $1 AND kind = 'progress' ORDER BY created_at DESC LIMIT 1`, [i.id])).rows[0];
    const effect = (await c.query<{ rationale: string }>('SELECT rationale FROM effect_approvals WHERE idea_id = $1', [i.id])).rows[0];
    const pro = council.filter((x) => x.kind === 'argument_for' || (x.kind === 'recommendation' && (x.recommendation === 'implement' || x.recommendation === 'pilot'))).map((x) => x.body);
    const con = council.filter((x) => x.kind === 'argument_against' || x.kind === 'dissent' || (x.kind === 'recommendation' && (x.recommendation === 'reject' || x.recommendation === 'rework'))).map((x) => x.body);
    const card: CardT = cleanCard({
      problem: i.problem,
      options: i.proposal ? `Предложено: ${i.proposal}` : undefined,
      argumentsFor: pro.join('\n') || undefined,
      argumentsAgainst: con.join('\n') || undefined,
      decision: decision ? `${decision.outcome === 'merge' ? 'Внедрять' : decision.outcome === 'reject' ? 'Не внедрять' : 'Закрыть'}. ${decision.rationale}` : undefined,
      reasons: decision?.rationale,
      initiator: i.author_membership_id,
      responsible: [i.decision_owner_membership_id, i.implementer_membership_id].filter((x): x is string => !!x),
      results: [report?.body, effect?.rationale].filter(Boolean).join('\n') || undefined,
    });
    return {
      kind: decision ? 'decision' : 'problem',
      title: i.title,
      card,
      sources: [{ type: 'idea', number }],
      note: 'Черновик собран из полей обращения. Проверьте и перескажите — ничего не сохранено, пока вы не внесёте запись.',
    };
  });
}

// ---------------------------------------------------------------------------
// The archivist role (admin only, audited in the database)
// ---------------------------------------------------------------------------
export const ArchivistInput = z.object({ grant: z.boolean() }).strict();
export async function setArchivist(db: Database, actor: OrgActor, membershipId: string, grant: boolean) {
  if (!has(actor, 'org_admin')) throw forbidden('Роль Архивариуса назначает администратор организации');
  return withTx(db, orgTx(actor), async (c) => {
    const { rows } = await db_(() => c.query<{ roles: string[] }>('SELECT app_set_archivist($1, $2) AS roles', [membershipId, grant]));
    return { roles: rows[0]!.roles };
  });
}
