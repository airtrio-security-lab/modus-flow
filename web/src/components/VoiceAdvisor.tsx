import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, errorText } from '../lib/api';
import { useSession } from '../lib/session';
import { createRealtimeTransport, type RealtimeTransport, type VoiceState } from '../lib/realtimeTransport';
import {
  askAdvisorText,
  endVoiceSession,
  relayOffer,
  rememberedLanguage,
  rememberLanguage,
  runVoiceTool,
  startVoiceSession,
  voiceStatus,
  type AskReply,
  type VoiceContextRef,
  type VoiceLanguage,
  type VoiceProposal,
  type VoiceRef,
  type VoiceStatus,
} from '../lib/voiceAdvisor';
import './voice-advisor.css';

/**
 * «Спросить советника» (ADR-0042). Two modes that never mix with a third:
 *  - «Поговорить»: a live voice conversation (OpenAI Realtime over WebRTC). Not recorded, not stored.
 *  - «Текстом»: the same server tools, answered by the existing MODUS ADVISOR model if one is connected.
 *  - Recording a meeting is a separate screen with everyone's consent (link only).
 * Facts come only from MODUS FLOW tools run on the server with the employee's rights. Anything that
 * would change data is a card here that the employee confirms with a button.
 */
interface Turn {
  id: number;
  who: 'user' | 'advisor' | 'system';
  text: string;
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Готов к разговору',
  requesting_mic: 'Включаем микрофон…',
  connecting: 'Подключаемся…',
  listening: 'Слушаю',
  user_speaking: 'Слушаю',
  thinking: 'Думаю',
  speaking: 'Отвечаю',
  ended: 'Разговор завершён',
  error: 'Нет связи',
};
const LIVE: VoiceState[] = ['requesting_mic', 'connecting', 'listening', 'user_speaking', 'thinking', 'speaking'];

interface Ctx {
  open: (context?: VoiceContextRef) => void;
}
const VoiceCtx = createContext<Ctx | null>(null);
export const useVoiceAdvisor = () => useContext(VoiceCtx);

export function VoiceAdvisorProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<VoiceContextRef | undefined>(undefined);
  const value: Ctx = {
    open: (c) => {
      setContext(c);
      setOpen(true);
    },
  };
  return (
    <VoiceCtx.Provider value={value}>
      {children}
      {!open ? (
        <button type="button" className="va-fab" onClick={() => value.open(undefined)} aria-haspopup="dialog">
          <MicGlyph />
          <span>Спросить советника</span>
        </button>
      ) : (
        <AdvisorPanel context={context} onClose={() => setOpen(false)} onClearContext={() => setContext(undefined)} />
      )}
    </VoiceCtx.Provider>
  );
}

/** At the round table: opens the advisor about this item. The advisor does not vote and does not decide. */
export function AskAdvisorAtTable({ number }: { number: number }) {
  const v = useVoiceAdvisor();
  if (!v) return null;
  return (
    <button type="button" className="btn va-table-btn" onClick={() => v.open({ kind: 'council', number })}>
      <MicGlyph /> Спросить советника о вопросе №{number}
    </button>
  );
}

function MicGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function AdvisorPanel({ context, onClose, onClearContext }: { context?: VoiceContextRef; onClose: () => void; onClearContext: () => void }) {
  const s = useSession();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [mode, setMode] = useState<'talk' | 'text'>('talk');
  const [language, setLanguage] = useState<VoiceLanguage>(rememberedLanguage());
  const [state, setState] = useState<VoiceState>('idle');
  const [muted, setMuted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draftAnswer, setDraftAnswer] = useState('');
  const [refs, setRefs] = useState<VoiceRef[]>([]);
  const [proposals, setProposals] = useState<(VoiceProposal & { key: number; done?: string })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(0);
  const transport = useRef<RealtimeTransport | null>(null);
  const session = useRef<string | null>(null);
  const seq = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(() => {
    setStatusError(null);
    voiceStatus(s.org)
      .then((st) => {
        setStatus(st);
        if (!st.voice.configured) setMode('text');
      })
      .catch((e) => setStatusError(errorText(e)));
  }, [s.org]);
  useEffect(loadStatus, [loadStatus]);
  useEffect(() => panelRef.current?.focus(), []);

  const addTurn = (who: Turn['who'], text: string) => setTurns((t) => [...t.slice(-30), { id: ++seq.current, who, text }]);
  const addRefs = (list: VoiceRef[]) => setRefs((r) => [...list.filter((x) => !r.some((y) => y.href === x.href)), ...r].slice(0, 12));

  const hangUp = useCallback((reason = 'ended') => {
    transport.current?.stop(reason);
    transport.current = null;
    if (session.current) void endVoiceSession(s.org, session.current);
    session.current = null;
    setMuted(false);
  }, [s.org]);

  // Leaving the page or closing the panel always ends the conversation and frees the microphone.
  useEffect(() => {
    const onHide = () => hangUp('page_hidden');
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      hangUp('panel_closed');
    };
  }, [hangUp]);

  // The conversation clock; the server enforces the same limit on its side.
  const liveNow = LIVE.includes(state);
  useEffect(() => {
    if (!liveNow || !maxSeconds) return;
    const t0 = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      setElapsed(sec);
      if (sec >= maxSeconds) {
        addTurn('system', 'Время разговора истекло. Начните новый, если нужно.');
        hangUp('time_limit');
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [liveNow, maxSeconds, hangUp]);

  async function startTalk() {
    hangUp('restart');
    setError(null);
    setElapsed(0);
    setDraftAnswer('');
    // The server session (and the paid short-lived secret) is created only after the microphone is
    // allowed: the transport calls negotiate() once it has the microphone.
    let sid: string | null = null;
    const t = createRealtimeTransport({
      negotiate: async (offer) => {
        const started = await startVoiceSession(s.org, language, context);
        sid = started.sessionId;
        session.current = sid;
        setMaxSeconds(started.maxSeconds);
        return relayOffer(s.org, sid, offer);
      },
      events: {
        onState: (st) => setState(st),
        onUserText: (text) => addTurn('user', text),
        onAssistantText: (text, final) => {
          if (final) {
            setDraftAnswer('');
            addTurn('advisor', text);
          } else setDraftAnswer(text);
        },
        onToolCall: async (call) => {
          try {
            if (!sid) throw new Error('Голосовая сессия не начата');
            const r = await runVoiceTool(s.org, sid, call.name, call.arguments, call.callId);
            addRefs(r.refs);
            const p = r.proposal;
            if (p) setProposals((list) => [...list, { ...p, key: ++seq.current }]);
            return r;
          } catch (e) {
            // The model hears the real error and must say it; nothing pretends to have worked.
            return { error: true, message: errorText(e) };
          }
        },
        onError: (_code, message) => setError(message),
        onClosed: () => {
          // Any end — error, lost connection, the employee — frees the server session at once.
          if (sid && session.current === sid) {
            void endVoiceSession(s.org, sid);
            session.current = null;
          }
        },
      },
    });
    transport.current = t;
    await t.start();
  }

  function toggleMute() {
    if (!transport.current) return;
    setMuted(transport.current.setMuted(!muted));
  }

  const live = LIVE.includes(state);
  const voiceReady = !!status?.voice.configured;
  const lastQuestion = [...turns].reverse().find((t) => t.who === 'user')?.text;
  const lastAnswer = draftAnswer || [...turns].reverse().find((t) => t.who === 'advisor')?.text;
  const mmss = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

  return (
    <div className="va" role="dialog" aria-modal="false" aria-labelledby="va-title" ref={panelRef} tabIndex={-1} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header className="va-head">
        <div>
          <h2 id="va-title">Советник</h2>
          <p className="va-sub">
            {context ? (
              <>
                За круглым столом · вопрос №{context.number}{' '}
                <button type="button" className="va-link" onClick={onClearContext} disabled={live}>
                  общий режим
                </button>
              </>
            ) : (
              'Отвечает по данным MODUS FLOW, доступным вам'
            )}
          </p>
        </div>
        <button type="button" className="va-icon" onClick={onClose} aria-label="Закрыть панель советника (разговор завершится)">
          ×
        </button>
      </header>

      <div className="va-tabs" role="tablist" aria-label="Режим">
        <button type="button" role="tab" aria-selected={mode === 'talk'} onClick={() => setMode('talk')}>
          Поговорить
        </button>
        <button type="button" role="tab" aria-selected={mode === 'text'} onClick={() => setMode('text')} disabled={live}>
          Текстом
        </button>
        <a className="va-rec" href="#/meetings/new" title="Отдельный режим: запись с согласия всех участников, расшифровка и подтверждение задач человеком">
          Записать совещание →
        </a>
      </div>

      <div className="va-body">
        {statusError ? (
          <div className="va-notice error">
            {statusError}{' '}
            <button type="button" className="va-link" onClick={loadStatus}>
              Повторить
            </button>
          </div>
        ) : !status ? (
          <p className="va-muted">Проверяем, что подключено…</p>
        ) : mode === 'talk' ? (
          voiceReady ? (
            <>
              <div className={`va-stage is-${state}${muted ? ' is-muted' : ''}`}>
                <SpeechIndicator state={state} muted={muted} />
                <div className="va-state" role="status" aria-live="polite">
                  {muted && live ? 'Микрофон выключен' : STATE_LABEL[state]}
                  {live && maxSeconds ? <span className="va-clock"> · {mmss(elapsed)} / {mmss(maxSeconds)}</span> : null}
                </div>
              </div>
              {lastQuestion ? (
                <p className="va-q">
                  <span>Вы:</span> {lastQuestion}
                </p>
              ) : null}
              {lastAnswer ? (
                <p className="va-a" aria-live="polite">
                  <span>Советник:</span> {lastAnswer}
                </p>
              ) : null}
              {error ? <div className="va-notice error">{error}</div> : null}
              <div className="va-controls">
                {!live ? (
                  <>
                    <label className="va-lang">
                      Язык
                      <select
                        value={language}
                        onChange={(e) => {
                          const l = e.target.value === 'kk' ? 'kk' : 'ru';
                          setLanguage(l);
                          rememberLanguage(l);
                        }}
                      >
                        <option value="ru">Русский</option>
                        <option value="kk">Қазақша</option>
                      </select>
                    </label>
                    <button type="button" className="va-primary" onClick={() => void startTalk()}>
                      <MicGlyph /> {state === 'error' || state === 'ended' ? 'Переподключить' : 'Начать разговор'}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="va-btn" onClick={toggleMute} aria-pressed={muted}>
                      {muted ? 'Включить микрофон' : 'Выключить микрофон'}
                    </button>
                    <button type="button" className="va-btn" onClick={() => transport.current?.interrupt()} disabled={state !== 'speaking' && state !== 'thinking'}>
                      Перебить
                    </button>
                    <button type="button" className="va-danger" onClick={() => hangUp('ended_by_user')}>
                      Завершить
                    </button>
                  </>
                )}
              </div>
              <p className="va-fine">
                {status.voice.provider} · {status.voice.model} · голос «{status.voice.voice}» (синтетический). Голос и найденные факты уходят в OpenAI на время разговора; разговор не записывается и не
                сохраняется.
              </p>
            </>
          ) : (
            <div className="va-off">
              <p className="va-off-title">Голосовой AI не подключён</p>
              <p className="va-muted">
                Живой разговор появится, когда администратор подключит голосовой сервис. Пока можно спросить советника текстом
                {status.text.configured ? '.' : ' — без языковой модели будут показаны найденные записи без пересказа.'}
              </p>
              <button type="button" className="va-btn" onClick={() => setMode('text')}>
                Спросить текстом
              </button>
            </div>
          )
        ) : (
          <TextMode status={status} language={language} context={context} onRefs={addRefs} onTurn={addTurn} />
        )}

        {proposals.map((p) => (
          <ProposalCard key={p.key} p={p} onDone={(done) => setProposals((list) => list.map((x) => (x.key === p.key ? { ...x, done } : x)))} />
        ))}

        {refs.length ? (
          <nav className="va-refs" aria-label="Найденные записи">
            <h3>Найдено в MODUS FLOW за этот разговор</h3>
            <ul>
              {refs.map((r) => (
                <li key={r.href}>
                  <a href={r.href}>
                    <span className="va-ref-kind">{r.type === 'meeting' ? 'Совещание' : r.type === 'council' ? `Совет №${r.id}` : `№${r.id}`}</span> {r.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        {turns.length ? (
          <details className="va-history">
            <summary>История разговора ({turns.length})</summary>
            <ol>
              {turns.map((t) => (
                <li key={t.id} className={`va-turn ${t.who}`}>
                  <b>{t.who === 'user' ? 'Вы' : t.who === 'advisor' ? 'Советник' : 'Система'}:</b> {t.text}
                </li>
              ))}
            </ol>
            <p className="va-fine">История видна только здесь, пока открыта панель.</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function SpeechIndicator({ state, muted }: { state: VoiceState; muted: boolean }) {
  return (
    <div className="va-meter" aria-hidden="true" data-state={muted ? 'muted' : state}>
      <i />
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}

function TextMode({ status, language, context, onRefs, onTurn }: { status: VoiceStatus; language: VoiceLanguage; context?: VoiceContextRef; onRefs: (r: VoiceRef[]) => void; onTurn: (who: Turn['who'], text: string) => void }) {
  const s = useSession();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<AskReply | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (q.trim().length < 3 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await askAdvisorText(s.org, q.trim(), language, context);
      setReply(r);
      onRefs(r.refs);
      onTurn('user', q.trim());
      if (r.answer) onTurn('advisor', r.answer);
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="va-text">
      <form onSubmit={(e) => void submit(e)}>
        <label htmlFor="va-q" className="va-muted">
          Вопрос о ваших задачах, обращениях и решениях
        </label>
        <div className="va-row">
          <input id="va-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Что сегодня требует моего внимания?" maxLength={600} autoComplete="off" />
          <button type="submit" className="va-primary" disabled={busy || q.trim().length < 3}>
            {busy ? 'Ищем…' : 'Спросить'}
          </button>
        </div>
      </form>
      <p className="va-fine">
        {status.text.configured ? `Ответ составляет ${status.text.label}${status.text.remote ? ' — текст фактов уходит за пределы компании' : ''}.` : 'Языковая модель не подключена: советник покажет найденные записи без пересказа.'}
      </p>
      {err ? <div className="va-notice error">{err}</div> : null}
      {reply ? (
        reply.answer ? (
          <div className="va-a">
            <span>Советник ({reply.model}):</span> {reply.answer}
          </div>
        ) : (
          <div className="va-facts">
            {status.text.configured ? <p className="va-muted">{reply.note}</p> : null}
            {reply.found === 0 ? (
              <p>В доступных вам данных MODUS FLOW ничего не нашлось.</p>
            ) : (
              <p>Найдено записей: {reply.found}.{reply.refs.length ? ' Откройте их ниже.' : ' Ссылок на обращения среди них нет.'}</p>
            )}
          </div>
        )
      ) : null}
      {reply?.errors.length ? <p className="va-fine">{reply.errors.map((x) => x.message).join(' · ')}</p> : null}
    </div>
  );
}

function ProposalCard({ p, onDone }: { p: VoiceProposal & { done?: string }; onDone: (msg: string) => void }) {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (p.kind === 'council_question') {
    return (
      <section className="va-card" aria-label="Черновик вопроса для Совета">
        <h3>Черновик вопроса для Совета · не отправлен</h3>
        <p>{p.text}</p>
        {p.done ? (
          <p className="va-ok">{p.done}</p>
        ) : (
          <div className="va-row">
            <button
              type="button"
              className="va-btn"
              onClick={() => {
                void navigator.clipboard?.writeText(p.text).catch(() => undefined);
                onDone('Текст скопирован. Внесите его в Совет сами на экране обращения.');
              }}
            >
              Скопировать
            </button>
            {p.number ? (
              <a className="va-btn" href={`#/council/${p.number}`}>
                К круглому столу №{p.number}
              </a>
            ) : null}
          </div>
        )}
      </section>
    );
  }
  async function save() {
    if (p.kind !== 'lab_draft') return;
    setBusy(true);
    setErr(null);
    try {
      await api('/lab/drafts', { json: p.draft });
      onDone('Черновик сохранён в личной лаборатории — его видите только вы.');
      s.toast('Черновик сохранён');
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="va-card" aria-label="Черновик инициативы">
      <h3>Черновик {p.draft.kind === 'problem' ? 'проблемы' : 'предложения'} · не сохранён</h3>
      <p>
        <b>{p.draft.title}</b>
      </p>
      {Object.entries(p.draft.content).map(([k, v]) => (
        <p key={k} className="va-muted">
          {k === 'observation' ? 'Наблюдение' : k === 'proposal' ? 'Предложение' : k === 'risks' ? 'Риски' : k}: {v}
        </p>
      ))}
      {p.done ? (
        <p className="va-ok">{p.done}</p>
      ) : (
        <div className="va-row">
          <button type="button" className="va-primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить черновик'}
          </button>
          <button type="button" className="va-btn" onClick={() => onDone('Черновик отброшен.')}>
            Отбросить
          </button>
        </div>
      )}
      {err ? <div className="va-notice error">{err}</div> : null}
    </section>
  );
}
