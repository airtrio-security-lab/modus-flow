import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { Deferral, IdeaDetail, Status } from '../lib/types';
import type { Facts } from '../lib/can';

/**
 * Three small pieces shared by the item page and the envoy card in the city (owner request 2026-11-12):
 * the route of an item in four plain steps, «Оценка ИИ», and «Отложить решение». Each of them shows
 * what the server says and nothing more: no model — «не подключён»; no right — no button.
 */
const STEPS = ['Подано', 'Рассмотрение', 'Решение', 'Внедрение'] as const;
const STEP_OF: Record<Status, number> = { unrouted: 0, in_review: 1, needs_info: 1, in_verification: 1, decision: 2, in_progress: 3, implemented: 4, rejected: 2, closed: 2 } as Record<Status, number>;
const dateWord = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const isoDay = (plus: number) => {
  const d = new Date(Date.now() + plus * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Where the item is, in four steps a newcomer understands. */
export function ItemTrack({ status, paused }: { status: Status; paused: boolean }) {
  const at = STEP_OF[status] ?? 1;
  const ended = status === 'rejected' || status === 'closed';
  const text = ended ? (status === 'rejected' ? 'Отклонено с объяснением' : 'Закрыто без внедрения') : status === 'implemented' ? 'Внедрено' : `Шаг ${Math.min(at, 3) + 1} из 4: ${STEPS[Math.min(at, 3)]}`;
  return (
    <ol className="track" aria-label={`Путь обращения. ${text}${paused ? ', решение отложено' : ''}`}>
      {STEPS.map((name, i) => {
        const state = ended ? (i < at ? 'done' : 'off') : status === 'implemented' || i < at ? 'done' : i === at ? (paused ? 'paused' : 'now') : 'next';
        return (
          <li key={name} data-state={state}>
            <span aria-hidden="true">{state === 'done' ? '✓' : state === 'paused' ? 'Ⅱ' : i + 1}</span>
            {name}
          </li>
        );
      })}
    </ol>
  );
}

interface Assessment {
  verdict: 'supports' | 'doubts' | 'unclear';
  summary: string;
  strengths: string[];
  risks: string[];
  questions: string[];
}
type Reply = { available: false; note: string } | { available: true; ok: false; model: string; note: string } | { available: true; ok: true; model: string; subject: 'decision' | 'proposal'; assessment: Assessment; note: string };
const VERDICT: Record<Assessment['verdict'], string> = { supports: 'Решение выглядит соразмерным проблеме', doubts: 'Есть существенные сомнения', unclear: 'Данных мало для оценки' };

/** «Оценка ИИ»: the answer of a connected local model, or a plain «не подключён». */
export function AiAssessment({ number }: { number: number }) {
  const s = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [reply, setReply] = useState<Reply | null>(null);
  const ask = async () => {
    setState('busy');
    try {
      setReply(await api<Reply>(`/orgs/${s.org}/ideas/${number}/assessment`, { method: 'POST', idempotent: false }));
      setState('idle');
    } catch {
      setState('error');
    }
  };
  return (
    <div className="ai-box">
      <button type="button" className="quick-btn" onClick={() => void ask()} disabled={state === 'busy'} aria-expanded={reply !== null}>
        {state === 'busy' ? 'Модель читает обращение…' : reply?.available && reply.ok ? 'Оценить ещё раз' : 'Оценка ИИ'}
      </button>
      <div aria-live="polite">
        {state === 'error' ? <p className="quick-note" data-kind="warn">Не удалось запросить оценку. Попробуйте ещё раз.</p> : null}
        {reply && !reply.available ? (
          <p className="quick-note" data-kind="off">
            <b>ИИ не подключён.</b> Оценку решения делает только языковая модель; шаблоном система её не подменяет. Локальную модель может подключить администратор — текст обращений при этом не покидает компьютер.
          </p>
        ) : null}
        {reply && reply.available && !reply.ok ? (
          <p className="quick-note" data-kind="warn">
            {reply.note}
          </p>
        ) : null}
        {reply && reply.available && reply.ok ? (
          <section className="ai-result" aria-label="Оценка языковой модели">
            <p className="ai-verdict" data-verdict={reply.assessment.verdict}>
              {VERDICT[reply.assessment.verdict]}
            </p>
            <p>{reply.assessment.summary}</p>
            {(
              [
                ['Сильные стороны', reply.assessment.strengths],
                ['Риски', reply.assessment.risks],
                ['Что уточнить до решения', reply.assessment.questions],
              ] as [string, string[]][]
            ).map(([title, list]) =>
              list.length ? (
                <div key={title}>
                  <h4>{title}</h4>
                  <ul>
                    {list.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
            <p className="quick-foot">
              Оценивалось {reply.subject === 'decision' ? 'принятое решение' : 'предложение: решение ещё не принято'}. Модель {reply.model}. {reply.note}
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** The state «отложено до …» for everyone, and the two actions for the person who decides. */
export function DeferControl({ item, f, onChanged }: { item: Pick<IdeaDetail, 'number' | 'deferral'>; f: Pick<Facts, 'defer' | 'decider'>; onChanged: () => void }) {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number | 'date'>(7);
  const [date, setDate] = useState(isoDay(7));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const until = days === 'date' ? date : isoDay(days);
  const d: Deferral | null = item.deferral;
  const send = async (path: 'defer' | 'resume') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/orgs/${s.org}/ideas/${item.number}/${path}`, path === 'defer' ? { json: { until, reason: reason.trim() } } : { method: 'POST' });
      setOpen(false);
      setReason('');
      onChanged();
    } catch (e) {
      setError((e as { message?: string }).message ?? 'Не получилось. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };
  if (d)
    return (
      <div className="defer-box" data-state="on">
        <p className="quick-note" data-kind="paused" role="status">
          <b>Решение отложено до {dateWord(d.until)}.</b> {d.reason}
          {d.by ? ` — ${d.by}.` : ''} Срок решения на паузе.
        </p>
        {f.decider ? (
          <button type="button" className="quick-btn" disabled={busy} onClick={() => void send('resume')}>
            Вернуть в работу сейчас
          </button>
        ) : null}
        {error ? <p className="quick-note" data-kind="warn" role="alert">{error}</p> : null}
      </div>
    );
  if (!f.defer) return null;
  if (!open)
    return (
      <button type="button" className="quick-btn" onClick={() => setOpen(true)}>
        Отложить решение
      </button>
    );
  const short = reason.trim().length < 10;
  return (
    <form
      className="defer-box"
      data-state="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!short) void send('defer');
      }}
    >
      <fieldset>
        <legend>На сколько отложить</legend>
        <div className="defer-days">
          {(
            [
              [3, '3 дня'],
              [7, 'Неделя'],
              [30, 'Месяц'],
              ['date', 'Дата…'],
            ] as [number | 'date', string][]
          ).map(([v, label]) => (
            <label key={String(v)} data-on={days === v ? 'yes' : 'no'}>
              <input type="radio" name="defer-days" checked={days === v} onChange={() => setDays(v)} />
              {label}
            </label>
          ))}
        </div>
        {days === 'date' ? <input type="date" aria-label="Отложить до даты" value={date} min={isoDay(1)} max={isoDay(180)} onChange={(e) => setDate(e.target.value)} required /> : null}
      </fieldset>
      <label className="defer-reason">
        Что сказать автору
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} placeholder="Например: ждём поставку оборудования, вернёмся после приёмки" required />
      </label>
      {error ? <p className="quick-note" data-kind="warn" role="alert">{error}</p> : null}
      <div className="defer-actions">
        <button type="submit" className="quick-btn" data-primary="yes" disabled={busy || short}>
          {busy ? 'Откладываем…' : `Отложить до ${dateWord(until)}`}
        </button>
        <button type="button" className="quick-btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
      </div>
      <p className="quick-foot">Автор увидит дату и причину. Срок решения встанет на паузу до этой даты.</p>
    </form>
  );
}
