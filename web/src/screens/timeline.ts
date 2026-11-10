import type { Tone } from '../lib/status';
import type { Evidence, IdeaDetail, Review, Verification } from '../lib/types';

/**
 * One chronological history from the item's records. Nothing here is
 * invented: every event is a stored revision, review, check, decision,
 * file or escalation. Negative evidence is shown like any other.
 */
export interface TimelineEvent {
  key: string;
  at: string;
  tone: Tone;
  who: string | null;
  what: string;
  body?: string | null;
  bodyStyle?: 'quote' | 'reply';
  review?: Review;
  verification?: Verification;
  evidence?: Evidence[];
  attachmentId?: string;
  attachmentName?: string;
}

const REVIEW: Record<Review['kind'], { what: string; tone: Tone }> = {
  comment: { what: 'комментирует', tone: 'idle' },
  request_changes: { what: 'задаёт вопрос автору', tone: 'wait' },
  objection: { what: 'возражает', tone: 'wait' },
  approval: { what: 'поддерживает', tone: 'active' },
  progress: { what: 'сообщает о ходе работ', tone: 'active' },
};

const ESCALATION = {
  first_response: 'Нет первого ответа в срок — обращение эскалировано',
  resolution: 'Истёк срок решения — обращение эскалировано',
  stale: 'Нет движения по обращению — эскалировано',
} as const;

export function buildTimeline(i: IdeaDetail): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const r of i.revisions) {
    if (r.origin === 'publication') {
      const by = i.raisedBy ? `${r.author} со слов: ${i.raisedBy}` : r.author;
      out.push({ key: `rev-${r.number}`, at: r.created_at, tone: 'active', who: by, what: 'регистрирует обращение' });
    } else if (r.origin === 'author_update') {
      out.push({ key: `rev-${r.number}`, at: r.created_at, tone: 'active', who: r.author, what: `уточняет текст (версия ${r.number})`, body: r.rationale, bodyStyle: 'reply' });
    } else {
      out.push({ key: `rev-${r.number}`, at: r.created_at, tone: 'idle', who: r.author, what: `предлагает свою версию текста (версия ${r.number})`, body: r.rationale });
    }
  }
  for (const r of i.reviews) {
    const k = REVIEW[r.kind];
    out.push({ key: `rv-${r.id}`, at: r.created_at, tone: k.tone, who: r.author, what: k.what, body: r.body, bodyStyle: r.kind === 'request_changes' || r.kind === 'objection' ? 'quote' : undefined, review: r });
    if (r.resolved_at) {
      out.push({
        key: `rs-${r.id}`,
        at: r.resolved_at,
        tone: r.state === 'resolved' ? 'done' : 'idle',
        who: null,
        what: r.state === 'resolved' ? 'Вопрос закрыт' : 'Вопрос снят',
        body: r.resolution_note,
        bodyStyle: 'reply',
      });
    }
  }
  for (const v of i.verifications) {
    out.push({ key: `vs-${v.id}`, at: v.started_at ?? v.created_at, tone: 'active', who: v.owner, what: 'проводит проверку на практике', body: `${v.plan}\n\nКритерий: ${v.success_criteria}`, verification: v });
    if (v.evidence.length) out.push({ key: `ve-${v.id}`, at: v.evidence[v.evidence.length - 1]!.createdAt, tone: 'idle', who: null, what: 'Результаты проверки', evidence: v.evidence });
    if (v.completed_at) {
      const t: Tone = v.outcome === 'positive' ? 'done' : v.outcome === 'negative' ? 'stop' : 'wait';
      const label = v.outcome === 'positive' ? 'подтвердилась' : v.outcome === 'negative' ? 'не подтвердилась' : 'без однозначного вывода';
      out.push({ key: `vc-${v.id}`, at: v.completed_at, tone: t, who: v.concluded_by, what: `подводит итог: гипотеза ${label}`, body: v.conclusion });
    }
  }
  for (const d of i.decisions) {
    const what = d.outcome === 'merge' ? 'принимает решение: внедрить' : d.outcome === 'reject' ? 'принимает решение: отклонить' : 'закрывает обращение';
    out.push({ key: `d-${d.id}`, at: d.created_at, tone: d.outcome === 'merge' ? 'done' : 'stop', who: d.decided_by, what, body: d.rationale });
  }
  for (const a of i.attachments) {
    out.push({ key: `a-${a.id}`, at: a.createdAt, tone: 'idle', who: a.uploadedBy ?? null, what: 'прикладывает файл', attachmentId: a.id, attachmentName: a.fileName });
  }
  for (const e of i.escalations) {
    out.push({ key: `e-${e.kind}`, at: e.createdAt, tone: 'stop', who: null, what: `${ESCALATION[e.kind]}${e.escalatedTo ? `: ${e.escalatedTo}` : ''}` });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export const EVIDENCE_LABEL: Record<Evidence['kind'], string> = {
  baseline: 'Было до изменений',
  result: 'Результат',
  positive_observation: 'Подтверждает',
  negative_observation: 'Против',
  reference: 'Источник',
};
