import { AppError } from '../domain/errors.ts';
import { formatMs } from '../domain/meeting.ts';

/**
 * Optional local speech-to-text engine (ADR-0014). Off by default.
 *
 * Supported: any server on THIS computer that speaks the OpenAI-compatible
 * `/v1/audio/transcriptions` API (for example faster-whisper-server / speaches
 * or whisper.cpp's server with the OpenAI route) — free, runs offline, the
 * recording never leaves the machine. A non-local URL is refused unless
 * MODUS_TRANSCRIBE_ALLOW_REMOTE=true is set deliberately. Paid cloud APIs are
 * not wired in: connecting one needs the owner's approval.
 *
 *   MODUS_TRANSCRIBE_PROVIDER=openai-compatible-local
 *   MODUS_TRANSCRIBE_URL=http://127.0.0.1:8000
 *   MODUS_TRANSCRIBE_MODEL=Systran/faster-whisper-small
 */
export interface TranscribeConfig {
  provider: 'openai-compatible-local';
  url: string;
  model: string;
}

export function transcribeConfigFromEnv(env: NodeJS.ProcessEnv): TranscribeConfig | null {
  const p = env.MODUS_TRANSCRIBE_PROVIDER ?? 'none';
  if (p === 'none') return null;
  if (p !== 'openai-compatible-local') throw new Error('MODUS_TRANSCRIBE_PROVIDER: поддерживается "openai-compatible-local" или "none"');
  const url = (env.MODUS_TRANSCRIBE_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) && env.MODUS_TRANSCRIBE_ALLOW_REMOTE !== 'true') {
    throw new Error('MODUS_TRANSCRIBE_URL указывает не на этот компьютер: запись ушла бы наружу. Нужен явный MODUS_TRANSCRIBE_ALLOW_REMOTE=true');
  }
  const model = env.MODUS_TRANSCRIBE_MODEL?.trim();
  if (!model) throw new Error('MODUS_TRANSCRIBE_MODEL обязателен');
  return { provider: 'openai-compatible-local', url, model };
}

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav' };

/** Returns the transcript as «[мм:сс] текст» lines. The engine does not tell who spoke: no speakers are guessed. */
export async function transcribe(cfg: TranscribeConfig, audio: Buffer, contentType: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(audio)], { type: contentType }), `meeting.${EXT[contentType] ?? 'bin'}`);
  form.set('model', cfg.model);
  form.set('language', 'ru');
  form.set('response_format', 'verbose_json');
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    throw new AppError('conflict', 'Движок расшифровки не отвечает. Запустите его или вставьте расшифровку вручную');
  }
  if (!res.ok) throw new AppError('conflict', `Движок расшифровки вернул ошибку ${res.status}`);
  let body: { text?: unknown; segments?: { start?: unknown; text?: unknown }[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new AppError('conflict', 'Движок расшифровки вернул ответ не в том формате');
  }
  const segs = Array.isArray(body.segments) ? body.segments : [];
  const lines = segs
    .filter((s) => typeof s.text === 'string' && s.text.trim() && typeof s.start === 'number' && Number.isFinite(s.start))
    .map((s) => `[${formatMs(Math.round((s.start as number) * 1000))}] ${(s.text as string).replace(/\s+/g, ' ').trim()}`);
  const text = lines.length ? lines.join('\n') : typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length < 20) throw new AppError('conflict', 'Движок не распознал речь в записи');
  return text;
}

export async function engineReachable(cfg: TranscribeConfig, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(`${cfg.url}/v1/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}
