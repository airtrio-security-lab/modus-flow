/**
 * Thin client for API v1. The session token lives in sessionStorage (demo
 * login; the production build will use OIDC, ADR-0009). Every mutation sends
 * an Idempotency-Key so a double tap or a retry never creates a duplicate.
 */
const TOKEN_KEY = 'modus.token';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}
let memoryToken: string | null = null;
export function setToken(token: string | null) {
  memoryToken = token;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the in-memory copy is enough for this tab */
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  issues: { path: (string | number)[]; message: string }[];
  constructor(status: number, code: string, message: string, issues: ApiError['issues'] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

interface Opts {
  method?: string;
  json?: unknown;
  body?: Blob | ArrayBuffer;
  headers?: Record<string, string>;
  idempotent?: boolean;
  /** A fixed key: a retry of the same logical action replays instead of duplicating. */
  key?: string;
}

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.body) body = opts.body;
  const method = opts.method ?? (body ? 'POST' : 'GET');
  if (method !== 'GET' && opts.idempotent !== false) headers['idempotency-key'] = opts.key ?? newKey();

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером. Проверьте подключение и повторите.');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string; issues?: ApiError['issues'] };
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? `Ошибка ${res.status}`, d.issues ?? []);
  }
  return data as T;
}

/** Human message for an error, including the first validation detail. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const first = e.issues[0]?.message;
    if (e.code === 'forbidden') return `Это действие вам недоступно. ${e.message}`.trim();
    return first && first !== e.message ? `${e.message}: ${first}` : e.message;
  }
  return e instanceof Error ? e.message : 'Что-то пошло не так';
}

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
