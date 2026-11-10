import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, newKey } from '../lib/api';
import { dateTime, due } from '../lib/format';
import { useRemembered } from '../lib/remember';
import { useLoad, useSession } from '../lib/session';
import { STATUS } from '../lib/status';
import type { CouncilEntry, CouncilListRow, CouncilRole, CouncilSeat, CouncilView, Recommendation, Stance } from '../lib/types';
import { ErrorBox, Loading, PageHead, StatusChip } from '../components/ui';

/**
 * «Совет королевства» — the round table (owner brief 2026-11-11, ADR-0012).
 * Not decoration: every seat is a real participant with a real role, choosing
 * a seat opens their position, and every action lives in the readable panel on
 * the right (never inside an animation). Recommendations are advice; the
 * decision stays with the decision owner named on the page. Many participants
 * or a narrow screen switch the circle to a compact list.
 */

export const ROLE_LABEL: Record<CouncilRole, string> = {
  initiator: 'Инициатор',
  recorded: 'Записал(а) вопрос',
  maintainer: 'Ведёт',
  decision_owner: 'Решает',
  implementer: 'Внедряет',
  department_head: 'Глава подразделения',
  pilot_owner: 'Ведёт пилот',
  member: 'Участник',
};
const REC_LABEL: Record<Recommendation, string> = {
  implement: 'Внедрить',
  pilot: 'Направить на пилот',
  clarify: 'Запросить уточнение',
  reject: 'Отклонить',
  rework: 'Доработать',
};
const STANCE: Record<Stance, { short: string; long: string; tone: 'pro' | 'con' | 'mid' | 'none' | 'dis' }> = {
  for: { short: 'за', long: 'приводит доводы за', tone: 'pro' },
  against: { short: 'против', long: 'приводит доводы против', tone: 'con' },
  mixed: { short: 'за и против', long: 'приводит доводы за и против', tone: 'mid' },
  none: { short: 'без позиции', long: 'позицию не высказал(а)', tone: 'none' },
  dissent: { short: 'разногласие', long: 'зафиксировал(а) разногласие', tone: 'dis' },
  implement: { short: 'внедрить', long: 'рекомендует внедрить', tone: 'pro' },
  pilot: { short: 'пилот', long: 'рекомендует пилот', tone: 'mid' },
  clarify: { short: 'уточнить', long: 'просит уточнить', tone: 'mid' },
  reject: { short: 'отклонить', long: 'рекомендует отклонить', tone: 'con' },
  rework: { short: 'доработать', long: 'рекомендует доработать', tone: 'mid' },
};
const initials = (n: string) =>
  n
    .split(/\s+/)
    .slice(0, 2)
    .map((x) => x[0] ?? '')
    .join('')
    .toUpperCase();
const roleLine = (s: CouncilSeat) =>
  s.roles.map((r) => (r === 'department_head' && s.headOf.length ? `Глава: ${s.headOf.join(', ')}` : ROLE_LABEL[r])).join(', ');

// ---------------------------------------------------------------------------
// List of sessions
// ---------------------------------------------------------------------------
const GROUPS: { title: string; statuses: string[] }[] = [
  { title: 'Ждут решения', statuses: ['decision'] },
  { title: 'На пилоте', statuses: ['in_verification'] },
  { title: 'На рассмотрении', statuses: ['in_review', 'unrouted'] },
  { title: 'Ждут уточнения от автора', statuses: ['needs_info'] },
];

export function CouncilList() {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<CouncilListRow[]>(`/orgs/${s.org}/council`), [s.org]);
  const [scope, setScope] = useRemembered<'all' | 'decide' | 'lead'>('council.scope', 'all');
  const rows = (data ?? []).filter((r) => scope === 'all' || (scope === 'decide' ? r.iDecide : r.iLead));
  return (
    <div className="stack-lg">
      <PageHead title="Совет королевства" sub="Здесь обсуждают обращения: аргументы за и против, рекомендации — и решение того, кто за него отвечает.">
        {s.isLead ? (
          <div className="segmented" role="group" aria-label="Какие заседания">
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              Все
            </button>
            <button type="button" aria-pressed={scope === 'decide'} onClick={() => setScope('decide')}>
              Мне решать
            </button>
            <button type="button" aria-pressed={scope === 'lead'} onClick={() => setScope('lead')}>
              Я веду
            </button>
          </div>
        ) : null}
      </PageHead>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading rows={4} /> : null}
      {data && !rows.length ? <div className="empty">Сейчас на Совете нет обращений{scope !== 'all' ? ' по этому фильтру' : ''}.</div> : null}
      {GROUPS.map((g) => {
        const list = rows.filter((r) => g.statuses.includes(r.status));
        if (!list.length) return null;
        return (
          <section key={g.title} className="stack" aria-labelledby={`cg-${g.title}`}>
            <h2 id={`cg-${g.title}`} className="section-title">
              {g.title} ({list.length})
            </h2>
            <ul className="council-list">
              {list.map((r) => {
                const d = due(r.resolutionDueAt);
                return (
                  <li key={r.number}>
                    <a href={`#/council/${r.number}`}>
                      <span className="num">Обращение №{r.number}</span>
                      <span className="title">{r.title}</span>
                      <span className="meta">
                        <span>Инициатор: {r.initiator}</span>
                        <span>{r.decisionOwner ? `Решает: ${r.decisionOwner}` : 'Ответственный за решение не назначен'}</span>
                        {r.department ? <span>{r.department}</span> : null}
                      </span>
                      <span className="meta">
                        <span>
                          Аргументов за: {r.for}, против: {r.against}
                        </span>
                        <span>Рекомендаций: {r.recommendations}</span>
                        {r.dissent ? <span>Разногласий: {r.dissent}</span> : null}
                        {d ? <span className={d.late ? 'flag red' : ''}>Срок решения {d.text}</span> : null}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The round table
// ---------------------------------------------------------------------------
/** Width of an element that may appear after loading (callback ref, so it is measured whenever it mounts). */
function useWidth() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 800));
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(e?.contentRect.width ?? 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, w };
}

export function RoundTable({ number }: { number: number }) {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<CouncilView>(`/orgs/${s.org}/ideas/${number}/council`), [s.org, number]);
  const [seat, setSeat] = useState<string | null>(null);
  const { ref, w } = useWidth();
  const done = async (text: string) => {
    s.toast(text);
    await reload();
    void s.refreshInbox();
  };

  if (error) return <ErrorBox error={error} retry={() => void reload()} />;
  if (loading && !data) return <Loading label="Собираем Совет…" />;
  if (!data) return null;
  const it = data.item;
  const open = data.can.argue;
  const compact = data.seats.length > 10 || w < 560;
  const selected = data.seats.find((x) => x.membershipId === seat) ?? null;
  const resolution = due(it.resolutionDueAt);

  return (
    <div className="stack-lg">
      <PageHead title={`Совет: обращение №${it.number}`} sub={it.title}>
        <a className="btn" href={`#/items/${it.number}`}>
          Карточка обращения
        </a>
      </PageHead>

      <section className="council-status panel">
        <div>
          <span className="label">Статус</span>
          <StatusChip status={it.status} />
        </div>
        <div>
          <span className="label">Решает</span>
          <b>{it.decisionOwner ?? 'не назначен'}</b>
        </div>
        <div>
          <span className="label">Ведёт</span>
          <b>{it.maintainer ?? 'не назначен'}</b>
        </div>
        <div>
          <span className="label">Срок решения</span>
          <b className={resolution?.late ? 'flag red' : ''}>{resolution ? resolution.text : 'не задан'}</b>
        </div>
        <p className="small muted council-note">
          Рекомендации Совета — это совет, а не решение. Решение принимает {it.decisionOwner ?? 'ответственный за решение'}; оно записывается в
          карточку и в журнал.
        </p>
      </section>

      <div className="council">
        <div className="council-scene" ref={ref}>
          {compact ? (
            <SeatList seats={data.seats} selected={seat} onSelect={setSeat} />
          ) : (
            <TableScene view={data} selected={seat} onSelect={setSeat} />
          )}
          <Journal view={data} />
        </div>

        <aside className="council-panel stack" aria-label="Обсуждение и действия">
          {selected ? <Position seat={selected} entries={data.entries.filter((e) => e.authorMembershipId === selected.membershipId)} onClose={() => setSeat(null)} /> : null}

          <section className="panel stack">
            <h2 className="section-title">Предмет обсуждения</h2>
            <p className="council-subject">{it.problem}</p>
            {it.proposal ? (
              <p className="small">
                <b>Предложение: </b>
                {it.proposal}
              </p>
            ) : null}
            <p className="small muted">
              Инициатор: {it.raisedBy ?? it.author}
              {it.raisedBy ? ` (записал(а) ${it.author})` : ''}
              {it.department ? `, ${it.department}` : ''}
            </p>
          </section>

          <Arguments entries={data.entries} />

          {open ? (
            <ArgueForm number={it.number} canRecommend={data.can.recommend} onDone={done} />
          ) : (
            <p className="notice">Обсуждение закрыто: по обращению уже принято решение.</p>
          )}

          <ResponsibleActions view={data} onDone={done} />

          <section className="panel stack">
            <h2 className="section-title">Похожие обращения</h2>
            {data.similar.length ? (
              <ul className="realm-envoys">
                {data.similar.map((x) => (
                  <li key={x.number}>
                    <a href={`#/items/${x.number}`}>
                      <span className="num">Обращение №{x.number}</span> {x.title}
                    </a>
                    <StatusChip status={x.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">Похожих по названию нет.</p>
            )}
            <p className="small muted">Найдены поиском по совпадению текста. ИИ-советник в этой версии не подключён.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TableScene({ view, selected, onSelect }: { view: CouncilView; selected: string | null; onSelect: (id: string | null) => void }) {
  const W = 760;
  const H = 660;
  const cx = W / 2;
  const cy = H / 2 + 6;
  const n = view.seats.length;
  const title = view.item.title.length > 30 ? `${view.item.title.slice(0, 29)}…` : view.item.title;
  return (
    <svg className="table-scene" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Круглый стол: ${n} участников. Выберите участника, чтобы увидеть его позицию.`}>
      <defs>
        <radialGradient id="tbl-wood" cx="45%" cy="40%" r="70%">
          <stop offset="0%" stopColor="#a0703f" />
          <stop offset="100%" stopColor="#6e4523" />
        </radialGradient>
        <radialGradient id="tbl-floor" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="#ece6da" />
          <stop offset="100%" stopColor="#d9d1c1" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} rx="14" fill="url(#tbl-floor)" />
      <ellipse cx={cx} cy={cy + 14} rx="168" ry="104" fill="#3a2a1a" opacity="0.18" />
      <ellipse cx={cx} cy={cy} rx="168" ry="102" fill="#5a3a1e" />
      <ellipse cx={cx} cy={cy - 6} rx="162" ry="96" fill="url(#tbl-wood)" stroke="#4a2f17" strokeWidth="2" />
      <ellipse cx={cx} cy={cy - 6} rx="142" ry="80" fill="none" stroke="#c9a46c" strokeOpacity="0.5" strokeWidth="1.5" />
      <g aria-hidden="true">
        <rect x={cx - 132} y={cy - 46} width="264" height="80" rx="8" fill="#f3ead4" stroke="#9c8661" strokeWidth="1.5" />
        <text x={cx} y={cy - 18} textAnchor="middle" className="tbl-num">
          Обращение №{view.item.number}
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" className="tbl-title">
          {title}
        </text>
        <text x={cx} y={cy + 26} textAnchor="middle" className="tbl-sub">
          {STATUS[view.item.status].label}
        </text>
      </g>
      {view.seats.map((seat, i) => {
        const a = ((-90 + (360 * i) / n) * Math.PI) / 180;
        const x = cx + 286 * Math.cos(a);
        const y = cy - 34 + 216 * Math.sin(a);
        return <SeatMark key={seat.membershipId} seat={seat} x={x} y={y} selected={selected === seat.membershipId} onSelect={() => onSelect(selected === seat.membershipId ? null : seat.membershipId)} />;
      })}
    </svg>
  );
}

function SeatMark({ seat, x, y, selected, onSelect }: { seat: CouncilSeat; x: number; y: number; selected: boolean; onSelect: () => void }) {
  const initiator = seat.roles.includes('initiator');
  const decider = seat.roles.includes('decision_owner');
  const st = STANCE[seat.stance];
  const role = seat.roles[0] === 'department_head' && seat.headOf.length ? `Глава: ${seat.headOf[0]}` : ROLE_LABEL[seat.roles[0]!];
  const label = `${seat.name}, ${roleLine(seat)}: ${st.long}`;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };
  const [first, last] = seat.name.split(' ');
  const short = last ? `${first} ${last[0]}.` : first!;
  return (
    <g
      transform={`translate(${x},${y})`}
      className={`seat${selected ? ' is-selected' : ''}${initiator ? ' is-initiator' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={label}
      onClick={onSelect}
      onKeyDown={onKey}
    >
      <title>{label}</title>
      <rect x="-26" y="-34" width="52" height="40" rx="10" className="seat-chair" />
      <circle r="22" cy="-10" className="seat-avatar" />
      <text y="-4" textAnchor="middle" className="seat-initials">
        {initials(seat.name)}
      </text>
      {decider ? (
        <path d="M-12,-40 l5,-9 l7,6 l7,-6 l5,9 z" className="seat-crown" aria-hidden="true" />
      ) : null}
      <rect x="-84" y="16" width="168" height="52" rx="8" className="seat-plate" />
      <text y="37" textAnchor="middle" className="seat-name">
        {short.length > 18 ? `${short.slice(0, 17)}…` : short}
      </text>
      <text y="58" textAnchor="middle" className="seat-role">
        {role.length > 21 ? `${role.slice(0, 20)}…` : role}
      </text>
      <g transform="translate(0, 82)">
        <rect x="-48" y="-13" width="96" height="26" rx="13" className={`seat-stance tone-${st.tone}`} />
        <text y="5.5" textAnchor="middle" className="seat-stance-text">
          {st.short}
        </text>
      </g>
    </g>
  );
}

function SeatList({ seats, selected, onSelect }: { seats: CouncilSeat[]; selected: string | null; onSelect: (id: string | null) => void }) {
  return (
    <ul className="seat-list" aria-label="Участники Совета">
      {seats.map((s) => {
        const st = STANCE[s.stance];
        return (
          <li key={s.membershipId}>
            <button type="button" aria-pressed={selected === s.membershipId} onClick={() => onSelect(selected === s.membershipId ? null : s.membershipId)}>
              <span className={`seat-dot${s.roles.includes('initiator') ? ' is-initiator' : ''}`} aria-hidden="true">
                {initials(s.name)}
              </span>
              <span className="seat-list-main">
                <b>{s.name}</b>
                <span className="small muted">{roleLine(s)}</span>
              </span>
              <span className={`seat-pill tone-${st.tone}`}>{st.short}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Position({ seat, entries, onClose }: { seat: CouncilSeat; entries: CouncilEntry[]; onClose: () => void }) {
  return (
    <section className="panel stack position" aria-label={`Позиция: ${seat.name}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="section-title" style={{ margin: 0 }}>
          Позиция: {seat.name}
        </h2>
        <button type="button" className="btn small quiet" onClick={onClose}>
          Закрыть
        </button>
      </div>
      <p className="small muted">
        {roleLine(seat)}
        {seat.jobTitle ? `, ${seat.jobTitle}` : ''}
      </p>
      <p>
        <span className={`seat-pill tone-${STANCE[seat.stance].tone}`}>{STANCE[seat.stance].long}</span>
      </p>
      {entries.length ? (
        <ul className="entries">
          {entries.map((e) => (
            <EntryRow key={e.id} e={e} showAuthor={false} />
          ))}
        </ul>
      ) : (
        <p className="small muted">Этот участник пока ничего не записал по обращению.</p>
      )}
    </section>
  );
}

function entryLabel(e: CouncilEntry): string {
  if (e.kind === 'argument_for') return 'За';
  if (e.kind === 'argument_against') return 'Против';
  if (e.kind === 'dissent') return 'Разногласие';
  if (e.kind === 'handoff') return 'Передано на решение';
  return `Рекомендация: ${REC_LABEL[e.recommendation!]}`;
}

function EntryRow({ e, showAuthor = true }: { e: CouncilEntry; showAuthor?: boolean }) {
  const tone = e.kind === 'argument_for' ? 'pro' : e.kind === 'argument_against' ? 'con' : e.kind === 'dissent' ? 'dis' : 'mid';
  return (
    <li className={`entry tone-${tone}`}>
      <span className="entry-kind">{entryLabel(e)}</span>
      <span className="entry-body">{e.body}</span>
      <span className="small muted">
        {showAuthor ? `${e.author}, ` : ''}
        {dateTime(e.createdAt)}
      </span>
    </li>
  );
}

function Arguments({ entries }: { entries: CouncilEntry[] }) {
  const pro = entries.filter((e) => e.kind === 'argument_for');
  const con = entries.filter((e) => e.kind === 'argument_against');
  const recs = entries.filter((e) => e.kind === 'recommendation' || e.kind === 'dissent');
  return (
    <section className="panel stack">
      <h2 className="section-title">Аргументы</h2>
      <div className="args">
        <div>
          <h3 className="args-h pro">За ({pro.length})</h3>
          {pro.length ? (
            <ul className="entries">
              {pro.map((e) => (
                <EntryRow key={e.id} e={e} />
              ))}
            </ul>
          ) : (
            <p className="small muted">Пока нет.</p>
          )}
        </div>
        <div>
          <h3 className="args-h con">Против ({con.length})</h3>
          {con.length ? (
            <ul className="entries">
              {con.map((e) => (
                <EntryRow key={e.id} e={e} />
              ))}
            </ul>
          ) : (
            <p className="small muted">Пока нет.</p>
          )}
        </div>
      </div>
      <h3 className="args-h">Рекомендации и разногласия ({recs.length})</h3>
      {recs.length ? (
        <ul className="entries">
          {recs.map((e) => (
            <EntryRow key={e.id} e={e} />
          ))}
        </ul>
      ) : (
        <p className="small muted">Рекомендаций пока нет.</p>
      )}
    </section>
  );
}

function useAction(onDone: (text: string) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const key = useRef(newKey());
  const run = async (path: string, json: unknown, okText: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(path, { method: 'POST', json, key: key.current });
      key.current = newKey();
      await onDone(okText);
      return true;
    } catch (e) {
      setErr(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

function ArgueForm({ number, canRecommend, onDone }: { number: number; canRecommend: boolean; onDone: (t: string) => Promise<void> }) {
  const s = useSession();
  const [kind, setKind] = useState<'argument_for' | 'argument_against' | 'recommendation' | 'dissent'>('argument_for');
  const [rec, setRec] = useState<Recommendation>('implement');
  const [body, setBody] = useState('');
  const { busy, err, run } = useAction(onDone);
  const needsReason = kind === 'recommendation' || kind === 'dissent';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      `/orgs/${s.org}/ideas/${number}/council/entries`,
      { kind, ...(kind === 'recommendation' ? { recommendation: rec } : {}), body: body.trim() },
      kind === 'recommendation' ? 'Рекомендация записана' : kind === 'dissent' ? 'Разногласие записано' : 'Аргумент добавлен',
    );
    if (ok) setBody('');
  };
  type K = typeof kind;
  const options: { id: K; label: string }[] = [
    { id: 'argument_for', label: 'Аргумент за' },
    { id: 'argument_against', label: 'Аргумент против' },
    ...(canRecommend
      ? ([
          { id: 'recommendation', label: 'Рекомендация' },
          { id: 'dissent', label: 'Разногласие' },
        ] as { id: K; label: string }[])
      : []),
  ];
  return (
    <form className="panel stack" onSubmit={submit} aria-labelledby="argue-h">
      <h2 id="argue-h" className="section-title">
        Ваше слово на Совете
      </h2>
      <div className="segmented wrap" role="radiogroup" aria-label="Что вы добавляете">
        {options.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={kind === o.id} aria-pressed={kind === o.id} onClick={() => setKind(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      {!canRecommend ? <p className="small muted">Автор приводит аргументы, а рекомендации дают другие участники Совета.</p> : null}
      {kind === 'recommendation' ? (
        <div className="field">
          <label htmlFor="rec">Рекомендация</label>
          <select id="rec" className="select" value={rec} onChange={(e) => setRec(e.target.value as Recommendation)}>
            {(Object.keys(REC_LABEL) as Recommendation[]).map((r) => (
              <option key={r} value={r}>
                {REC_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="argue-body">{needsReason ? 'Обоснование' : 'Ваш довод'}</label>
        <textarea id="argue-body" className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={3000} required minLength={needsReason ? 10 : 3} />
        {needsReason ? <span className="hint">Не меньше 10 символов: решающему важно понимать причину.</span> : null}
      </div>
      {err ? <ErrorBox error={err} /> : null}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || body.trim().length < (needsReason ? 10 : 3)}>
          {kind === 'recommendation' ? 'Записать рекомендацию' : kind === 'dissent' ? 'Записать разногласие' : 'Добавить аргумент'}
        </button>
      </div>
    </form>
  );
}

function ResponsibleActions({ view, onDone }: { view: CouncilView; onDone: (t: string) => Promise<void> }) {
  const c = view.can;
  const [open, setOpen] = useState<'ask' | 'pilot' | 'handoff' | 'decide' | null>(null);
  if (!c.askAuthor && !c.pilot && !c.handoff && !c.decide) {
    return (
      <section className="panel stack">
        <h2 className="section-title">Кто решает</h2>
        <p className="small">
          Решение по обращению принимает <b>{view.item.decisionOwner ?? 'ответственный за решение (пока не назначен)'}</b>. Вести обсуждение и
          передать его на решение может {view.item.maintainer ?? 'ведущий'}.
        </p>
      </section>
    );
  }
  const btn = (id: typeof open, label: string, primary = false) => (
    <button type="button" className={`btn${primary ? ' primary' : ''}`} aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
      {label}
    </button>
  );
  return (
    <section className="panel stack" aria-labelledby="resp-h">
      <h2 id="resp-h" className="section-title">
        Действия ответственных
      </h2>
      <div className="row">
        {c.decide ? btn('decide', 'Принять решение', true) : null}
        {c.handoff ? btn('handoff', 'Передать на решение', true) : null}
        {c.askAuthor ? btn('ask', 'Запросить уточнение у автора') : null}
        {c.pilot ? btn('pilot', 'Направить на пилот') : null}
      </div>
      {open === 'decide' ? <DecideForm view={view} onDone={onDone} /> : null}
      {open === 'handoff' ? <HandoffForm view={view} onDone={onDone} /> : null}
      {open === 'ask' ? <AskForm view={view} onDone={onDone} /> : null}
      {open === 'pilot' ? <PilotForm view={view} onDone={onDone} /> : null}
    </section>
  );
}

function FormShell({ title, children, onSubmit, busy, err, submit, disabled }: { title: string; children: ReactNode; onSubmit: () => void; busy: boolean; err: unknown; submit: string; disabled: boolean }) {
  return (
    <form
      className="stack council-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h3 className="args-h">{title}</h3>
      {children}
      {err ? <ErrorBox error={err} /> : null}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || disabled}>
          {submit}
        </button>
      </div>
    </form>
  );
}

function HandoffForm({ view, onDone }: { view: CouncilView; onDone: (t: string) => Promise<void> }) {
  const s = useSession();
  const pro = view.entries.filter((e) => e.kind === 'argument_for').length;
  const con = view.entries.filter((e) => e.kind === 'argument_against').length;
  const recs = view.entries.filter((e) => e.kind === 'recommendation').map((e) => REC_LABEL[e.recommendation!].toLowerCase());
  const [summary, setSummary] = useState(`Аргументов за: ${pro}, против: ${con}. Рекомендации: ${recs.length ? recs.join(', ') : 'нет'}.`);
  const { busy, err, run } = useAction(onDone);
  return (
    <FormShell
      title={`Передать решение: ${view.item.decisionOwner ?? ''}`}
      onSubmit={() => void run(`/orgs/${s.org}/ideas/${view.item.number}/council/handoff`, { summary: summary.trim() }, 'Передано на решение')}
      busy={busy}
      err={err}
      submit="Передать на решение"
      disabled={summary.trim().length < 10}
    >
      <div className="field">
        <label htmlFor="ho">Итог обсуждения для решающего</label>
        <textarea id="ho" className="textarea" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={3000} />
      </div>
    </FormShell>
  );
}

function AskForm({ view, onDone }: { view: CouncilView; onDone: (t: string) => Promise<void> }) {
  const s = useSession();
  const [body, setBody] = useState('');
  const { busy, err, run } = useAction(onDone);
  return (
    <FormShell
      title="Вопрос автору"
      onSubmit={() => void run(`/orgs/${s.org}/ideas/${view.item.number}/reviews`, { kind: 'request_changes', body: body.trim() }, 'Вопрос отправлен автору')}
      busy={busy}
      err={err}
      submit="Задать вопрос"
      disabled={!body.trim()}
    >
      <div className="field">
        <label htmlFor="ask">Что уточнить</label>
        <textarea id="ask" className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
      </div>
    </FormShell>
  );
}

function PilotForm({ view, onDone }: { view: CouncilView; onDone: (t: string) => Promise<void> }) {
  const s = useSession();
  const members = (s.directory?.members ?? []).filter((m) => m.access === 'member');
  const [plan, setPlan] = useState('');
  const [criteria, setCriteria] = useState('');
  const [owner, setOwner] = useState(s.membershipId);
  const { busy, err, run } = useAction(onDone);
  return (
    <FormShell
      title="Пилот: проверить на практике"
      onSubmit={() =>
        void run(`/orgs/${s.org}/ideas/${view.item.number}/verifications`, { plan: plan.trim(), successCriteria: criteria.trim(), owner }, 'Пилот запущен')
      }
      busy={busy}
      err={err}
      submit="Запустить пилот"
      disabled={plan.trim().length < 10 || criteria.trim().length < 10}
    >
      <div className="field">
        <label htmlFor="pl">План пилота</label>
        <textarea id="pl" className="textarea" rows={2} value={plan} onChange={(e) => setPlan(e.target.value)} maxLength={5000} />
      </div>
      <div className="field">
        <label htmlFor="pc">Критерий успеха</label>
        <textarea id="pc" className="textarea" rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} maxLength={3000} />
      </div>
      <div className="field">
        <label htmlFor="po">Кто ведёт пилот</label>
        <select id="po" className="select" value={owner} onChange={(e) => setOwner(e.target.value)}>
          {members.map((m) => (
            <option key={m.membershipId} value={m.membershipId}>
              {m.name}
              {m.jobTitle ? `, ${m.jobTitle}` : ''}
            </option>
          ))}
        </select>
      </div>
    </FormShell>
  );
}

function DecideForm({ view, onDone }: { view: CouncilView; onDone: (t: string) => Promise<void> }) {
  const s = useSession();
  const members = (s.directory?.members ?? []).filter((m) => m.access === 'member');
  const [outcome, setOutcome] = useState<'merge' | 'reject' | 'close'>('merge');
  const [rationale, setRationale] = useState('');
  const [implementer, setImplementer] = useState('');
  const { busy, err, run } = useAction(onDone);
  const label = { merge: 'Внедрить', reject: 'Отклонить', close: 'Закрыть' } as const;
  return (
    <FormShell
      title="Решение"
      onSubmit={() =>
        void run(
          `/orgs/${s.org}/ideas/${view.item.number}/decision`,
          { outcome, rationale: rationale.trim(), ...(outcome === 'merge' && implementer ? { implementer } : {}) },
          outcome === 'merge' ? 'Решение: внедрять' : outcome === 'reject' ? 'Решение: отклонить' : 'Обращение закрыто',
        )
      }
      busy={busy}
      err={err}
      submit={`Принять решение: ${label[outcome].toLowerCase()}`}
      disabled={rationale.trim().length < 10}
    >
      <div className="segmented" role="radiogroup" aria-label="Решение">
        {(['merge', 'reject', 'close'] as const).map((o) => (
          <button key={o} type="button" role="radio" aria-checked={outcome === o} aria-pressed={outcome === o} onClick={() => setOutcome(o)}>
            {label[o]}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="dr">{outcome === 'merge' ? 'Почему внедряем' : outcome === 'reject' ? 'Почему отклоняем — автор увидит это объяснение' : 'Почему закрываем'}</label>
        <textarea id="dr" className="textarea" rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={5000} />
      </div>
      {outcome === 'merge' ? (
        <div className="field">
          <label htmlFor="di">Кто внедряет</label>
          <select id="di" className="select" value={implementer} onChange={(e) => setImplementer(e.target.value)}>
            <option value="">Назначить позже</option>
            {members.map((m) => (
              <option key={m.membershipId} value={m.membershipId}>
                {m.name}
                {m.jobTitle ? `, ${m.jobTitle}` : ''}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </FormShell>
  );
}

function Journal({ view }: { view: CouncilView }) {
  const rows = [
    ...view.entries.map((e) => ({ at: e.createdAt, who: e.author, what: entryLabel(e), body: e.body })),
    ...view.questions.map((q) => ({ at: q.createdAt, who: q.author, what: 'Вопрос автору', body: q.body })),
    ...view.decisions.map((d) => ({
      at: d.createdAt,
      who: d.decidedBy,
      what: d.outcome === 'merge' ? 'Решение: внедрить' : d.outcome === 'reject' ? 'Решение: отклонить' : 'Решение: закрыть',
      body: d.rationale,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section className="panel stack" aria-labelledby="journal-h">
      <h2 id="journal-h" className="section-title">
        Журнал заседания
      </h2>
      {rows.length ? (
        <ol className="journal">
          {rows.map((r, i) => (
            <li key={i}>
              <span className="small muted">{dateTime(r.at)}</span>
              <span>
                <b>{r.what}</b> — {r.who}
              </span>
              <span className="small">{r.body}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="small muted">Записей пока нет. Всё, что скажут за столом, появится здесь с временем и автором.</p>
      )}
    </section>
  );
}

