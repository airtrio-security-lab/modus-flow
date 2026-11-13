import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTransport, type ChannelLike, type PeerLike, type TransportEnv, type VoiceErrorCode, type VoiceState } from '../../web/src/lib/realtimeTransport.ts';

/**
 * The browser WebRTC transport of the voice advisor (ADR-0042) against fake media objects:
 * no microphone, no network, no OpenAI. Runs without a database (fast verify step).
 */
class Track {
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class Channel implements ChannelLike {
  readyState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
    this.readyState = 'closed';
  }
  open() {
    this.readyState = 'open';
    this.onopen?.();
  }
  emit(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
class Peer implements PeerLike {
  connectionState = 'new';
  ontrack: ((e: { streams: readonly unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  tracks: Track[] = [];
  channel = new Channel();
  remote: string | null = null;
  closed = false;
  addTrack(t: Track) {
    this.tracks.push(t);
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription(d: { sdp: string }) {
    this.remote = d.sdp;
  }
  close() {
    this.closed = true;
  }
}

function rig(opts: { mic?: 'ok' | 'denied' | 'missing' | 'none' | 'slow'; negotiate?: (offer: string) => Promise<string>; onToolCall?: ((c: { name: string; arguments: string }) => Promise<unknown>) | null } = {}) {
  const tracks = [new Track()];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const peers: Peer[] = [];
  const audio = { srcObject: 'x' as unknown, removed: false, remove() {
    this.removed = true;
  } };
  let release: (() => void) | null = null;
  const env: TransportEnv = {
    getUserMedia:
      opts.mic === 'none'
        ? undefined
        : async () => {
            if (opts.mic === 'denied') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
            if (opts.mic === 'missing') throw Object.assign(new Error('none'), { name: 'NotFoundError' });
            if (opts.mic === 'slow') await new Promise<void>((r) => (release = r));
            return stream;
          },
    createPeer: () => {
      const p = new Peer();
      peers.push(p);
      return p;
    },
    createAudio: () => audio,
  };
  const states: VoiceState[] = [];
  const errors: [VoiceErrorCode, string][] = [];
  const closed: string[] = [];
  const said: [string, boolean][] = [];
  const heard: string[] = [];
  const offers: string[] = [];
  const t = createRealtimeTransport({
    env,
    negotiate:
      opts.negotiate ??
      (async (offer) => {
        offers.push(offer);
        return 'v=0 answer';
      }),
    events: {
      onState: (s) => states.push(s),
      onError: (c, m) => errors.push([c, m]),
      onClosed: (r) => closed.push(r),
      onAssistantText: (text, final) => said.push([text, final]),
      onUserText: (text) => heard.push(text),
      ...(opts.onToolCall === null ? {} : { onToolCall: opts.onToolCall ?? (async (c) => ({ tool: c.name, found: 1 })) }),
    },
  });
  return { t, tracks, peers, audio, states, errors, closed, said, heard, offers, release: () => release?.() };
}
const tick = () => new Promise((r) => setImmediate(r));

test('microphone denied: an honest error, no connection is attempted, nothing stays open', async () => {
  const r = rig({ mic: 'denied' });
  await r.t.start();
  assert.equal(r.t.state(), 'error');
  assert.equal(r.errors[0]![0], 'mic_denied');
  assert.match(r.errors[0]![1], /Разрешите микрофон/);
  assert.equal(r.peers.length, 0);
  const missing = rig({ mic: 'missing' });
  await missing.t.start();
  assert.equal(missing.errors[0]![0], 'no_mic');
  const insecure = rig({ mic: 'none' });
  await insecure.t.start();
  assert.equal(insecure.errors[0]![0], 'insecure', 'http on a phone: no microphone API');
});

test('start: the offer goes through the company negotiator; states follow the conversation; barge-in is shown', async () => {
  const r = rig();
  await r.t.start();
  assert.deepEqual(r.offers, ['v=0 offer']);
  const p = r.peers[0]!;
  assert.equal(p.remote, 'v=0 answer');
  assert.equal(p.tracks.length, 1, 'the microphone track is sent');
  p.channel.open();
  assert.equal(r.t.state(), 'listening');
  const ch = p.channel;
  ch.emit({ type: 'input_audio_buffer.speech_started' });
  assert.equal(r.t.state(), 'user_speaking');
  ch.emit({ type: 'input_audio_buffer.committed' });
  assert.equal(r.t.state(), 'thinking');
  ch.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' Что требует моего внимания? ' });
  assert.deepEqual(r.heard, ['Что требует моего внимания?']);
  ch.emit({ type: 'response.created' });
  ch.emit({ type: 'output_audio_buffer.started' });
  ch.emit({ type: 'response.output_audio_transcript.delta', delta: 'У вас ' });
  ch.emit({ type: 'response.output_audio_transcript.delta', delta: 'два просроченных обращения.' });
  assert.equal(r.t.state(), 'speaking');
  // The employee speaks over the answer: the server cancels it; the UI listens at once.
  ch.emit({ type: 'input_audio_buffer.speech_started' });
  assert.equal(r.t.state(), 'user_speaking');
  ch.emit({ type: 'response.output_audio_transcript.done', transcript: 'У вас два просроченных обращения.' });
  ch.emit({ type: 'output_audio_buffer.stopped' });
  assert.deepEqual(r.said.at(-1), ['У вас два просроченных обращения.', true]);
  // The new question is committed; the next answer uses the beta event names, understood too.
  ch.emit({ type: 'input_audio_buffer.committed' });
  ch.emit({ type: 'response.audio_transcript.delta', delta: 'Да.' });
  assert.equal(r.t.state(), 'speaking');
  r.t.stop();
});

test('interrupt: cancels the answer and clears the audio buffer', async () => {
  const r = rig();
  await r.t.start();
  const ch = r.peers[0]!.channel;
  ch.open();
  ch.emit({ type: 'output_audio_buffer.started' });
  r.t.interrupt();
  assert.deepEqual(ch.sent.map((m) => m.type), ['response.cancel', 'output_audio_buffer.clear']);
  assert.equal(r.t.state(), 'listening');
  ch.emit({ type: 'error', error: { code: 'response_cancel_not_active', message: 'nothing' } });
  assert.equal(r.errors.length, 0, 'cancelling when nothing plays is not an error');
  r.t.stop();
});

test('tool calls: the handler result goes back to the model; failures are errors, never a fake success', async () => {
  const r = rig({
    onToolCall: async (c) => {
      if (c.name === 'decide_item') throw Object.assign(new Error('Инструмент не поддерживается'), { code: 'unsupported_tool' });
      return { tool: c.name, found: 2 };
    },
  });
  await r.t.start();
  const ch = r.peers[0]!.channel;
  ch.open();
  ch.emit({ type: 'response.function_call_arguments.done', name: 'get_my_summary', call_id: 'c1', arguments: '{}' });
  await tick();
  assert.deepEqual(ch.sent.map((m) => m.type), ['conversation.item.create', 'response.create']);
  const out1 = JSON.parse(String((ch.sent[0]!.item as { output: string }).output));
  assert.deepEqual(out1, { tool: 'get_my_summary', found: 2 });
  assert.equal((ch.sent[0]!.item as { call_id: string }).call_id, 'c1');
  ch.emit({ type: 'response.function_call_arguments.done', name: 'decide_item', call_id: 'c2', arguments: '{"number":5}' });
  await tick();
  const out2 = JSON.parse(String((ch.sent[2]!.item as { output: string }).output));
  assert.deepEqual([out2.error, out2.code, out2.success], [true, 'unsupported_tool', undefined]);
  r.t.stop();

  const bare = rig({ onToolCall: null });
  await bare.t.start();
  bare.peers[0]!.channel.open();
  bare.peers[0]!.channel.emit({ type: 'response.function_call_arguments.done', name: 'x', call_id: 'c3', arguments: '{}' });
  await tick();
  const out3 = JSON.parse(String((bare.peers[0]!.channel.sent[0]!.item as { output: string }).output));
  assert.equal(out3.error, true, 'no handler: an error, not { success: true }');
  bare.t.stop();
});

test('mute and unmute switch the microphone track; stop releases every media stream, once', async () => {
  const r = rig();
  await r.t.start();
  r.peers[0]!.channel.open();
  assert.equal(r.t.setMuted(true), true);
  assert.equal(r.tracks[0]!.enabled, false);
  r.t.setMuted(false);
  assert.equal(r.tracks[0]!.enabled, true);
  r.t.stop('ended_by_user');
  r.t.stop('again');
  assert.equal(r.tracks[0]!.stopped, true, 'the microphone is released');
  assert.equal(r.peers[0]!.closed, true);
  assert.equal(r.peers[0]!.channel.closed, true);
  assert.deepEqual([r.audio.srcObject, r.audio.removed], [null, true], 'the remote audio is dropped');
  assert.deepEqual(r.closed, ['ended_by_user'], 'idempotent');
  assert.equal(r.t.state(), 'ended');
  r.peers[0]!.channel.emit({ type: 'response.function_call_arguments.done', name: 'get_item', call_id: 'late', arguments: '{}' });
  await tick();
  assert.equal(r.peers[0]!.channel.sent.length, 0, 'nothing is sent after the end');
  await assert.rejects(r.t.start(), /новый/, 'a stopped transport is not reused: reconnect creates a new one');
});

test('closing the panel while the microphone prompt is open releases the microphone when it arrives', async () => {
  const r = rig({ mic: 'slow' });
  const started = r.t.start();
  await tick();
  r.t.stop('panel_closed');
  r.release();
  await started;
  assert.equal(r.tracks[0]!.stopped, true);
  assert.equal(r.peers.length, 0, 'no connection after the employee left');
});

test('server or provider unavailable: connect_failed, and the microphone is released', async () => {
  const r = rig({ negotiate: async () => Promise.reject(new Error('Голосовой AI не подключён')) });
  await r.t.start();
  assert.equal(r.t.state(), 'error');
  assert.deepEqual(r.errors[0], ['connect_failed', 'Голосовой AI не подключён']);
  assert.equal(r.tracks[0]!.stopped, true);
  assert.equal(r.peers[0]!.closed, true);
});

test('connection lost mid-conversation: an error the panel can offer to reconnect from; all media released', async () => {
  const r = rig();
  await r.t.start();
  const p = r.peers[0]!;
  p.channel.open();
  p.connectionState = 'failed';
  p.onconnectionstatechange?.();
  assert.equal(r.t.state(), 'error');
  assert.equal(r.errors[0]![0], 'connection_lost');
  assert.match(r.errors[0]![1], /Переподключить/);
  assert.equal(r.tracks[0]!.stopped, true);
  assert.deepEqual(r.closed, ['connection_lost']);
  // Reconnect = a fresh transport and a fresh server session.
  const again = rig();
  await again.t.start();
  again.peers[0]!.channel.open();
  assert.equal(again.t.state(), 'listening');
  again.t.stop();
});

test('no simulation mode exists: the transport has no way to speak without a real answer', async () => {
  const raw = (await import('node:fs')).readFileSync(new URL('../../web/src/lib/realtimeTransport.ts', import.meta.url), 'utf8');
  // Code only: the header comment explains what was removed from the original client.
  const src = raw.split('\n').filter((l) => !/^\s*(\/\*\*|\*|\/\/)/.test(l)).join('\n');
  assert.ok(!/isMock|simulat|РЕЖИМ СИМУЛЯЦИИ/i.test(src), 'no mock voice in the client');
  assert.ok(!/success:\s*true/.test(src), 'no default success for tools');
  assert.ok(!/api\.openai\.com|sk-|Bearer/.test(src), 'no provider address or key in the browser transport');
});
