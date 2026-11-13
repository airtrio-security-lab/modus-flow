import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, newKey } from '../lib/api';
import { dateTime, due, plural } from '../lib/format';
import { go } from '../lib/router';
import { CouncilScene } from '../components/scenes';
import { useRemembered } from '../lib/remember';
import { useLoad, useSession } from '../lib/session';
import { STATUS } from '../lib/status';
import { ESCALATION_REASONS, type CouncilEntry, type CouncilListRow, type CouncilRole, type CouncilSeat, type CouncilView, type Recommendation, type Stance } from '../lib/types';
import { ErrorBox, Loading, PageHead, StatusChip } from '../components/ui';
import { AdvisorPanel, advisorMethodLine, useAdvisorStatus } from '../components/Advisor';
import { AskAdvisorAtTable } from '../components/VoiceAdvisor';
import type { ExecutorView } from '../lib/types';
import { CouncilTabs } from './Meetings';
import { ItemContextPanel } from '../components/ProjectContext';
import type { IdeaDetail } from '../lib/types';

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
      <PageHead title={`Советы: ${s.realmName}`} sub="Малые советы подразделений и Большой Круглый стол всего Содружества: аргументы, рекомендации — и решение того, кто за него отвечает.">
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
        {s.isLead || s.isAdmin ? (
          <a className="btn" href="#/meetings/new">
            Созвать заседание с записью
          </a>
        ) : null}
      </PageHead>
      <CouncilTabs active="items" />
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading rows={4} /> : null}
      {data && !rows.length ? <div className="empty">Сейчас на Совете нет обращений{scope !== 'all' ? ' по этому фильтру' : ''}.</div> : null}
      <CouncilScene place="great" seats={[...new Set(rows.filter((r) => r.council === 'great').map((r) => r.civilization ?? 'camelot'))]} label={`Большой Круглый стол — совет всего Содружества «${s.realmName}»: все цивилизации на равных`} />
      <section className="stack" aria-labelledby="cg-great">
        <h2 id="cg-great" className="section-title">
          Большой Круглый стол ({rows.filter((r) => r.council === 'great').length})
        </h2>
        <p className="small muted">Межотдельские, стратегические вопросы, общие ресурсы и эскалации из малых советов. Решает ответственный за решение.</p>
        {rows.some((r) => r.council === 'great') ? (
          <CouncilRows list={rows.filter((r) => r.council === 'great')} />
        ) : (
          <p className="small muted">Сейчас у Большого совета нет вопросов.</p>
        )}
      </section>
      <h2 className="section-title">Малые советы подразделений</h2>
      {GROUPS.map((g) => {
        const list = rows.filter((r) => r.council !== 'great' && g.statuses.includes(r.status));
        if (!list.length) return null;
        return (
          <section key={g.title} className="stack" aria-labelledby={`cg-${g.title}`}>
            <h2 id={`cg-${g.title}`} className="section-title">
              {g.title} ({list.length})
            </h2>
            <CouncilRows list={list} />
          </section>
        );
      })}
    </div>
  );
}

function CouncilRows({ list }: { list: CouncilListRow[] }) {
  return (
    <ul className="council-list">
      {list.map((r) => {
        const d = due(r.resolutionDueAt);
        return (
          <li key={r.number}>
            <a href={`#/council/${r.number}`}>
              <span className="num">Обращение №{r.number}</span>
              <span className="title">{r.title}</span>
              <span className="meta">
                <span>{r.council === 'great' ? 'Большой Круглый стол' : r.hall}</span>
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
  const advisorLine = advisorMethodLine(useAdvisorStatus());
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
  const leads = data.seats.some((x) => x.membershipId === s.membershipId && (x.roles.includes('maintainer') || x.roles.includes('decision_owner')));

  return (
    <div className="stack-lg">
      <PageHead title={`${data.place.level === 'great' ? 'Большой Круглый стол' : data.place.hall}: обращение №${it.number}`} sub={it.title}>
        <a className="btn" href={`#/items/${it.number}`}>
          Карточка обращения
        </a>
        <AskAdvisorAtTable number={it.number} />
        {s.isLead || s.isAdmin ? (
          <a className="btn primary" href={`#/meetings/new?idea=${it.number}&title=${encodeURIComponent(`Совет по обращению №${it.number}`)}`}>
            Созвать заседание с записью
          </a>
        ) : null}
      </PageHead>

      <CouncilScene
        place={data.place.level === 'great' ? 'great' : (data.place.department?.civilization ?? 'camelot')}
        seats={data.seats.map((x) => x.civilization ?? 'camelot')}
        label={data.place.level === 'great' ? 'Большой Круглый стол — представители всех подразделений на равных' : `${data.place.hall} — малый совет «${data.place.department?.name ?? ''}»`}
      />
      <PlacePanel view={data} onDone={done} />

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
            <SeatList seats={data.seats} selected={seat} onSelect={setSeat} advisor={advisorLine} />
          ) : (
            <TableScene view={data} selected={seat} onSelect={setSeat} advisor={advisorLine} />
          )}
          <Journal view={data} />
        </div>

        <aside className="council-panel stack" aria-label="Обсуждение и действия">
          {selected ? <Position seat={selected} entries={data.entries.filter((e) => e.authorMembershipId === selected.membershipId)} onClose={() => setSeat(null)} /> : null}

          <CouncilContext number={it.number} />

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

          <AdvisorPanel number={it.number} leads={leads} onDone={done} />

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
            <p className="small muted">Найдены по совпадению слов в названии — это поиск, не ИИ.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TableScene({ view, selected, onSelect, advisor }: { view: CouncilView; selected: string | null; onSelect: (id: string | null) => void; advisor: string }) {
  const W = 760;
  const H0 = 660; // the room; a strip below it holds the advisor's place
  const H = H0 + 84;
  const cx = W / 2;
  const cy = H0 / 2 + 6;
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
      <AdvisorSeat x={cx} y={H - 46} line={advisor} />
    </svg>
  );
}

/** The advisor's place: a dashed chair at the edge of the room — it advises, it has no vote. */
function AdvisorSeat({ x, y, line }: { x: number; y: number; line: string }) {
  const open = () => {
    const el = document.getElementById('advisor');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.focus({ preventScroll: true });
  };
  return (
    <g
      className="seat advisor-seat"
      transform={`translate(${x} ${y})`}
      role="button"
      tabIndex={0}
      aria-label={`Помощник Совета: ${line}. Без права голоса. Открыть подбор исполнителей`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <rect x="-80" y="-34" width="160" height="70" rx="10" className="advisor-chair" />
      <text y="-10" textAnchor="middle" className="seat-name">
        Помощник Совета
      </text>
      <text y="10" textAnchor="middle" className="seat-role">
        {line}
      </text>
      <text y="27" textAnchor="middle" className="seat-role">
        без права голоса
      </text>
    </g>
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

function SeatList({ seats, selected, onSelect, advisor }: { seats: CouncilSeat[]; selected: string | null; onSelect: (id: string | null) => void; advisor: string }) {
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
      <li className="advisor-row">
        <a href="#advisor" onClick={(e) => { e.preventDefault(); document.getElementById('advisor')?.scrollIntoView({ behavior: 'smooth' }); }}>
          <span className="seat-dot advisor-dot" aria-hidden="true">
            П
          </span>
          <span className="seat-list-main">
            <b>Помощник Совета</b>
            <span className="small muted">{advisor}, без права голоса</span>
          </span>
        </a>
      </li>
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
      <span className="entry-kind">
        {entryLabel(e)} <span className={`entry-where ${e.council}`}>{e.council === 'great' ? 'Большой совет' : 'малый совет'}</span>
      </span>
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
          <button key={o.id} type="button" role="radio" aria-checked={kind === o.id} onClick={() => setKind(o.id)}>
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
  const [suggested, setSuggested] = useState<string | null>(null);
  // An executor confirmed at the council is preselected; the decision owner can still choose anyone.
  useEffect(() => {
    let live = true;
    api<ExecutorView>(`/orgs/${s.org}/ideas/${view.item.number}/executors`)
      .then((x) => {
        const last = x.confirmed.at(-1);
        if (!live || !last) return;
        setSuggested(last.name);
        setImplementer((cur) => cur || last.candidate);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [s.org, view.item.number]);
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
          <button key={o} type="button" role="radio" aria-checked={outcome === o} onClick={() => setOutcome(o)}>
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
          {suggested ? <span className="hint">Подтверждён на Совете: {suggested}. Можно выбрать другого.</span> : null}
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


// ---------------------------------------------------------------------------
// Small council → Great Round Table (ADR-0020)
// ---------------------------------------------------------------------------
function PlacePanel({ view, onDone }: { view: CouncilView; onDone: (t: string) => Promise<void> }) {
  const s = useSession();
  const p = view.place;
  const small = view.entries.filter((e) => e.council === 'small').length;
  const smallMeetings = view.meetings.filter((m) => m.council === 'small');
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('cross_department');
  const [reason, setReason] = useState('');
  const act = useAction(onDone);
  return (
    <section className={`panel stack council-place ${p.level}`} aria-labelledby="place-h">
      <h2 id="place-h" className="section-title">
        {p.level === 'great' ? 'Вопрос у Большого Круглого стола' : `Вопрос у малого совета: ${p.hall}`}
      </h2>
      {p.escalation ? (
        <p className="small">
          Передал(а) <b>{p.escalation.by}</b> {dateTime(p.escalation.at)}
          {p.escalation.from ? ` из малого совета «${p.escalation.from.name}» (${p.escalation.from.hall})` : ''}. Причина: <b>{p.escalation.reasonTitle}</b> — {p.escalation.reason}
        </p>
      ) : (
        <p className="small muted">
          {p.department ? `Подразделение «${p.department.name}», ${p.department.civilizationName}.` : 'Обращение без подразделения.'} Межотдельский или стратегический
          вопрос можно передать к Большому Круглому столу — один раз, с причиной.
        </p>
      )}
      <p className="small">
        История в подразделении: {small} {plural(small, 'запись', 'записи', 'записей')} малого совета
        {smallMeetings.length ? `, заседания: ${smallMeetings.map((m) => m.title).join('; ')}` : ''}.
      </p>
      {view.meetings.length ? (
        <ul className="plain small">
          {view.meetings.map((m) => (
            <li key={m.id}>
              <a href={`#/meetings/${m.id}`}>{m.title}</a> — {m.council === 'great' ? 'Большой совет' : 'малый совет'}, {dateTime(m.at)}
            </li>
          ))}
        </ul>
      ) : null}
      {view.can.escalate ? (
        open ? (
          <FormShell
            title="Передать в Большой совет"
            busy={act.busy}
            err={act.err}
            submit="Передать к Большому Круглому столу"
            disabled={reason.trim().length < 10}
            onSubmit={() =>
              void act
                .run(`/orgs/${s.org}/ideas/${view.item.number}/council/escalate`, { reasonKind: kind, reason: reason.trim() }, 'Вопрос передан к Большому Круглому столу: главы подразделений и участники получили приглашение')
                .then((ok) => {
                  // The camera shows the way from the district's castle to the palace (skippable).
                  if (ok) go(`/kingdom?enter=${encodeURIComponent(`/council/${view.item.number}`)}${p.department ? `&from=${p.department.id}` : ''}`);
                })
            }
          >
            <div className="field">
              <label htmlFor="esc-kind">Почему нужен Большой совет</label>
              <select id="esc-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(ESCALATION_REASONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="esc-reason">Пояснение</label>
              <textarea id="esc-reason" className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Например: сервер печати нужен и складу, и продажам" />
            </div>
            <p className="small muted">Решение по-прежнему принимает {view.item.decisionOwner ?? 'ответственный за решение'}. Голосования с юридической силой нет.</p>
          </FormShell>
        ) : (
          <div>
            <button type="button" className="btn" onClick={() => setOpen(true)}>
              Передать в Большой совет
            </button>
          </div>
        )
      ) : null}
    </section>
  );
}

/** Where the problem arose and which departments it touches (ADR-0031): the same panel as on the item card. */
function CouncilContext({ number }: { number: number }) {
  const s = useSession();
  const { data, reload } = useLoad(() => api<IdeaDetail>(`/orgs/${s.org}/ideas/${number}`), [s.org, number]);
  if (!data) return null;
  return <ItemContextPanel item={data} onChanged={() => void reload()} council />;
}
