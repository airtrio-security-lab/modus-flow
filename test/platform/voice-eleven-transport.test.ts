import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElevenTransport, OPENING_CUE, type ElevenAudio, type SocketLike } from '../../web/src/lib/elevenTransport.ts';
import type { VoiceErrorCode, VoiceState } from '../../web/src/lib/realtimeTransport.ts';

/**
 * The ElevenLabs WebSocket transport (ADR-0043) against a fake socket and fake audio: no microphone,
 * no network, no ElevenLabs. Runs without a database (fast verify step).
 */
class Track {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class Socket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}
class Audio implements ElevenAudio {
  onIdle: (() => void) | null = null;
  played: [string, number][] = [];
  flushed = 0;
  closed = false;
  chunk: ((b: string) => void) | null = null;
  rate = 0;
  capture(_s: unknown, rate: number, onChunk: (b: string) => void) {
    this.rate = rate;
    this.chunk = onChunk;
  }
  play(b: string, rate: number) {
    this.played.push([b, rate]);
  }
  flush() {
    this.flushed++;
  }
  close() {
    this.closed = true;
  }
}

function rig(o: { mic?: 'ok' | 'denied'; open?: () => Promise<{ url: string; initiation: Record<string, unknown> }>; tool?: (c: { name: string; arguments: string }) => Promise<unknown> } = {}) {
  const tracks = [new Track()];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const sockets: Socket[] = [];
  const audio = new Audio();
  const states: VoiceState[] = [];
  const errors: [VoiceErrorCode, string][] = [];
  const heard: string[] = [];
  const said: string[] = [];
  let ready = 0;
  const closed: string[] = [];
  const t = createElevenTransport({
    env: {
      getUserMedia: async () => {
        if (o.mic === 'denied') throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
        return stream;
      },
      openSocket: (url) => {
        const s = new Socket();
        (s as unknown as { url: string }).url = url;
        sockets.push(s);
        return s;
      },
      createAudio: () => audio,
    },
    open: o.open ?? (async () => ({ url: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=a&conversation_signature=s', initiation: { type: 'conversation_initiation_client_data', conversation_config_override: { agent: { prompt: { prompt: 'P' } } } } })),
    events: {
      onState: (s) => states.push(s),
      onError: (c, m) => errors.push([c, m]),
      onUserText: (x) => heard.push(x),
      onAssistantText: (x) => said.push(x),
      onReady: () => ready++,
      onClosed: (r) => closed.push(r),
      onToolCall: o.tool ?? (async (c) => ({ tool: c.name, found: 1 })),
    },
  });
  const begin = async () => {
    await t.start();
    const s = sockets[0]!;
    s.open();
    s.emit({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'c1', agent_output_audio_format: 'pcm_24000', user_input_audio_format: 'pcm_16000' } });
    return s;
  };
  return { t, tracks, sockets, audio, states, errors, heard, said, closed, ready: () => ready, begin };
}
const tick = () => new Promise((r) => setImmediate(r));

test('microphone denied: no session is opened, no socket, an honest error', async () => {
  let opened = 0;
  const r = rig({ mic: 'denied', open: async () => (opened++, { url: 'wss://x', initiation: {} }) });
  await r.t.start();
  assert.equal(r.errors[0]![0], 'mic_denied');
  assert.deepEqual([opened, r.sockets.length, r.t.state()], [0, 0, 'error']);
});

test('start: the initiation goes first; audio formats come from the provider; the microphone is sent as PCM chunks', async () => {
  const r = rig();
  const s = await r.begin();
  assert.equal(s.sent[0]!.type, 'conversation_initiation_client_data', 'instructions travel in the first message');
  assert.deepEqual([r.t.state(), r.ready(), r.audio.rate], ['listening', 1, 16000]);
  r.audio.chunk!('AAAA');
  assert.deepEqual(s.sent.at(-1), { user_audio_chunk: 'AAAA' });
  r.t.setMuted(true);
  r.audio.chunk!('BBBB');
  assert.deepEqual(s.sent.at(-1), { user_audio_chunk: 'AAAA' }, 'nothing is sent while muted');
  assert.equal(r.tracks[0]!.enabled, false);
  r.t.setMuted(false);
  s.emit({ type: 'ping', ping_event: { event_id: 7 } });
  assert.deepEqual(s.sent.at(-1), { type: 'pong', event_id: 7 });
  r.t.stop();
});

test('conversation: states, transcripts, playback at the provider rate, barge-in', async () => {
  const r = rig();
  const s = await r.begin();
  assert.equal(r.t.speakFirst(), true);
  assert.deepEqual(s.sent.at(-1), { type: 'user_message', text: OPENING_CUE });
  s.emit({ type: 'user_transcript', user_transcription_event: { user_transcript: OPENING_CUE } });
  assert.deepEqual(r.heard, [], 'the opening cue is never shown as the employee’s words');
  s.emit({ type: 'agent_response', agent_response_event: { agent_response: '[Calm] Мой милорд, у вас три открытых обращения.' } });
  s.emit({ type: 'audio', audio_event: { audio_base_64: 'QUJD', event_id: 1 } });
  assert.deepEqual([r.t.state(), r.audio.played[0]], ['speaking', ['QUJD', 24000]]);
  assert.deepEqual(r.said, ['Мой милорд, у вас три открытых обращения.']);
  // The employee speaks over the answer.
  s.emit({ type: 'interruption', interruption_event: { event_id: 1 } });
  assert.deepEqual([r.audio.flushed, r.t.state()], [1, 'user_speaking']);
  s.emit({ type: 'user_transcript', user_transcription_event: { user_transcript: 'Какие просрочены?' } });
  assert.deepEqual([r.heard, r.t.state()], [['Какие просрочены?'], 'thinking']);
  s.emit({ type: 'audio', audio_event: { audio_base_64: 'REVG', event_id: 2 } });
  r.audio.onIdle!();
  assert.equal(r.t.state(), 'listening', 'the queue drained');
  // «Перебить» by button: the rest of the answer is dropped until the next turn.
  s.emit({ type: 'audio', audio_event: { audio_base_64: 'R0hJ', event_id: 3 } });
  r.t.interrupt();
  const n = r.audio.played.length;
  s.emit({ type: 'audio', audio_event: { audio_base_64: 'SktM', event_id: 4 } });
  assert.equal(r.audio.played.length, n, 'late audio of the interrupted answer is not played');
  s.emit({ type: 'user_transcript', user_transcription_event: { user_transcript: 'Дальше' } });
  s.emit({ type: 'audio', audio_event: { audio_base_64: 'TU5P', event_id: 5 } });
  assert.equal(r.audio.played.length, n + 1);
  r.t.stop();
});

test('client tools: the handler result goes back; failures are errors, never a fake success', async () => {
  const r = rig({
    tool: async (c) => {
      if (c.name === 'decide_item') throw Object.assign(new Error('Инструмент не поддерживается'), { code: 'unsupported_tool' });
      if (c.name === 'get_item') return { error: true, message: 'Не найдено' };
      return { tool: c.name, args: JSON.parse(c.arguments) };
    },
  });
  const s = await r.begin();
  s.emit({ type: 'client_tool_call', client_tool_call: { tool_name: 'search_items', tool_call_id: 't1', parameters: { overdue: true } } });
  await tick();
  assert.deepEqual(s.sent.at(-1), { type: 'client_tool_result', tool_call_id: 't1', result: JSON.stringify({ tool: 'search_items', args: { overdue: true } }), is_error: false });
  s.emit({ type: 'client_tool_call', client_tool_call: { tool_name: 'decide_item', tool_call_id: 't2', parameters: {} } });
  await tick();
  const bad = s.sent.at(-1)!;
  assert.deepEqual([bad.is_error, JSON.parse(String(bad.result)).code, JSON.parse(String(bad.result)).success], [true, 'unsupported_tool', undefined]);
  s.emit({ type: 'client_tool_call', client_tool_call: { tool_name: 'get_item', tool_call_id: 't3', parameters: { number: 9 } } });
  await tick();
  assert.equal(s.sent.at(-1)!.is_error, true, 'a server refusal is passed on as an error');
  r.t.stop();
});

test('typed question, stop and failures: everything is released; a refused connection is not a lost one', async () => {
  const r = rig();
  const s = await r.begin();
  assert.equal(r.t.sendText('  Что требует внимания?  '), true);
  assert.deepEqual(s.sent.at(-1), { type: 'user_message', text: 'Что требует внимания?' });
  assert.equal(r.t.sendText('  '), false);
  r.t.stop('ended_by_user');
  r.t.stop('again');
  assert.deepEqual([r.tracks[0]!.stopped, s.closed, r.audio.closed, r.closed, r.t.state()], [true, true, true, ['ended_by_user'], 'ended']);
  assert.equal(r.t.sendText('после конца'), false);

  const lost = rig();
  const s2 = await lost.begin();
  s2.onclose?.({ code: 1006 });
  assert.deepEqual([lost.errors[0]![0], lost.tracks[0]!.stopped, lost.t.state()], ['connection_lost', true, 'error']);

  const refused = rig();
  await refused.t.start();
  refused.sockets[0]!.onclose?.({ code: 3000, reason: 'Override for field prompt is not allowed by config.' });
  assert.equal(refused.errors[0]![0], 'connect_failed');
  assert.match(refused.errors[0]![1], /не принял подключение.*Override/);

  const down = rig({ open: async () => Promise.reject(new Error('Голосовой сервис ElevenLabs вернул ошибку 401: ключ не принят')) });
  await down.t.start();
  assert.deepEqual([down.errors[0]![0], down.tracks[0]!.stopped, down.sockets.length], ['connect_failed', true, 0]);
});

test('no key, no provider address and no simulation in the browser transport', async () => {
  const fs = await import('node:fs');
  for (const f of ['elevenTransport.ts', 'elevenAudio.ts']) {
    const raw = fs.readFileSync(new URL(`../../web/src/lib/${f}`, import.meta.url), 'utf8');
    const src = raw.split('\n').filter((l) => !/^\s*(\/\*\*|\*|\/\/)/.test(l)).join('\n');
    assert.ok(!/xi-api-key|elevenlabs\.io|isMock|simulat/i.test(src), f);
    assert.ok(!/success:\s*true/.test(src), f);
  }
});
