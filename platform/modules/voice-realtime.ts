import { AppError } from '../domain/errors.ts';

/**
 * Speech-to-speech provider for the live voice advisor (ADR-0043).
 *
 * This file is the generic transport layer only: it knows how to ask OpenAI Realtime for a
 * short-lived client secret and how to relay one WebRTC SDP offer with it. It knows nothing
 * about the company, its data or its tools — those live in voice.ts and voice-tools.ts.
 *
 * Off by default. Like the cloud text model (ADR-0028) it starts only behind explicit switches,
 * because the employee's voice and the facts the tools return leave the company and it is paid:
 *
 *   MODUS_VOICE_PROVIDER=openai                 none (default) | openai
 *   OPENAI_API_KEY=…  (or MODUS_VOICE_API_KEY)  server only: never logged, never sent to the browser
 *   MODUS_VOICE_ALLOW_REMOTE=true               consent: voice and facts go to OpenAI, paid
 *   MODUS_VOICE_ALLOW_REAL_DATA=true            second consent, required outside the demo sign-in
 *   MODUS_VOICE_MODEL=gpt-realtime              optional
 *   MODUS_VOICE_VOICE=cedar                     optional: a stock synthetic voice, not a real person's
 *   MODUS_VOICE_MAX_SECONDS=600                 one conversation at most (default 10 minutes)
 *   MODUS_VOICE_SESSIONS_PER_HOUR=12            per user
 *   MODUS_VOICE_MAX_PER_USER=1                  concurrent per user
 *   MODUS_VOICE_MAX_PER_ORG=5                   concurrent per organization
 */
export interface VoiceLimits {
  maxSeconds: number;
  sessionsPerHour: number;
  maxPerUser: number;
  maxPerOrg: number;
  /** Tool calls one conversation may make (a runaway model cannot read the whole database). */
  toolCallsPerSession: number;
}

export interface VoiceConfig {
  provider: 'openai' | 'elevenlabs';
  url: string;
  model: string;
  voice: string;
  /** Never logged, never returned by the API, never sent to the browser. */
  apiKey: string;
  limits: VoiceLimits;
  /** ElevenLabs only: the private agent that holds the voice and the tool list. Not a secret. */
  agentId?: string;
  /** ElevenLabs only: the one WebSocket origin the page may connect to (added to the page's connect-src). */
  wsOrigin?: string;
}

export const DEFAULT_LIMITS: VoiceLimits = { maxSeconds: 600, sessionsPerHour: 12, maxPerUser: 1, maxPerOrg: 5, toolCallsPerSession: 60 };

const intEnv = (v: string | undefined, def: number, min: number, max: number, name: string) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} должен быть целым числом от ${min} до ${max}`);
  return n;
};

export function voiceConfigFromEnv(env: NodeJS.ProcessEnv): VoiceConfig | null {
  const provider = env.MODUS_VOICE_PROVIDER ?? 'none';
  if (provider === 'none') return null;
  if (provider === 'elevenlabs') return elevenLabsConfigFromEnv(env);
  if (provider !== 'openai') throw new Error('MODUS_VOICE_PROVIDER: поддерживаются "none", "openai" (OpenAI Realtime) и "elevenlabs" (ElevenLabs Agents)');
  if (env.MODUS_VOICE_ALLOW_REMOTE !== 'true') {
    throw new Error('MODUS_VOICE_PROVIDER=openai: голос сотрудника и найденные факты будут уходить в OpenAI, и это платно. Нужен явный MODUS_VOICE_ALLOW_REMOTE=true');
  }
  if (env.MODUS_DEMO_LOGIN !== 'true' && env.MODUS_VOICE_ALLOW_REAL_DATA !== 'true') {
    throw new Error('MODUS_VOICE_PROVIDER=openai вне демо: в OpenAI ушли бы голос и реальные данные сотрудников. Нужно отдельное решение владельца — MODUS_VOICE_ALLOW_REAL_DATA=true');
  }
  const apiKey = (env.MODUS_VOICE_API_KEY ?? env.OPENAI_API_KEY)?.trim();
  if (!apiKey) throw new Error('MODUS_VOICE_PROVIDER=openai: не задан ключ (OPENAI_API_KEY)');
  const url = (env.MODUS_VOICE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!url.startsWith('https://')) throw new Error('MODUS_VOICE_URL должен начинаться с https://');
  const voice = (env.MODUS_VOICE_VOICE ?? 'cedar').trim();
  if (!/^[a-z0-9_-]{2,40}$/.test(voice)) throw new Error('MODUS_VOICE_VOICE: имя стандартного голоса провайдера');
  return {
    provider: 'openai',
    url,
    model: (env.MODUS_VOICE_MODEL ?? 'gpt-realtime').trim(),
    voice,
    apiKey,
    limits: limitsFromEnv(env),
  };
}

const limitsFromEnv = (env: NodeJS.ProcessEnv): VoiceLimits => ({
  maxSeconds: intEnv(env.MODUS_VOICE_MAX_SECONDS, DEFAULT_LIMITS.maxSeconds, 30, 3600, 'MODUS_VOICE_MAX_SECONDS'),
  sessionsPerHour: intEnv(env.MODUS_VOICE_SESSIONS_PER_HOUR, DEFAULT_LIMITS.sessionsPerHour, 1, 200, 'MODUS_VOICE_SESSIONS_PER_HOUR'),
  maxPerUser: intEnv(env.MODUS_VOICE_MAX_PER_USER, DEFAULT_LIMITS.maxPerUser, 1, 5, 'MODUS_VOICE_MAX_PER_USER'),
  maxPerOrg: intEnv(env.MODUS_VOICE_MAX_PER_ORG, DEFAULT_LIMITS.maxPerOrg, 1, 200, 'MODUS_VOICE_MAX_PER_ORG'),
  toolCallsPerSession: DEFAULT_LIMITS.toolCallsPerSession,
});

/**
 * ElevenLabs Agents (ADR-0043): the owner's own voice. Same switches as OpenAI, plus the agent:
 *
 *   MODUS_VOICE_PROVIDER=elevenlabs
 *   ELEVENLABS_API_KEY=…  (or MODUS_VOICE_API_KEY)   server only
 *   MODUS_VOICE_AGENT_ID=agent_…                     the private agent (voice, tools, model)
 *   MODUS_VOICE_ALLOW_REMOTE=true  (+ MODUS_VOICE_ALLOW_REAL_DATA=true outside the demo)
 *   MODUS_VOICE_VOICE=Альфред                         optional: the name shown in the panel
 *   MODUS_VOICE_WS_ORIGIN=wss://api.elevenlabs.io     optional: another region of the same service
 */
function elevenLabsConfigFromEnv(env: NodeJS.ProcessEnv): VoiceConfig {
  if (env.MODUS_VOICE_ALLOW_REMOTE !== 'true') {
    throw new Error('MODUS_VOICE_PROVIDER=elevenlabs: голос сотрудника и найденные факты будут уходить в ElevenLabs и в языковую модель агента, и это платно. Нужен явный MODUS_VOICE_ALLOW_REMOTE=true');
  }
  if (env.MODUS_DEMO_LOGIN !== 'true' && env.MODUS_VOICE_ALLOW_REAL_DATA !== 'true') {
    throw new Error('MODUS_VOICE_PROVIDER=elevenlabs вне демо: в ElevenLabs ушли бы голос и реальные данные сотрудников. Нужно отдельное решение владельца — MODUS_VOICE_ALLOW_REAL_DATA=true');
  }
  const apiKey = (env.MODUS_VOICE_API_KEY ?? env.ELEVENLABS_API_KEY)?.trim();
  if (!apiKey) throw new Error('MODUS_VOICE_PROVIDER=elevenlabs: не задан ключ (ELEVENLABS_API_KEY)');
  const agentId = env.MODUS_VOICE_AGENT_ID?.trim();
  if (!agentId || !/^agent_[A-Za-z0-9]{6,60}$/.test(agentId)) throw new Error('MODUS_VOICE_PROVIDER=elevenlabs: нужен MODUS_VOICE_AGENT_ID=agent_… (агент «Альфред» в ElevenLabs)');
  const url = (env.MODUS_VOICE_URL ?? 'https://api.elevenlabs.io/v1').replace(/\/+$/, '');
  if (!url.startsWith('https://')) throw new Error('MODUS_VOICE_URL должен начинаться с https://');
  const wsOrigin = (env.MODUS_VOICE_WS_ORIGIN ?? `wss://${new URL(url).host}`).replace(/\/+$/, '');
  if (!/^wss:\/\/[a-z0-9.-]+(:\d+)?$/.test(wsOrigin)) throw new Error('MODUS_VOICE_WS_ORIGIN: ожидается адрес вида wss://api.elevenlabs.io');
  const voice = (env.MODUS_VOICE_VOICE ?? 'Альфред').trim().slice(0, 40);
  return { provider: 'elevenlabs', url, model: 'ElevenLabs Agents', voice, apiKey, agentId, wsOrigin, limits: limitsFromEnv(env) };
}

/**
 * Asks ElevenLabs for a signed WebSocket URL of ONE conversation with the private agent. Asked with
 * `include_conversation_id`: the signature then works once, and the server learns the conversation id
 * here — not from the browser. The URL is a short-lived session secret; the API key stays here.
 */
export async function createSignedUrl(cfg: VoiceConfig, fetchImpl: typeof fetch = fetch): Promise<{ url: string; conversationId: string | null }> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(cfg.agentId ?? '')}&include_conversation_id=true`, {
      headers: { 'xi-api-key': cfg.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError('service_unavailable', 'Голосовой сервис ElevenLabs не отвечает. Попробуйте позже или задайте вопрос текстом');
  }
  if (!res.ok) {
    const why = res.status === 401 ? ': ключ не принят' : res.status === 404 ? ': агент не найден' : res.status === 429 ? ': превышен лимит провайдера' : '';
    throw new AppError('service_unavailable', `Голосовой сервис ElevenLabs вернул ошибку ${res.status}${why}`);
  }
  const url = ((await res.json().catch(() => ({}))) as { signed_url?: unknown }).signed_url;
  // The page may connect only to the configured origin (its connect-src); anything else is refused here.
  if (typeof url !== 'string' || !url.startsWith(`${cfg.wsOrigin}/`)) {
    throw new AppError('service_unavailable', 'Голосовой сервис ElevenLabs вернул адрес другого узла. Задайте его в MODUS_VOICE_WS_ORIGIN');
  }
  const id = new URL(url.replace(/^wss:/, 'https:')).searchParams.get('conversation_id');
  // Without the id the signature could be used again and the record could not be bound to this session.
  if (!id || !CONVERSATION_ID.test(id)) throw new AppError('service_unavailable', 'Голосовой сервис ElevenLabs не выдал одноразовый адрес разговора');
  return { url, conversationId: id };
}

const CONVERSATION_ID = /^conv_[A-Za-z0-9]{8,60}$/;

/**
 * Removes the record of one finished conversation at ElevenLabs (transcript, summary, audio): a live
 * conversation must not become a stored one. The id is the one the server itself received with the signed
 * URL of this session (never one named by the browser); the agent is checked as well.
 */
export async function deleteConversation(cfg: VoiceConfig, conversationId: string, fetchImpl: typeof fetch = fetch): Promise<'deleted' | 'not_ours' | 'failed'> {
  if (!CONVERSATION_ID.test(conversationId)) return 'not_ours';
  const url = `${cfg.url}/convai/conversations/${conversationId}`;
  const headers = { 'xi-api-key': cfg.apiKey };
  try {
    const seen = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!seen.ok) return seen.status === 404 ? 'not_ours' : 'failed';
    const body = (await seen.json().catch(() => ({}))) as { agent_id?: string; status?: string };
    if (body.agent_id !== cfg.agentId) return 'not_ours';
    // Still being processed: deleting now would leave what is written afterwards.
    if (body.status && body.status !== 'done' && body.status !== 'failed') return 'failed';
    const gone = await fetchImpl(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) });
    return gone.ok ? 'deleted' : 'failed';
  } catch {
    return 'failed';
  }
}

/** What the conversation is configured with. Built by the company layer (voice.ts). */
export interface RealtimeSessionSpec {
  instructions: string;
  tools: { type: 'function'; name: string; description: string; parameters: Record<string, unknown> }[];
  /** ISO 639-1 language of the employee's speech: helps the transcription of what was said. */
  language: 'ru' | 'kk';
}

export interface ClientSecret {
  value: string;
  expiresAt: number;
}

/** Turns a provider failure into an honest error. The provider's message is not echoed (it may contain configuration). */
function providerError(status: number): AppError {
  const why = status === 401 ? ': ключ не принят' : status === 403 ? ': нет доступа к Realtime' : status === 429 ? ': превышен лимит провайдера' : status === 404 ? ': модель не найдена' : '';
  return new AppError('service_unavailable', `Голосовой сервис OpenAI вернул ошибку ${status}${why}`);
}

/**
 * Asks OpenAI for a short-lived client secret (GA endpoint POST /realtime/client_secrets) bound to
 * this session configuration: instructions, tools, voice, server VAD with barge-in. The secret
 * lives a short time and is used once by the server to relay the SDP offer.
 */
export async function createClientSecret(cfg: VoiceConfig, spec: RealtimeSessionSpec, fetchImpl: typeof fetch = fetch): Promise<ClientSecret> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/realtime/client_secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 120 },
        session: {
          type: 'realtime',
          model: cfg.model,
          instructions: spec.instructions,
          tools: spec.tools,
          tool_choice: 'auto',
          max_output_tokens: 1200,
          audio: {
            input: {
              noise_reduction: { type: 'near_field' },
              transcription: { model: 'gpt-4o-mini-transcribe', language: spec.language },
              // The server decides when the employee has finished; speaking over the answer cancels it.
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 650, create_response: true, interrupt_response: true },
            },
            output: { voice: cfg.voice },
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError('service_unavailable', 'Голосовой сервис OpenAI не отвечает. Попробуйте позже или задайте вопрос текстом');
  }
  if (!res.ok) throw providerError(res.status);
  const body = (await res.json().catch(() => ({}))) as { value?: string; expires_at?: number; client_secret?: { value?: string; expires_at?: number } };
  const value = body.value ?? body.client_secret?.value;
  const expiresAt = body.expires_at ?? body.client_secret?.expires_at;
  if (!value || typeof value !== 'string') throw new AppError('service_unavailable', 'Голосовой сервис OpenAI ответил без сессионного ключа');
  return { value, expiresAt: typeof expiresAt === 'number' ? expiresAt * 1000 : Date.now() + 60_000 };
}

const MAX_SDP = 64 * 1024;

/** A WebRTC offer is plain text with known first lines; anything else is refused before it leaves the server. */
export function assertSdpOffer(sdp: string): void {
  if (!sdp || sdp.length > MAX_SDP || !sdp.startsWith('v=0') || !/\r?\nm=audio /.test(sdp)) {
    throw new AppError('validation_failed', 'Ожидается SDP-предложение WebRTC с аудио');
  }
}

/**
 * Relays the browser's SDP offer to OpenAI (POST /realtime/calls) with the short-lived secret and
 * returns the answer. Media then flows directly between the browser and OpenAI; the secret never
 * reaches the browser at all, so the page keeps its `connect-src 'self'` policy.
 */
export async function relaySdp(cfg: VoiceConfig, secret: string, offer: string, fetchImpl: typeof fetch = fetch): Promise<{ answer: string; callId: string | null }> {
  assertSdpOffer(offer);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/realtime/calls`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/sdp' },
      body: offer,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError('service_unavailable', 'Голосовой сервис OpenAI не ответил на подключение');
  }
  if (!res.ok) throw providerError(res.status);
  const answer = await res.text();
  if (!answer.startsWith('v=0')) throw new AppError('service_unavailable', 'Голосовой сервис OpenAI вернул неожиданный ответ на подключение');
  const location = res.headers.get('location') ?? '';
  const callId = /\/realtime\/calls\/([A-Za-z0-9_-]{4,100})/.exec(location)?.[1] ?? null;
  return { answer, callId };
}

/** Ends a call on the provider side (the duration limit, or the employee closed the panel). Best effort. */
export async function hangup(cfg: VoiceConfig, callId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${cfg.url}/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
