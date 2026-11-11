import { AppError } from '../domain/errors.ts';
import { validateQuotes, type Candidate } from '../domain/protocol.ts';

/**
 * Optional local language model for MODUS ADVISOR (ADR-0013).
 *
 * Off by default. The only supported provider is a local Ollama server
 * (free, runs on the same computer): the meeting text never leaves the
 * machine. A remote URL is refused unless MODUS_ADVISOR_ALLOW_REMOTE=true is
 * set deliberately, because it would send internal meeting notes elsewhere.
 * Paid cloud APIs are not wired in: connecting one needs the owner's approval.
 *
 *   MODUS_ADVISOR_PROVIDER=ollama
 *   MODUS_ADVISOR_URL=http://127.0.0.1:11434     (default)
 *   MODUS_ADVISOR_MODEL=qwen2.5:7b               (any model pulled into Ollama)
 */
export interface ModelConfig {
  provider: 'ollama';
  url: string;
  model: string;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv): ModelConfig | null {
  if ((env.MODUS_ADVISOR_PROVIDER ?? 'none') === 'none') return null;
  if (env.MODUS_ADVISOR_PROVIDER !== 'ollama') throw new Error('MODUS_ADVISOR_PROVIDER: поддерживается только "ollama" (локальная модель) или "none"');
  const url = (env.MODUS_ADVISOR_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const host = new URL(url).hostname;
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
  if (!local && env.MODUS_ADVISOR_ALLOW_REMOTE !== 'true') {
    throw new Error('MODUS_ADVISOR_URL указывает не на этот компьютер: протоколы ушли бы наружу. Нужен явный MODUS_ADVISOR_ALLOW_REMOTE=true');
  }
  const model = env.MODUS_ADVISOR_MODEL?.trim();
  if (!model) throw new Error('MODUS_ADVISOR_MODEL обязателен при MODUS_ADVISOR_PROVIDER=ollama');
  return { provider: 'ollama', url, model };
}

const SYSTEM = `Ты помогаешь разобрать протокол совещания. Найди в тексте проблемы, предложения и поручения.
Верни только JSON: {"items":[{"quote":"…","title":"…","kind":"problem|idea","raiser":"…"}]}.
quote — ТОЧНАЯ строка из протокола, без изменений. title — коротко, до 120 символов.
kind — "problem", если описана проблема, иначе "idea". raiser — кто поднял, если это указано в тексте, иначе пусто.
Ничего не выдумывай: если пункта нет в тексте, не добавляй его.`;

/** Asks the local model; keeps only items whose quote is literally in the text. */
export async function extractByModel(cfg: ModelConfig, text: string, fetchImpl: typeof fetch = fetch): Promise<{ candidates: Candidate[]; dropped: number }> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: text },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new AppError('conflict', 'Локальная модель не отвечает. Разберите протокол по шаблону или запустите Ollama');
  }
  if (!res.ok) throw new AppError('conflict', `Локальная модель вернула ошибку ${res.status}`);
  let items: unknown;
  try {
    const body = (await res.json()) as { message?: { content?: string } };
    items = (JSON.parse(body.message?.content ?? '{}') as { items?: unknown }).items;
  } catch {
    throw new AppError('conflict', 'Модель вернула ответ не в том формате. Разберите протокол по шаблону');
  }
  return validateQuotes(text, Array.isArray(items) ? items : []);
}

/** Whether the configured model answers right now (short check for the status line). */
export async function modelReachable(cfg: ModelConfig, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const tags = (await r.json()) as { models?: { name?: string }[] };
    return (tags.models ?? []).some((m) => m.name === cfg.model || m.name === `${cfg.model}:latest`);
  } catch {
    return false;
  }
}
