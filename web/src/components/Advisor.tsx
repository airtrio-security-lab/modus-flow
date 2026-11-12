import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import type { AdvisorStatus, ExecutorView } from '../lib/types';

/**
 * MODUS ADVISOR at the Council table (ADR-0013). It proposes; people decide.
 * The label always says how the proposal was made: without a connected model
 * it is «по анкетам, без ИИ» — rules, not artificial intelligence.
 */
export function useAdvisorStatus() {
  const s = useSession();
  return useLoad(() => api<AdvisorStatus>(`/orgs/${s.org}/advisor/status`), [s.org]).data;
}

export function advisorMethodLine(st: AdvisorStatus | null): string {
  if (!st) return 'Помощник Совета';
  return st.model.configured && st.model.reachable ? `${st.model.remote ? 'Облачная' : 'Локальная'} модель ${st.model.model}` : 'Правила, без ИИ';
}

export function AdvisorPanel({ number, leads, onDone }: { number: number; leads: boolean; onDone: (t: string) => Promise<void> }) {
  const s = useSession();
  const status = useAdvisorStatus();
  const { data, error, reload } = useLoad<ExecutorView | null>(
    () => (leads ? api<ExecutorView>(`/orgs/${s.org}/ideas/${number}/executors`) : Promise.resolve(null)),
    [s.org, number, leads],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function confirm(candidate: string, reasons: string[], name: string) {
    setBusy(candidate);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/ideas/${number}/executors`, { json: { candidate, reasons } });
      await reload();
      await onDone(`Исполнитель подтверждён: ${name}. Назначит его ответственный в решении`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const confirmed = new Set(data?.confirmed.map((c) => c.candidate));
  return (
    <section className="panel stack advisor" id="advisor" aria-labelledby="advisor-h" tabIndex={-1}>
      <div className="spread">
        <h2 id="advisor-h" className="section-title">
          Помощник Совета
        </h2>
        <span className="advisor-method">{advisorMethodLine(status)}</span>
      </div>
      <p className="small muted">
        Подбирает исполнителей по анкетам сотрудников и их текущей загрузке и объясняет почему. Не голосует, не решает и не начисляет опыт.
        {status && !status.model.configured ? ' Языковая модель не подключена.' : ''}
      </p>
      {!leads ? (
        <p className="small">Подбор видят ведущий обращения и ответственный за решение.</p>
      ) : error ? (
        <p className="notice error">{errorText(error)}</p>
      ) : !data ? (
        <p className="small muted">Подбираем…</p>
      ) : (
        <>
          {data.suggestions.length ? (
            <ol className="advisor-list">
              {data.suggestions.map((x) => (
                <li key={x.membershipId}>
                  <div className="spread">
                    <b>
                      {x.name}
                      {x.jobTitle ? <span className="muted">, {x.jobTitle}</span> : null}
                    </b>
                    {confirmed.has(x.membershipId) ? (
                      <span className="seat-pill tone-pro">подтверждён</span>
                    ) : data.canConfirm ? (
                      <button type="button" className="btn small" disabled={!!busy} onClick={() => void confirm(x.membershipId, x.reasons, x.name)}>
                        {busy === x.membershipId ? 'Подтверждаем…' : 'Подтвердить'}
                      </button>
                    ) : null}
                  </div>
                  <ul className="small advisor-reasons">
                    {x.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small">
              {data.profiles
                ? 'Ни у кого в анкетах нет навыков, которые встречаются в тексте обращения. Исполнителя выберите сами.'
                : 'Анкет пока нет: сотрудники заполняют их в «Моём профиле».'}
            </p>
          )}
          {data.confirmed.length ? (
            <p className="small">
              Подтверждено: {data.confirmed.map((c) => `${c.name} (${c.confirmedBy})`).join(', ')}. Окончательно назначает ответственный в решении.
            </p>
          ) : null}
          <p className="small muted">{data.explanation}</p>
          {err ? <p className="notice error">{err}</p> : null}
        </>
      )}
    </section>
  );
}
