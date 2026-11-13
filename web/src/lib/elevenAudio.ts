import type { ElevenAudio, ElevenEnv, SocketLike } from './elevenTransport.ts';
import type { StreamLike } from './realtimeTransport.ts';

/**
 * The browser side of the ElevenLabs transport (ADR-0043): microphone → PCM16 chunks, PCM16 chunks →
 * speakers, and the WebSocket. No worklet file and no blob: the page's script-src stays 'self'.
 */
function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Int16Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length - (s.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = s.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** Linear resampling of one block to the provider's rate (a no-op when the context already runs at it). */
function resample(input: Float32Array, from: number, to: number): Int16Array {
  const n = from === to ? input.length : Math.floor((input.length * to) / from);
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, input.length - 1);
    const v = input[a]! + (input[b]! - input[a]!) * (pos - a);
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return out;
}

class BrowserAudio implements ElevenAudio {
  onIdle: (() => void) | null = null;
  #ctx: AudioContext | null = null;
  #nodes: AudioNode[] = [];
  #playing = new Set<AudioBufferSourceNode>();
  #next = 0;

  #context(rate: number): AudioContext {
    if (!this.#ctx) {
      try {
        this.#ctx = new AudioContext({ sampleRate: rate });
      } catch {
        this.#ctx = new AudioContext();
      }
      void this.#ctx.resume().catch(() => undefined);
    }
    return this.#ctx;
  }

  capture(stream: StreamLike, rate: number, onChunk: (base64: string) => void): void {
    const ctx = this.#context(rate);
    const src = ctx.createMediaStreamSource(stream as unknown as MediaStream);
    // ScriptProcessor: one small callback on the page, no extra script file to allow in the CSP.
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (e) => onChunk(toBase64(resample(e.inputBuffer.getChannelData(0), ctx.sampleRate, rate)));
    const silent = ctx.createGain();
    silent.gain.value = 0;
    src.connect(proc);
    proc.connect(silent);
    silent.connect(ctx.destination);
    this.#nodes.push(src, proc, silent);
  }

  play(base64: string, rate: number): void {
    const ctx = this.#context(rate);
    const pcm = fromBase64(base64);
    if (!pcm.length) return;
    const buf = ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 0x8000;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this.#next);
    this.#next = at + buf.duration;
    this.#playing.add(node);
    node.onended = () => {
      this.#playing.delete(node);
      if (!this.#playing.size) this.onIdle?.();
    };
    node.start(at);
  }

  flush(): void {
    for (const n of this.#playing) {
      n.onended = null;
      try {
        n.stop();
      } catch {
        /* not started yet */
      }
    }
    this.#playing.clear();
    this.#next = 0;
  }

  close(): void {
    this.flush();
    for (const n of this.#nodes) n.disconnect();
    this.#nodes = [];
    void this.#ctx?.close().catch(() => undefined);
    this.#ctx = null;
  }
}

export function browserElevenEnv(): ElevenEnv {
  const md = navigator.mediaDevices;
  return {
    getUserMedia: md?.getUserMedia ? (c) => md.getUserMedia(c) as unknown as Promise<StreamLike> : undefined,
    openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    createAudio: () => new BrowserAudio(),
  };
}
