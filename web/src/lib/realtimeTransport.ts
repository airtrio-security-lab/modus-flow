/**
 * WebRTC transport for a speech-to-speech model (ADR-0042). Generic on purpose: it knows the
 * microphone, the peer connection, the remote audio and the Realtime event names — nothing about
 * MODUS FLOW, its server, its data or its tools. The company layer passes in:
 *   - negotiate(offer) → answer: how the SDP offer reaches the provider (our server relays it);
 *   - onToolCall(call) → output: what to do with a function call (our server executes it).
 *
 * Adapted from the browser client of Pavlodar Pulse (IVAN CALL LIVE) with these differences:
 *   - no simulation mode: without a real connection the state is «error», never a fake voice;
 *   - a tool call without a handler, or a failing one, answers the model with an error —
 *     never `{ success: true }`;
 *   - current GA event names (response.output_audio_transcript.*) and the beta ones;
 *   - barge-in: the server VAD cancels the answer when the employee speaks; interrupt() does it by hand;
 *   - stop() is idempotent and always stops every microphone track and drops the remote audio.
 *
 * Kept free of imports and DOM types so the same file runs in the browser and in node tests.
 */
export type VoiceState = 'idle' | 'requesting_mic' | 'connecting' | 'listening' | 'user_speaking' | 'thinking' | 'speaking' | 'ended' | 'error';

export type VoiceErrorCode = 'insecure' | 'no_mic' | 'mic_denied' | 'mic_failed' | 'connect_failed' | 'connection_lost' | 'provider';

export interface ToolCall {
  name: string;
  callId: string;
  arguments: string;
}

export interface TransportEvents {
  onState: (state: VoiceState) => void;
  onUserText?: (text: string) => void;
  /** Assistant speech as text: deltas while speaking (final=false), the whole answer at the end. */
  onAssistantText?: (text: string, final: boolean) => void;
  onToolCall?: (call: ToolCall) => Promise<unknown>;
  onError: (code: VoiceErrorCode, message: string) => void;
  onClosed?: (reason: string) => void;
}

// Minimal structural types of the browser objects used (no DOM lib needed).
export interface TrackLike {
  enabled: boolean;
  readonly readyState?: string;
  stop(): void;
}
export interface StreamLike {
  getTracks(): TrackLike[];
  getAudioTracks(): TrackLike[];
}
export interface ChannelLike {
  readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}
export interface PeerLike {
  connectionState?: string;
  ontrack: ((e: { streams: readonly unknown[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  addTrack(track: TrackLike, stream: StreamLike): unknown;
  createDataChannel(label: string): ChannelLike;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(d: { type?: string; sdp?: string }): Promise<void>;
  setRemoteDescription(d: { type: 'answer'; sdp: string }): Promise<void>;
  close(): void;
}
export interface AudioLike {
  srcObject: unknown;
  remove?: () => void;
  play?: () => Promise<void>;
}
export interface TransportEnv {
  /** Undefined when the page is not a secure context (http on a phone): the microphone is unavailable. */
  getUserMedia?: (c: { audio: Record<string, boolean> }) => Promise<StreamLike>;
  createPeer: () => PeerLike;
  createAudio: () => AudioLike;
}

/** The real browser. Created lazily so importing this file in node is harmless. */
export function browserEnv(): TransportEnv {
  const g = globalThis as unknown as {
    navigator?: { mediaDevices?: { getUserMedia?: (c: unknown) => Promise<StreamLike> } };
    RTCPeerConnection: new () => PeerLike;
    document: { createElement: (t: string) => AudioLike & { autoplay: boolean; setAttribute: (k: string, v: string) => void; style: Record<string, string> }; body: { appendChild: (n: unknown) => void } };
  };
  const md = g.navigator?.mediaDevices;
  return {
    getUserMedia: md?.getUserMedia ? (c) => md.getUserMedia!.call(md, c) : undefined,
    createPeer: () => new g.RTCPeerConnection(),
    createAudio: () => {
      const a = g.document.createElement('audio');
      a.autoplay = true;
      // iOS Safari plays the answer inline only with playsinline and an element in the document.
      a.setAttribute('playsinline', '');
      a.style.display = 'none';
      g.document.body.appendChild(a);
      return a;
    },
  };
}

const micError = (e: unknown): [VoiceErrorCode, string] => {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return ['mic_denied', 'Доступ к микрофону запрещён. Разрешите микрофон для этого сайта в настройках браузера или спросите текстом.'];
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return ['no_mic', 'Микрофон не найден. Подключите микрофон или спросите текстом.'];
  return ['mic_failed', 'Не удалось включить микрофон. Возможно, его занимает другое приложение.'];
};

export function createRealtimeTransport(opts: { negotiate: (offerSdp: string) => Promise<string>; events: TransportEvents; env?: TransportEnv }) {
  const ev = opts.events;
  let env: TransportEnv | null = opts.env ?? null;
  let state: VoiceState = 'idle';
  let stream: StreamLike | null = null;
  let pc: PeerLike | null = null;
  let dc: ChannelLike | null = null;
  let audio: AudioLike | null = null;
  let muted = false;
  let stopped = false;
  let answerText = '';
  /** Whether the current response produced audio (a pure tool-call response does not). */
  let audioInResponse = false;

  const set = (s: VoiceState) => {
    if (state === s) return;
    state = s;
    ev.onState(s);
  };
  const send = (msg: Record<string, unknown>) => {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg));
  };
  const fail = (code: VoiceErrorCode, message: string) => {
    if (stopped) return;
    ev.onError(code, message);
    teardown(code);
    set('error');
  };

  function teardown(reason: string) {
    if (stopped) return;
    stopped = true;
    try {
      dc?.close();
    } catch {
      /* already closed */
    }
    try {
      pc?.close();
    } catch {
      /* already closed */
    }
    for (const t of stream?.getTracks() ?? []) t.stop();
    if (audio) {
      audio.srcObject = null;
      audio.remove?.();
    }
    dc = null;
    pc = null;
    stream = null;
    audio = null;
    ev.onClosed?.(reason);
  }

  async function handleTool(msg: Record<string, unknown>) {
    const call: ToolCall = { name: String(msg.name ?? ''), callId: String(msg.call_id ?? ''), arguments: typeof msg.arguments === 'string' ? msg.arguments : '{}' };
    set('thinking');
    let output: unknown;
    if (!ev.onToolCall) output = { error: true, code: 'unsupported_tool', message: 'Инструменты не подключены' };
    else {
      try {
        output = await ev.onToolCall(call);
      } catch (e) {
        output = { error: true, code: (e as { code?: string })?.code ?? 'tool_failed', message: (e as Error)?.message ?? 'Инструмент не выполнен' };
      }
    }
    if (stopped) return;
    send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output) } });
    send({ type: 'response.create' });
  }

  function onEvent(raw: unknown) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'session.created':
      case 'session.updated':
        if (state === 'connecting') set('listening');
        break;
      case 'input_audio_buffer.speech_started':
        // Barge-in: the server cancels the answer itself (interrupt_response); the UI follows.
        set('user_speaking');
        break;
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
        set('thinking');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof msg.transcript === 'string' && msg.transcript.trim()) ev.onUserText?.(msg.transcript.trim());
        break;
      case 'response.created':
        answerText = '';
        audioInResponse = false;
        if (state !== 'user_speaking') set('thinking');
        break;
      case 'output_audio_buffer.started':
        audioInResponse = true;
        set('speaking');
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        audioInResponse = true;
        answerText += typeof msg.delta === 'string' ? msg.delta : '';
        ev.onAssistantText?.(answerText, false);
        if (state !== 'user_speaking') set('speaking');
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const t = typeof msg.transcript === 'string' ? msg.transcript : answerText;
        if (t.trim()) ev.onAssistantText?.(t.trim(), true);
        break;
      }
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (state === 'speaking') set('listening');
        break;
      case 'response.done':
        if (!audioInResponse && state === 'thinking') set('listening');
        break;
      case 'response.function_call_arguments.done':
        void handleTool(msg);
        break;
      case 'error': {
        const err = (msg.error ?? {}) as { code?: string; message?: string };
        // Cancelling when nothing is playing is not a failure.
        if (err.code === 'response_cancel_not_active') break;
        ev.onError('provider', err.message ? `Голосовой сервис: ${err.message}` : 'Ошибка голосового сервиса');
        break;
      }
    }
  }

  return {
    state: () => state,
    isMuted: () => muted,

    async start(): Promise<void> {
      if (state !== 'idle') throw new Error('Транспорт уже запускался: создайте новый');
      env ??= browserEnv();
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
      try {
        pc = env.createPeer();
        audio = env.createAudio();
        pc.ontrack = (e) => {
          if (audio) {
            audio.srcObject = e.streams[0] ?? null;
            void audio.play?.().catch(() => undefined);
          }
        };
        pc.onconnectionstatechange = () => {
          const s = pc?.connectionState;
          if (!stopped && (s === 'failed' || s === 'closed')) fail('connection_lost', 'Связь с голосовым сервисом прервалась. Нажмите «Переподключить».');
        };
        for (const t of stream.getAudioTracks()) pc.addTrack(t, stream);
        dc = pc.createDataChannel('oai-events');
        dc.onopen = () => {
          if (!stopped && state === 'connecting') set('listening');
        };
        dc.onclose = () => {
          if (!stopped) fail('connection_lost', 'Связь с голосовым сервисом прервалась. Нажмите «Переподключить».');
        };
        dc.onmessage = (e) => onEvent(e.data);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (stopped) return;
        const answer = await opts.negotiate(offer.sdp ?? '');
        if (stopped) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch (e) {
        return fail('connect_failed', (e as Error)?.message || 'Не удалось подключиться к голосовому сервису');
      }
    },

    setMuted(value: boolean): boolean {
      muted = value;
      for (const t of stream?.getAudioTracks() ?? []) t.enabled = !value;
      return muted;
    },

    /** «Перебить»: stop the current answer at once and listen. */
    interrupt(): void {
      if (stopped) return;
      send({ type: 'response.cancel' });
      send({ type: 'output_audio_buffer.clear' });
      if (state === 'speaking' || state === 'thinking') set('listening');
    },

    /** Ends the conversation: every microphone track stops, the remote audio is dropped. Idempotent. */
    stop(reason = 'ended'): void {
      if (stopped) return;
      teardown(reason);
      set('ended');
    },
  };
}

export type RealtimeTransport = ReturnType<typeof createRealtimeTransport>;
