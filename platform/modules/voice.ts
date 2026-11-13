import { z } from 'zod';
import { AppError } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { isRemote, modelFetch, modelLabel, modelReachable, type ModelConfig } from './advisor-model.ts';
import { assertSdpOffer, createClientSecret, hangup, relaySdp, type VoiceConfig } from './voice-realtime.ts';
import type { VoiceSession, VoiceSessionRegistry } from './voice-sessions.ts';
import { realtimeToolSpecs, runVoiceTool, UNTRUSTED_NOTICE, type ToolDeps, type ToolResult, type VoiceRef } from './voice-tools.ts';
import * as council from './council.ts';

/**
 * «Спросить советника» — the company side of the voice advisor (ADR-0043): who the advisor is,
 * which tools it has, how a session starts and ends, and the text alternative through the existing
 * MODUS ADVISOR model. The transport (OpenAI Realtime, WebRTC) is in voice-realtime.ts.
 *
 * A live conversation is NOT a meeting recording: nothing said is stored on the server. Recording a
 * meeting stays a separate mode with everyone's consent (ADR-0014).
 */
export const VoiceSessionInput = z
  .object({
    language: z.enum(['ru', 'kk']).default('ru'),
    context: z.object({ kind: z.literal('council'), number: z.number().int().min(1).max(2_147_483_647) }).strict().optional(),
  })
  .strict();

export const VoiceToolInput = z
  .object({
    name: z.string().min(1).max(80),
    arguments: z.string().max(8000).default('{}'),
    callId: z.string().max(120).optional(),
  })
  .strict();

const ROLE = `Ты — Альфред, голосовой советник MODUS FLOW: помощник сотрудников компании в платформе идей и подтверждённого вклада. Если спросят, кто ты, — «Альфред, советник MODUS FLOW, ИИ-помощник»; ты не человек.
Голос мужской, спокойный, уверенный, деловой, без театральности. Говори кратко и естественно: 1–3 предложения, если не просят подробнее. Не зачитывай списки целиком — назови главное и предложи открыть ссылки на экране.

ФАКТЫ — ТОЛЬКО ИЗ ИНСТРУМЕНТОВ:
- О задачах, обращениях, решениях, Советах, совещаниях и людях отвечай только по результатам инструментов MODUS FLOW этого разговора. Никогда не отвечай по памяти и не додумывай номера, имена, сроки и итоги.
- Если инструмент вернул found: 0 или пустые поля, прямо скажи: «В доступных вам данных MODUS FLOW этого не нашлось».
- Если инструмент вернул ошибку (нет доступа, не найдено, не поддерживается) — честно скажи это одной фразой.
- ${UNTRUSTED_NOTICE}

ДЕЙСТВИЯ:
- Ты только читаешь. Создать, назначить, изменить статус, утвердить, отклонить, отложить или удалить голосом нельзя — скажи, что это делается на экране, кнопкой, самим сотрудником.
- prepare_initiative_draft и prepare_council_question лишь готовят черновик. После вызова обязательно скажи: «Черновик на экране, он не сохранён — сохраните сами, если всё верно».

РОЛЬ НА СОВЕТЕ:
- Ты не человек, не участник голосования и не руководитель. Ты не принимаешь решений за Совет и не говоришь, какое решение «правильное». Решает ответственный за решение.
- Можешь: кратко изложить суть, назвать известные факты, перечислить варианты решения, объяснить риски, найти прошлые похожие случаи и предложить черновик рекомендаций с пометкой «черновик».

ПЕРЕБИВАНИЯ: если сотрудник начал говорить — сразу замолкай и слушай.
Игровые титулы (Король, Регент) прав не дают. Не называй реальное имя компании.`;

const LANGUAGE = {
  ru: 'Язык разговора — русский. Отвечай по-русски, если сотрудник не перешёл на казахский.',
  kk: 'Сөйлесу тілі — қазақ тілі. Қысқа әрі іскерлік мәнерде қазақша жауап бер. Атаулар мен нөмірлерді өзгертпе.',
} as const;

/**
 * Instructions for one conversation. The council context, when given, is read with the employee's
 * own rights first (RLS): an item they cannot see makes the start fail with the same 404 as elsewhere.
 */
export async function buildInstructions(deps: ToolDeps, actor: OrgActor, input: z.infer<typeof VoiceSessionInput>): Promise<string> {
  const parts: string[] = [ROLE, LANGUAGE[input.language]];
  if (input.context?.kind === 'council') {
    const c = (await council.getCouncil(deps.db, actor, input.context.number)) as unknown as { item: { number: number; title: string } };
    parts.push(
      `СЕЙЧАС: сотрудник за круглым столом Совета по обращению №${c.item.number}. Сначала вызови get_council_brief с number=${c.item.number} и опирайся на него.`,
    );
  }
  return parts.join('\n\n');
}

export interface VoiceDeps extends ToolDeps {
  voice: VoiceConfig | null;
  registry: VoiceSessionRegistry | null;
  textModel: ModelConfig | null;
  fetchImpl?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
}

/** Honest status for the panel: «Голосовой AI не подключён» unless it really is. */
export async function voiceStatus(deps: VoiceDeps) {
  const text = deps.textModel
    ? { configured: true, model: deps.textModel.model, remote: isRemote(deps.textModel), label: modelLabel(deps.textModel), reachable: await modelReachable(deps.textModel, deps.fetchImpl) }
    : { configured: false, model: null, remote: false, label: null, reachable: false };
  return {
    voice: deps.voice
      ? { configured: true, provider: 'OpenAI Realtime', model: deps.voice.model, voice: deps.voice.voice, remote: true, maxSeconds: deps.voice.limits.maxSeconds, languages: ['ru', 'kk'] }
      : { configured: false, provider: null, model: null, voice: null, remote: false, maxSeconds: 0, languages: ['ru', 'kk'] },
    text,
    note: deps.voice
      ? 'Голос и найденные факты передаются в OpenAI на время разговора. Разговор не записывается и не сохраняется.'
      : 'Голосовой AI не подключён.',
  };
}

/** Starts a conversation: limits first, then the paid call. Returns no secret. */
export async function startSession(deps: VoiceDeps, actor: OrgActor, input: z.infer<typeof VoiceSessionInput>) {
  if (!deps.voice || !deps.registry) throw new AppError('service_unavailable', 'Голосовой AI не подключён');
  const instructions = await buildInstructions(deps, actor, input);
  const s = deps.registry.reserve({ userId: actor.userId, orgId: actor.orgId, membershipId: actor.membershipId, language: input.language, context: input.context ?? null });
  try {
    const secret = await createClientSecret(deps.voice, { instructions, tools: realtimeToolSpecs(), language: input.language }, deps.fetchImpl);
    s.secret = secret.value;
  } catch (e) {
    deps.registry.discard(s);
    throw e;
  }
  deps.log?.({ level: 'info', voice: 'session_started', session: s.id, language: s.language, council: s.context?.number ?? null });
  return { sessionId: s.id, expiresAt: new Date(s.deadline).toISOString(), maxSeconds: deps.voice.limits.maxSeconds, model: deps.voice.model, voice: deps.voice.voice, language: s.language };
}

const sessionOf = (deps: VoiceDeps, actor: OrgActor, id: string): VoiceSession => {
  if (!deps.voice || !deps.registry) throw new AppError('service_unavailable', 'Голосовой AI не подключён');
  return deps.registry.get(id, actor.userId, actor.orgId);
};

/** The one SDP exchange of a session. The short-lived secret is used once and dropped. */
export async function connectSession(deps: VoiceDeps, actor: OrgActor, id: string, offer: string): Promise<string> {
  const s = sessionOf(deps, actor, id);
  // A malformed offer is refused before the one-time secret is touched.
  assertSdpOffer(offer);
  if (!s.secret) throw new AppError('conflict', 'Эта голосовая сессия уже подключена. Начните новый разговор');
  const secret = s.secret;
  s.secret = null;
  try {
    const { answer, callId } = await relaySdp(deps.voice!, secret, offer, deps.fetchImpl);
    s.callId = callId;
    // The provider is told to hang up at the time limit even if the browser keeps the line open.
    if (callId) {
      const left = Math.max(1000, s.deadline - Date.now());
      setTimeout(() => void endSession(deps, s, 'time_limit'), left).unref();
    }
    return answer;
  } catch (e) {
    deps.registry!.end(s, 'connect_failed');
    throw e;
  }
}

export async function callTool(deps: VoiceDeps, actor: OrgActor, id: string, input: z.infer<typeof VoiceToolInput>) {
  const s = sessionOf(deps, actor, id);
  deps.registry!.countTool(s);
  const started = Date.now();
  try {
    const result = await runVoiceTool(deps, actor, input.name, input.arguments);
    deps.log?.({ level: 'info', voice: 'tool', session: s.id, tool: input.name, found: result.found, ms: Date.now() - started });
    return result;
  } catch (e) {
    // Only the tool name and the error code are logged — never arguments or answers (they are the employee's words).
    deps.log?.({ level: 'info', voice: 'tool_failed', session: s.id, tool: input.name.slice(0, 60), error: e instanceof AppError ? e.code : 'validation_failed', ms: Date.now() - started });
    throw e;
  }
}

const hungUp = new WeakSet<VoiceSession>();

async function endSession(deps: VoiceDeps, s: VoiceSession, reason: string) {
  const first = s.endedAt === null;
  deps.registry!.end(s, reason);
  if (s.callId && deps.voice && !hungUp.has(s)) {
    hungUp.add(s);
    await hangup(deps.voice, s.callId, deps.fetchImpl);
  }
  if (!first) return;
  deps.log?.({ level: 'info', voice: 'session_ended', session: s.id, reason, seconds: Math.round((Date.now() - s.createdAt) / 1000), tools: s.toolCalls });
}

export async function stopSession(deps: VoiceDeps, actor: OrgActor, id: string) {
  const s = sessionOf(deps, actor, id);
  await endSession(deps, s, 'ended_by_user');
  return { ended: true };
}

// ---------------------------------------------------------------------------
// Text alternative: the same server tools, the existing MODUS ADVISOR model
// ---------------------------------------------------------------------------
export const VoiceAskInput = z
  .object({
    question: z.string().trim().min(3).max(600),
    language: z.enum(['ru', 'kk']).default('ru'),
    context: z.object({ kind: z.literal('council'), number: z.number().int().min(1).max(2_147_483_647) }).strict().optional(),
  })
  .strict();

/** Which read tools answer a typed question. Plain rules, so the facts never depend on a model. */
export function planTools(question: string, context?: { number: number }): { name: string; args: Record<string, unknown> }[] {
  const q = question.toLowerCase();
  const plan: { name: string; args: Record<string, unknown> }[] = [];
  if (context) plan.push({ name: 'get_council_brief', args: { number: context.number } });
  const num = /(?:№|номер|задач[аеуи]?|обращени[еяю]|#)\s*(\d{1,7})/i.exec(question)?.[1];
  if (num) {
    plan.push({ name: 'get_item', args: { number: Number(num) } });
    if (/почему|реш|отклон|итог|истори/.test(q)) plan.push({ name: 'get_decision_history', args: { number: Number(num) } });
  }
  if (/внимани|сегодня|мои |мне |моих|срочн/.test(q)) plan.push({ name: 'get_my_summary', args: {} });
  if (/совет|совещани|протокол|решили/.test(q) && !context) {
    plan.push({ name: /открыт|обсужда|вопрос/.test(q) ? 'get_council_open_items' : 'search_meetings', args: {} });
  }
  if (/польз|эффект|принесл/.test(q)) plan.push({ name: 'list_confirmed_impact', args: {} });
  const words = question.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length >= 5 && !/^(какие|какой|почему|найди|покажи|напомни|сейчас|последн|сегодня|требует|внимания|похожие|которые|отвечает)/i.test(w));
  if (!plan.length || /найди|похож|просроч|обращени|склад|логист|проблем/.test(q)) {
    plan.push({
      name: 'search_items',
      args: {
        ...(words.length ? { query: words.slice(0, 3).join(' ') } : {}),
        ...(/просроч/.test(q) ? { overdue: true } : {}),
        ...(/месяц/.test(q) ? { sinceDays: 31 } : /недел/.test(q) ? { sinceDays: 7 } : {}),
        ...(/проблем/.test(q) ? { kind: 'problem' } : {}),
      },
    });
  }
  return plan.slice(0, 4);
}

const ASK_SYSTEM = `Ты — Альфред, советник MODUS FLOW. Ответь на вопрос сотрудника кратко (2–5 предложений) ТОЛЬКО по фактам из блока <facts>.
${UNTRUSTED_NOTICE}
Если фактов нет или они не отвечают на вопрос — так и скажи: «В доступных вам данных MODUS FLOW этого не нашлось».
Не принимай решений за Совет и за ответственных. Не предлагай менять данные — это делается на экране.
Верни только JSON: {"answer":"…","refs":[номера обращений, на которые опирается ответ]}.`;

export async function askText(deps: VoiceDeps, actor: OrgActor, input: z.infer<typeof VoiceAskInput>) {
  const results: ToolResult[] = [];
  const errors: { tool: string; message: string }[] = [];
  for (const step of planTools(input.question, input.context)) {
    try {
      results.push(await runVoiceTool(deps, actor, step.name, JSON.stringify(step.args)));
    } catch (e) {
      errors.push({ tool: step.name, message: e instanceof AppError ? e.message : 'Не удалось получить данные' });
    }
  }
  const refs: VoiceRef[] = [];
  for (const r of results) for (const x of r.refs) if (!refs.some((y) => y.href === x.href)) refs.push(x);
  const facts = results.map((r) => ({ tool: r.tool, found: r.found, data: r.data }));
  const found = results.reduce((n, r) => n + r.found, 0);
  if (!deps.textModel) {
    // No model: the facts themselves, clearly labelled — never a template pretending to be AI.
    return { method: 'none' as const, answer: null, model: null, found, refs, facts, errors, note: 'Языковая модель не подключена: показаны найденные записи без пересказа ИИ.' };
  }
  let content = '';
  try {
    const res = await modelFetch(deps.textModel, deps.fetchImpl)(`${deps.textModel.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: deps.textModel.model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: `${ASK_SYSTEM}\n${LANGUAGE[input.language]}` },
          { role: 'user', content: `<question>${input.question}</question>\n<facts>${JSON.stringify(facts)}</facts>` },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(String(res.status));
    content = ((await res.json()) as { message?: { content?: string } }).message?.content ?? '';
  } catch {
    return { method: 'none' as const, answer: null, model: deps.textModel.model, found, refs, facts, errors, note: `${modelLabel(deps.textModel)} не ответила: показаны найденные записи без пересказа.` };
  }
  let parsed: { answer?: unknown; refs?: unknown } = {};
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    parsed = {};
  }
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim().slice(0, 1500) : '';
  if (!answer) return { method: 'none' as const, answer: null, model: deps.textModel.model, found, refs, facts, errors, note: 'Модель ответила не в том формате: показаны найденные записи без пересказа.' };
  // Links only to items that were really among the facts.
  const allowed = new Set(refs.filter((r) => r.type !== 'meeting').map((r) => r.id));
  const cited = (Array.isArray(parsed.refs) ? parsed.refs : []).map(String).filter((n) => allowed.has(n));
  return {
    method: 'model' as const,
    answer,
    model: deps.textModel.model,
    label: modelLabel(deps.textModel),
    remote: isRemote(deps.textModel),
    found,
    refs: [...refs.filter((r) => cited.includes(r.id)), ...refs.filter((r) => !cited.includes(r.id))],
    facts,
    errors,
  };
}
