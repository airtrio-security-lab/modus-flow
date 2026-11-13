import type { StreamLike, ToolCall, TransportEvents, VoiceErrorCode, VoiceState } from './realtimeTransport.ts';

/**
 * WebSocket transport for an ElevenLabs conversational agent (ADR-0043) — the second speech provider,
 * used for the owner's own voice. Generic like realtimeTransport.ts: it knows the microphone, the socket,
 * PCM audio and the ElevenLabs event names — nothing about MODUS FLOW. The company layer passes in:
 *   - open() → { url, initiation }: the signed URL of one conversation and its first message (our server);
 *   - onToolCall(call) → output: what to do with a «client tool» call (our server executes it).
 * Same surface and the same states as the OpenAI transport, so the panel does not care which one runs.
 * No simulation mode; a tool without a handler or a failing one answers with an error.
 *
 * Kept free of DOM types: the browser audio lives in elevenAudio.ts; tests inject fakes.
 */
export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ElevenAudio {
  /** Starts sending the microphone as base64 PCM16 mono chunks at `rate` Hz. */
  capture(stream: StreamLike, rate: number, onChunk: (base64: string) => void): void;
  /** Queues base64 PCM16 mono audio at `rate` Hz for playback, in order. */
  play(base64: string, rate: number): void;
  /** Drops everything queued and playing (barge-in). */
  flush(): void;
  /** Called when the playback queue has drained. */
  onIdle: (() => void) | null;
  close(): void;
}

export interface ElevenEnv {
  getUserMedia?: (c: { audio: Record<string, boolean> }) => Promise<StreamLike>;
  openSocket: (url: string) => SocketLike;
  createAudio: () => ElevenAudio;
}

const micError = (e: unknown): [VoiceErrorCode, string] => {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return ['mic_denied', 'Доступ к микрофону запрещён. Разрешите микрофон для этого сайта в настройках браузера или спросите текстом.'];
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return ['no_mic', 'Микрофон не найден. Подключите микрофон или спросите текстом.'];
  return ['mic_failed', 'Не удалось включить микрофон. Возможно, его занимает другое приложение.'];
};

const rateOf = (format: unknown, fallback: number): number => {
  const m = /^pcm_(\d{4,5})$/.exec(typeof format === 'string' ? format : '');
  return m ? Number(m[1]) : fallback;
};

/** The words that ask the agent to open the conversation; never shown as something the employee said. */
export const OPENING_CUE = 'Начни разговор.';

export function createElevenTransport(opts: { open: () => Promise<{ url: string; initiation: Record<string, unknown> }>; events: TransportEvents; env: ElevenEnv }) {
  const ev = opts.events;
  const env = opts.env;
  let state: VoiceState = 'idle';
  let stream: StreamLike | null = null;
  let ws: SocketLike | null = null;
  let audio: ElevenAudio | null = null;
  let muted = false;
  let stopped = false;
  let ready = false;
  let outRate = 16000;
  /** After «Перебить» the rest of the current answer is not played; the next turn clears it. */
  let dropAudio = false;
  const hidden = new Set<string>();

  const set = (s: VoiceState) => {
    if (state === s) return;
    state = s;
    ev.onState(s);
  };
  const send = (msg: Record<string, unknown>) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  function teardown(reason: string) {
    if (stopped) return;
    stopped = true;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    try {
      audio?.close();
    } catch {
      /* already closed */
    }
    for (const t of stream?.getTracks() ?? []) t.stop();
    ws = null;
    audio = null;
    stream = null;
    ev.onClosed?.(reason);
  }
  const fail = (code: VoiceErrorCode, message: string) => {
    if (stopped) return;
    ev.onError(code, message);
    teardown(code);
    set('error');
  };

  async function handleTool(call: ToolCall) {
    set('thinking');
    let output: unknown;
    let isError = false;
    if (!ev.onToolCall) {
      output = { error: true, code: 'unsupported_tool', message: 'Инструменты не подключены' };
      isError = true;
    } else {
      try {
        output = await ev.onToolCall(call);
        isError = !!(output && typeof output === 'object' && (output as { error?: unknown }).error === true);
      } catch (e) {
        output = { error: true, code: (e as { code?: string })?.code ?? 'tool_failed', message: (e as Error)?.message ?? 'Инструмент не выполнен' };
        isError = true;
      }
    }
    if (stopped) return;
    send({ type: 'client_tool_result', tool_call_id: call.callId, result: JSON.stringify(output), is_error: isError });
  }

  function onEvent(raw: unknown) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const part = <T>(key: string) => (msg[key] ?? {}) as T;
    switch (msg.type) {
      case 'conversation_initiation_metadata': {
        const meta = part<{ agent_output_audio_format?: string; user_input_audio_format?: string }>('conversation_initiation_metadata_event');
        outRate = rateOf(meta.agent_output_audio_format, 16000);
        const inRate = rateOf(meta.user_input_audio_format, 16000);
        if (stream && audio) audio.capture(stream, inRate, (b64) => (muted || stopped ? undefined : send({ user_audio_chunk: b64 })));
        ready = true;
        set('listening');
        ev.onReady?.();
        break;
      }
      case 'ping': {
        const p = part<{ event_id?: number }>('ping_event');
        send({ type: 'pong', event_id: p.event_id });
        break;
      }
      case 'vad_score': {
        const v = Number(part<{ vad_score?: number }>('vad_score_event').vad_score ?? 0);
        if (v > 0.6 && state === 'listening') set('user_speaking');
        else if (v < 0.25 && state === 'user_speaking') set('listening');
        break;
      }
      case 'user_transcript': {
        const t = String(part<{ user_transcript?: string }>('user_transcription_event').user_transcript ?? '').trim();
        dropAudio = false;
        if (t && !hidden.has(t)) ev.onUserText?.(t);
        if (state !== 'speaking') set('thinking');
        break;
      }
      case 'agent_response': {
        // Bracketed audio tags («[Calm]») steer the voice; they are not part of what is said.
        const t = String(part<{ agent_response?: string }>('agent_response_event').agent_response ?? '')
          .replace(/\[[^\]\n]{1,30}\]\s*/g, '')
          .trim();
        if (t) ev.onAssistantText?.(t, true);
        break;
      }
      case 'audio': {
        const a = part<{ audio_base_64?: string }>('audio_event');
        if (dropAudio || !a.audio_base_64 || !audio) break;
        audio.play(a.audio_base_64, outRate);
        set('speaking');
        break;
      }
      case 'interruption':
        // The employee spoke over the answer: the provider cut it; drop what is still queued here.
        audio?.flush();
        set('user_speaking');
        break;
      case 'client_tool_call': {
        const c = part<{ tool_name?: string; tool_call_id?: string; parameters?: unknown }>('client_tool_call');
        void handleTool({ name: String(c.tool_name ?? ''), callId: String(c.tool_call_id ?? ''), arguments: JSON.stringify(c.parameters ?? {}) });
        break;
      }
    }
  }

  return {
    state: () => state,
    isMuted: () => muted,
    localStream: (): StreamLike | null => stream,

    async start(): Promise<void> {
      if (state !== 'idle') throw new Error('Транспорт уже запускался: создайте новый');
      if (!env.getUserMedia) return fail('insecure', 'Микрофон доступен только по защищённому адресу (https или localhost). Спросите текстом.');
      set('requesting_mic');
      try {
        stream = await env.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        const [code, text] = micError(e);
        return fail(code, text);
      }
      if (stopped) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      set('connecting');
      let conn: { url: string; initiation: Record<string, unknown> };
      try {
        conn = await opts.open();
      } catch (e) {
        return fail('connect_failed', (e as Error)?.message || 'Не удалось подключиться к голосовому сервису');
      }
      if (stopped) return;
      try {
        audio = env.createAudio();
        audio.onIdle = () => {
          if (!stopped && state === 'speaking') set('listening');
        };
        ws = env.openSocket(conn.url);
      } catch (e) {
        return fail('connect_failed', (e as Error)?.message || 'Не удалось подключиться к голосовому сервису');
      }
      ws.onopen = () => send(conn.initiation);
      ws.onmessage = (e) => onEvent(e.data);
      ws.onerror = () => undefined;
      ws.onclose = (e) => {
        if (stopped) return;
        // Before the conversation starts a close is a refused connection; after it — a lost one.
        const why = e?.reason ? ` (${String(e.reason).slice(0, 160)})` : '';
        if (!ready) fail('connect_failed', `Голосовой сервис не принял подключение${why}`);
        else fail('connection_lost', 'Связь с голосовым сервисом прервалась. Нажмите «Переподключить».');
      };
    },

    /** A typed question in the same live conversation: answered by voice like a spoken one. */
    sendText(text: string): boolean {
      const t = text.trim();
      if (stopped || !ready || !t) return false;
      audio?.flush();
      dropAudio = false;
      send({ type: 'user_message', text: t });
      set('thinking');
      return true;
    },

    /** Asks the agent to speak first. The cue is not shown as something the employee said. */
    speakFirst(cue: string = OPENING_CUE): boolean {
      if (stopped || !ready) return false;
      hidden.add(cue);
      send({ type: 'user_message', text: cue });
      set('thinking');
      return true;
    },

    setMuted(value: boolean): boolean {
      muted = value;
      for (const t of stream?.getAudioTracks() ?? []) t.enabled = !value;
      return muted;
    },

    /** «Перебить»: the rest of the current answer is not played. */
    interrupt(): void {
      if (stopped) return;
      dropAudio = true;
      audio?.flush();
      send({ type: 'user_activity' });
      if (state === 'speaking' || state === 'thinking') set('listening');
    },

    stop(reason = 'ended'): void {
      if (stopped) return;
      teardown(reason);
      set('ended');
    },
  };
}

export type ElevenTransport = ReturnType<typeof createElevenTransport>;
