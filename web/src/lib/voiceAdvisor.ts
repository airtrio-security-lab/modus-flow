import { api, ApiError, getToken } from './api';

/**
 * The company side of «Спросить советника» in the browser (ADR-0042): calls to the MODUS FLOW
 * server only. The SDP offer goes to our server, which relays it with a short-lived secret the
 * page never sees; tool calls go to our server, which runs them with the employee's own rights.
 */
export type VoiceLanguage = 'ru' | 'kk';
export interface VoiceContextRef {
  kind: 'council';
  number: number;
}

export interface VoiceStatus {
  voice: { configured: boolean; provider: string | null; model: string | null; voice: string | null; remote: boolean; maxSeconds: number };
  text: { configured: boolean; model: string | null; remote: boolean; label: string | null; reachable: boolean };
  note: string;
}

export interface VoiceRef {
  type: 'item' | 'council' | 'meeting';
  id: string;
  title: string;
  href: string;
}

export type VoiceProposal =
  | { kind: 'lab_draft'; draft: { kind: 'idea' | 'problem'; title: string; content: Record<string, string> }; saved: false; requiresConfirmation: true }
  | { kind: 'council_question'; text: string; number: number | null; saved: false; requiresConfirmation: true };

export interface ToolReply {
  tool: string;
  found: number;
  data: unknown;
  refs: VoiceRef[];
  proposal?: VoiceProposal;
}

export interface AskReply {
  method: 'model' | 'none';
  answer: string | null;
  model: string | null;
  label?: string;
  remote?: boolean;
  found: number;
  refs: VoiceRef[];
  facts: { tool: string; found: number; data: unknown }[];
  errors: { tool: string; message: string }[];
  note?: string;
}

export const voiceStatus = (org: string) => api<VoiceStatus>(`/orgs/${org}/voice/status`);

export const startVoiceSession = (org: string, language: VoiceLanguage, context?: VoiceContextRef) =>
  api<{ sessionId: string; expiresAt: string; maxSeconds: number; model: string; voice: string; language: VoiceLanguage }>(`/orgs/${org}/voice/sessions`, {
    json: context ? { language, context } : { language },
    idempotent: false,
  });

/** Plain fetch: the body and the answer are SDP text, not JSON. */
export async function relayOffer(org: string, sessionId: string, offer: string): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/sdp' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api/v1/orgs/${org}/voice/sessions/${sessionId}/sdp`, { method: 'POST', headers, body: offer });
  } catch {
    throw new ApiError(0, 'network', 'Нет связи с сервером MODUS FLOW');
  }
  const text = await res.text();
  if (!res.ok) {
    let message = `Ошибка ${res.status}`;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, 'sdp', message);
  }
  return text;
}

export const runVoiceTool = (org: string, sessionId: string, name: string, args: string, callId: string) =>
  api<ToolReply>(`/orgs/${org}/voice/sessions/${sessionId}/tools`, { json: { name, arguments: args, callId }, idempotent: false });

export const endVoiceSession = (org: string, sessionId: string) =>
  api(`/orgs/${org}/voice/sessions/${sessionId}`, { method: 'DELETE', idempotent: false }).catch(() => undefined);

export const askAdvisorText = (org: string, question: string, language: VoiceLanguage, context?: VoiceContextRef) =>
  api<AskReply>(`/orgs/${org}/voice/ask`, { json: context ? { question, language, context } : { question, language }, idempotent: false });

const LANG_KEY = 'modus.voice.language';
export function rememberedLanguage(): VoiceLanguage {
  try {
    return localStorage.getItem(LANG_KEY) === 'kk' ? 'kk' : 'ru';
  } catch {
    return 'ru';
  }
}
export function rememberLanguage(l: VoiceLanguage) {
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* no storage: the choice lasts this visit */
  }
}
