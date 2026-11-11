import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorText } from '../lib/api';
import { date, plural } from '../lib/format';
import { STATUS } from '../lib/status';
import { useLoad, useSession } from '../lib/session';
import type { District as DistrictData, DistrictItem, StaffCard, Status } from '../lib/types';
import { ErrorBox, Loading, StatusChip } from '../components/ui';
import { CIVS, CivCastle, DistrictHouses, civOf, type Civ } from '../components/civ';
import { CouncilScene } from '../components/scenes';
import { HERALDRY } from './Kingdom';

/**
 * The district of a department (owner brief 2026-11-11, ADR-0019): the castle opens into a
 * management screen. Everything here is read from existing facts under the caller's rights; every
 * action goes to an existing function (item page, implementer rule, meeting call). Unknown figures
 * are shown as «Нет данных», never as 0. The style of the district is a picture: no rights.
 */
const TABS = [
  { id: 'staff', name: 'Состав' },
  { id: 'tasks', name: 'Задачи' },
  { id: 'initiatives', name: 'Инициативы' },
  { id: 'council', name: 'Совет' },
  { id: 'legacy', name: 'Наследие' },
  { id: 'growth', name: 'Развитие' },
] as const;
type Tab = (typeof TABS)[number]['id'];
const TAB_KEY = 'modus.district.tab';
const NO_DATA = 'Нет данных';
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] ?? '');

function rememberedTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (TABS.some((x) => x.id === t)) return t as Tab;
  } catch {
    /* storage unavailable */
  }
  return 'staff';
}

export function DistrictPage({ id, tab }: { id: string; tab?: string }) {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<DistrictData>(`/orgs/${s.org}/castles/${id}/district`), [s.org, id]);
  const current: Tab = TABS.some((t) => t.id === tab) ? (tab as Tab) : rememberedTab();
  const [picker, setPicker] = useState(false);
  const closePicker = useCallback(() => setPicker(false), []);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, current);
    } catch {
      /* ignore */
    }
  }, [current]);

  if (error) return <ErrorBox error={error} retry={() => void reload()} />;
  if (loading && !data) return <Loading label="Открываем замок…" rows={5} />;
  if (!data) return null;
  const color = HERALDRY[data.colorIndex % HERALDRY.length]!;
  return (
    <div className={`district stack-lg civ-${civOf(data.civilization.id)}`}>
      <a className="back-link" href="#/kingdom">
        ← Город
      </a>
      <DistrictHeader d={data} color={color} onPick={() => setPicker(true)} />
      <nav className="district-tabs" role="tablist" aria-label="Разделы замка">
        {TABS.map((t) => (
          <a key={t.id} role="tab" aria-selected={current === t.id} href={`#/castles/${id}/${t.id}`} className="district-tab">
            {t.name}
            <TabCount d={data} tab={t.id} />
          </a>
        ))}
      </nav>
      <section role="tabpanel" aria-label={TABS.find((t) => t.id === current)!.name}>
        {current === 'staff' ? <StaffTab d={data} reload={reload} /> : null}
        {current === 'tasks' ? <TasksTab d={data} /> : null}
        {current === 'initiatives' ? <InitiativesTab d={data} /> : null}
        {current === 'council' ? <CouncilTab d={data} /> : null}
        {current === 'legacy' ? <LegacyTab d={data} /> : null}
        {current === 'growth' ? <GrowthTab d={data} color={color} /> : null}
      </section>
      {picker ? <CivPicker d={data} color={color} onClose={closePicker} onSaved={() => void reload()} /> : null}
    </div>
  );
}

function TabCount({ d, tab }: { d: DistrictData; tab: Tab }) {
  const n = tab === 'staff' ? d.people : tab === 'tasks' ? d.tasks.length : tab === 'initiatives' ? d.initiatives.length : tab === 'council' ? d.council.open.length : tab === 'legacy' ? d.legacy.length : null;
  return n === null ? null : <span className="district-tab-n">{n}</span>;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function DistrictHeader({ d, color, onPick }: { d: DistrictData; color: string; onPick: () => void }) {
  const next = d.nextLevelXp === null ? `${d.xp} XP — высший уровень` : `${d.xp} из ${d.nextLevelXp} XP до уровня «${d.nextLevelName}»`;
  return (
    <header className={`district-head civ-${d.civilization.id}`}>
      <div className="district-art" aria-hidden="true">
        <svg viewBox="-85 -105 170 135">
          <ellipse cx="0" cy="18" rx="105" ry="30" fill="rgba(0,0,0,0.12)" />
          <DistrictHouses civ={d.civilization.id} level={d.level} u={9} color={color} />
          <CivCastle civ={d.civilization.id} level={d.level} color={color} u={9} />
        </svg>
      </div>
      <div className="district-id stack">
        <div>
          <h1>{d.name}</h1>
          <p className="muted">
            {d.civilization.name}
            {d.canChooseCivilization ? (
              <>
                {' · '}
                <button type="button" className="linklike" onClick={onPick}>
                  Сменить стиль района
                </button>
              </>
            ) : null}
          </p>
        </div>
        <p className="small">
          Место совета: <a href={`#/castles/${d.id}/council`}>{d.civilization.hall}</a>
        </p>
        <p>
          Глава:{' '}
          {d.head ? (
            <a href={`#/people/${d.head.membershipId}`}>
              <b>{d.head.name ?? NO_DATA}</b>
            </a>
          ) : (
            <span className="muted">не назначен</span>
          )}
          {d.head?.title ? <span className="title-chip" style={{ marginLeft: 8 }}>{d.head.title}</span> : null}
        </p>
        <div className="district-level">
          <span className="level-badge">
            Уровень {d.level} · {d.levelName}
          </span>
          <span className="small muted">
            {d.rank} место из {d.of} в рейтинге
          </span>
        </div>
        <div className="xpbar">
          <div className="xpbar-track" role="progressbar" aria-label="Опыт до следующего уровня" aria-valuemin={d.levelFloor} aria-valuemax={d.nextLevelXp ?? d.xp} aria-valuenow={d.xp} aria-valuetext={next}>
            <span style={{ width: `${Math.round(d.progress * 100)}%` }} />
          </div>
          <span className="small">{next}</span>
        </div>
      </div>
      <dl className="district-stats">
        <Stat label="Сотрудников" value={d.people} />
        <Stat label="Задач в работе" value={d.activeTasks} hint="внедряются после решения" />
        <Stat label="На рассмотрении" value={d.inReview} />
        <Stat label="Внедрено" value={d.implemented} hint="подтверждённые реализации" />
      </dl>
      {d.lastAchievements.length ? (
        <p className="district-ach small">
          Последние достижения:{' '}
          {d.lastAchievements.map((a) => (
            <span key={a.key} className="ach-chip" title={a.description}>
              {a.title}
            </span>
          ))}
        </p>
      ) : (
        <p className="district-ach small muted">Достижений пока нет: ни одно внедрение ещё не подтверждено.</p>
      )}
    </header>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div title={hint}>
      <dt>{label}</dt>
      <dd>{value === null ? NO_DATA : value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Состав
// ---------------------------------------------------------------------------
const GROUPS: { id: StaffCard['group']; name: string; what: string }[] = [
  { id: 'command', name: 'Командование', what: 'глава подразделения и те, кто ведёт и решает обращения' },
  { id: 'specialist', name: 'Специалисты', what: 'есть подтверждённые результаты: внедрения или подтверждение исполнителя' },
  { id: 'member', name: 'Основной состав', what: 'сотрудники подразделения' },
];

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
/** A neutral colour from the membership id — never from the name, so it says nothing about the person. */
function avatarColor(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ['#2f4f7a', '#4d7448', '#73466a', '#2b6f6a', '#8a5a2b', '#55606e', '#a2412f', '#6b5b2e'][h % 8]!;
}

function StaffTab({ d, reload }: { d: DistrictData; reload: () => Promise<unknown> | void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const needle = q.trim().toLowerCase();
  const shown = d.staff.filter((p) => !needle || `${p.name} ${p.jobTitle ?? ''} ${p.title ?? ''} ${(p.skills ?? []).join(' ')}`.toLowerCase().includes(needle));
  const card = open ? d.staff.find((p) => p.membershipId === open) : undefined;
  return (
    <div className="stack-lg">
      <label className="field district-search">
        <span>Поиск по составу</span>
        <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, должность или навык" />
      </label>
      {GROUPS.map((g) => {
        const people = shown.filter((p) => p.group === g.id);
        return (
          <section key={g.id} className="stack" aria-labelledby={`g-${g.id}`}>
            <h2 id={`g-${g.id}`} className="section-title">
              {g.name} <span className="muted small">· {people.length}</span>
            </h2>
            <p className="muted small">{g.what}</p>
            {people.length ? (
              <ul className={`staff-grid${g.id === 'command' ? ' is-strip' : ''}`}>
                {people.map((p) => (
                  <li key={p.membershipId}>
                    <StaffCardView p={p} onOpen={() => setOpen(p.membershipId)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{needle ? 'Никого не нашли.' : 'Пока никого.'}</p>
            )}
          </section>
        );
      })}
      <section className="stack" aria-labelledby="g-needs">
        <h2 id="g-needs" className="section-title">
          Потребности отдела
        </h2>
        <dl className="needs">
          <div>
            <dt>Вакансии</dt>
            <dd>{NO_DATA}</dd>
          </div>
          <div>
            <dt>Недостающие компетенции</dt>
            <dd>{NO_DATA}</dd>
          </div>
          <div>
            <dt>Нехватка ёмкости</dt>
            <dd>{NO_DATA}</dd>
          </div>
        </dl>
        <p className="muted small">{d.needs.note}</p>
      </section>
      {card ? <StaffSheet d={d} p={card} onClose={close} reload={reload} /> : null}
    </div>
  );
}

function Avatar({ p, size = 48 }: { p: Pick<StaffCard, 'membershipId' | 'name'>; size?: number }) {
  return (
    <span className="avatar" style={{ background: avatarColor(p.membershipId), width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {initials(p.name)}
    </span>
  );
}

function questionnaireText(p: StaffCard) {
  if (p.questionnaire === 'hidden') return 'Анкета видна самому сотруднику и руководителям';
  if (p.questionnaire === 'empty') return 'Анкета не заполнена';
  return null;
}

/** A small sign of what the title stands for (a function, not a rating); the same shapes in every civilization. */
const KIND_LABEL: Record<string, string> = {
  castle_head: 'глава подразделения',
  deputy: 'заместитель, назначен администратором',
  authorized: 'ведёт или решает обращения',
  master: 'подтверждённые результаты',
  novice: 'начинающий, выбрано самим сотрудником',
  king: 'звание владельца',
  regent: 'звание заместителя владельца',
};
function TitleMark({ kind }: { kind: StaffCard['titleKind'] }) {
  const label = kind ? KIND_LABEL[kind] : undefined;
  if (!label) return null;
  const shape =
    kind === 'castle_head' || kind === 'king' ? 'M2,13 L4,5 L8,9 L12,3 L16,9 L20,5 L22,13 Z'
    : kind === 'deputy' || kind === 'regent' ? 'M12,2 L21,6 V12 C21,17 16,21 12,22 C8,21 3,17 3,12 V6 Z'
    : kind === 'authorized' ? 'M12,2 L14,14 L12,22 L10,14 Z M5,15 H19 V17 H5 Z'
    : kind === 'master' ? 'M4,6 H16 V11 H4 Z M9,11 H11 V22 H9 Z'
    : 'M12,22 V10 M12,12 C8,12 6,9 6,5 C10,5 12,8 12,12 M12,10 C12,6 15,3 19,3 C19,7 16,10 12,10';
  return (
    <span className="title-mark" title={label}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d={shape} />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function StaffCardView({ p, onOpen }: { p: StaffCard; onOpen: () => void }) {
  const a = p.achievements;
  const confirmed = a.implemented + a.ideasImplemented + a.effectsConfirmed + a.confirmedAsExecutor;
  return (
    <button type="button" className={`staff-card group-${p.group} kind-${p.titleKind ?? 'none'}`} onClick={onOpen} aria-label={`${p.name}: открыть карточку`}>
      <TitleMark kind={p.titleKind} />
      <span className="staff-top">
        <Avatar p={p} />
        <span className="staff-who">
          <b>{p.name}</b>
          <span className="small muted">{p.jobTitle ?? 'Должность не указана'}</span>
          {p.title || p.isHead ? (
            <span className="row-tight">
              {p.isHead ? <span className="flag">глава</span> : null}
              {p.title ? <span className="title-chip">{p.title}</span> : null}
              {p.honor ? <span className="honor-chip" title="Почётное звание за подтверждённые достижения, показано по выбору сотрудника">{p.honor}</span> : null}
            </span>
          ) : null}
        </span>
      </span>
      <span className="staff-spec small">
        {p.specialization ? (
          <>
            Специализация: <b>{p.specialization}</b>
          </>
        ) : (
          <span className="muted">{questionnaireText(p) ?? 'Специализация не указана'}</span>
        )}
      </span>
      <span className="staff-figs">
        <Fig label="Загрузка" value={p.loadHours === null ? NO_DATA : `${p.loadHours} ч`} />
        <Fig label="Ёмкость" value={p.capacityHours === null ? NO_DATA : `${p.capacityHours} ч/нед`} />
        <Fig label="Задачи" value={String(p.activeTasks)} />
        <Fig label="Результаты" value={String(confirmed)} />
      </span>
    </button>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <span className="fig">
      <span className="fig-l">{label}</span>
      <span className={`fig-v${value === NO_DATA ? ' none' : ''}`}>{value}</span>
    </span>
  );
}

/** The staff card opened: real actions only, each under the existing rights. */
function StaffSheet({ d, p, onClose, reload }: { d: DistrictData; p: StaffCard; onClose: () => void; reload: () => Promise<unknown> | void }) {
  const s = useSession();
  const box = useRef<HTMLDivElement>(null);
  const [assign, setAssign] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  const a = p.achievements;
  const targets = d.assignable.filter((x) => x.implementerId !== p.membershipId);
  async function doAssign() {
    if (!assign) return;
    setBusy(true);
    setMsg(null);
    try {
      await api(`/orgs/${s.org}/ideas/${assign}/implementer`, { json: { implementer: p.membershipId } });
      setMsg({ ok: true, text: `${p.name}: назначен(а) исполнителем обращения №${assign}. Уведомление отправлено.` });
      setAssign('');
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  const meetingHref = `#/meetings/new?participant=${p.membershipId}&department=${d.id}&title=${encodeURIComponent(`Совет: ${d.name}`)}`;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <Avatar p={p} size={56} />
          <div>
            <h2 id="sheet-title">{p.name}</h2>
            <p className="muted small">
              {p.jobTitle ?? 'Должность не указана'} · {d.name}
            </p>
            {p.title ? <span className="title-chip">{p.title}</span> : null}
          </div>
          <button type="button" className="btn quiet small sheet-close" onClick={onClose} aria-label="Закрыть карточку">
            ✕
          </button>
        </header>
        <div className="sheet-body stack">
          <dl className="realm-facts">
            <div>
              <dt>Загрузка</dt>
              <dd className={p.loadHours === null ? 'none' : ''}>{p.loadHours === null ? NO_DATA : `${p.loadHours} ч`}</dd>
            </div>
            <div>
              <dt>Доступная ёмкость</dt>
              <dd className={p.capacityHours === null ? 'none' : ''}>{p.capacityHours === null ? NO_DATA : `${p.capacityHours} ч/нед`}</dd>
            </div>
            <div>
              <dt>Внедряет сейчас</dt>
              <dd>{p.assigned}</dd>
            </div>
            <div>
              <dt>Ведёт обращений</dt>
              <dd>{p.leading}</dd>
            </div>
          </dl>
          <p className="muted small">Загрузка в часах не учитывается: часы по задачам в системе не записываются. Ёмкость — из анкеты, её заполняет сам сотрудник.</p>
          <div>
            <h3 className="realm-sub-h">Подтверждённые компетенции и результаты</h3>
            <ul className="plain small">
              <li>Внедрил(а) как исполнитель: {a.implemented}</li>
              <li>Предложенные идеи внедрены: {a.ideasImplemented}</li>
              <li>Подтверждённый эффект: {a.effectsConfirmed}</li>
              <li>Подтверждён(а) исполнителем: {a.confirmedAsExecutor}</li>
            </ul>
          </div>
          <div>
            <h3 className="realm-sub-h">Навыки из анкеты</h3>
            {p.skills?.length ? (
              <p className="row-tight">
                {p.skills.map((x) => (
                  <span key={x} className="skill-chip">
                    {x}
                  </span>
                ))}
              </p>
            ) : (
              <p className="muted small">{questionnaireText(p) ?? 'Навыки не указаны'}</p>
            )}
            <p className="muted small">Анкета заполнена самим сотрудником; это не оценка руководителя.</p>
          </div>
          {msg ? (
            <p className={`notice ${msg.ok ? 'ok' : 'error'}`} role={msg.ok ? 'status' : 'alert'}>
              {msg.text}
            </p>
          ) : null}
          <div className="sheet-actions">
            <a className="btn" href={`#/people/${p.membershipId}`}>
              Профиль
            </a>
            <a className="btn" href={`#/people/${p.membershipId}?section=tasks`}>
              Задачи: {p.activeTasks}
            </a>
            <a className="btn" href={`#/people/${p.membershipId}?section=initiatives`}>
              Инициативы
            </a>
            <a className="btn" href={`#/castles/${d.id}/growth?who=${p.membershipId}`}>
              Вклад в замок
            </a>
            {d.canCallCouncil ? (
              <a className="btn" href={meetingHref}>
                Пригласить в Совет
              </a>
            ) : null}
          </div>
          {targets.length ? (
            <div className="assign stack">
              <h3 className="realm-sub-h">Назначить задачу</h3>
              <p className="muted small">Исполнителя назначает ведущий или ответственный за решение после решения «внедрять» — по тем же правилам, что и на странице обращения.</p>
              <label className="field">
                <span>Обращение</span>
                <select className="select" value={assign} onChange={(e) => setAssign(e.target.value)}>
                  <option value="">Выберите обращение</option>
                  {targets.map((t) => (
                    <option key={t.number} value={t.number}>
                      №{t.number} {t.title}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn primary" disabled={!assign || busy} onClick={() => void doAssign()}>
                {busy ? 'Назначаем…' : 'Назначить исполнителем'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Задачи · Инициативы
// ---------------------------------------------------------------------------
const COLUMNS: { name: string; statuses: Status[] }[] = [
  { name: 'Ждут распределения', statuses: ['unrouted'] },
  { name: 'Рассмотрение', statuses: ['in_review', 'needs_info'] },
  { name: 'У Совета', statuses: ['decision'] },
  { name: 'Пилот', statuses: ['in_verification'] },
  { name: 'Внедряется', statuses: ['in_progress'] },
];

function useFilter(items: DistrictItem[]) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () => items.filter((i) => !needle || `${i.number} ${i.title} ${i.author} ${i.maintainer ?? ''} ${i.implementer ?? ''}`.toLowerCase().includes(needle)),
    [items, needle],
  );
  const input = (
    <label className="field district-search">
      <span>Поиск</span>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Номер, тема или человек" />
    </label>
  );
  return { shown, input };
}

function ItemCard({ i }: { i: DistrictItem }) {
  return (
    <a className="kan-card" href={`#/items/${i.number}`}>
      <span className="small muted">Обращение №{i.number}</span>
      <b>{i.title}</b>
      <span className="small muted">
        {i.implementer ? `Внедряет: ${i.implementer}` : i.maintainer ? `Ведёт: ${i.maintainer}` : `Автор: ${i.author}`}
      </span>
      <span className="row-tight">
        {i.overdue ? <span className="flag red">срок прошёл</span> : null}
        {i.stale ? <span className="flag">нет движения</span> : null}
        {i.due ? <span className="small muted">срок {date(i.due)}</span> : null}
      </span>
    </a>
  );
}

function TasksTab({ d }: { d: DistrictData }) {
  const { shown, input } = useFilter(d.tasks);
  return (
    <div className="stack">
      {input}
      <div className="kanban" role="list">
        {COLUMNS.map((c) => {
          const items = shown.filter((i) => c.statuses.includes(i.status));
          return (
            <section key={c.name} className="kan-col" role="listitem" aria-label={`${c.name}: ${items.length}`}>
              <h3 className="kan-h">
                {c.name} <span className="muted">{items.length}</span>
              </h3>
              {items.length ? items.map((i) => <ItemCard key={i.number} i={i} />) : <p className="muted small">Пусто</p>}
            </section>
          );
        })}
      </div>
      <p className="muted small">Карточки ведут на страницы обращений: статусы меняются только там, по правилам обработки.</p>
    </div>
  );
}

function InitiativesTab({ d }: { d: DistrictData }) {
  const [status, setStatus] = useState('');
  const { shown, input } = useFilter(d.initiatives);
  const list = shown.filter((i) => !status || i.status === status);
  return (
    <div className="stack">
      <div className="row filters">
        {input}
        <label className="field">
          <span>Статус</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Все</option>
            {Object.entries(STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {list.length ? (
        <ul className="district-list">
          {list.map((i) => (
            <li key={i.number}>
              <a href={`#/items/${i.number}`}>
                <span className="num">№{i.number}</span> {i.title}
              </a>
              <span className="row-tight">
                <StatusChip status={i.status} />
                <span className="small muted">
                  {i.kind === 'problem' ? 'Проблема' : 'Предложение'} · автор {i.author} · {date(i.publishedAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Обращений не нашли.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Совет · Наследие · Развитие
// ---------------------------------------------------------------------------
function CouncilTab({ d }: { d: DistrictData }) {
  const small = d.council.open.filter((c) => !c.great);
  const great = d.council.open.filter((c) => c.great);
  const civ = civOf(d.civilization.id);
  const agenda = small.slice(0, 5).map((c) => `&agenda=${c.number}`).join('');
  return (
    <div className="stack-lg">
      <CouncilScene place={civ} color={HERALDRY[d.colorIndex % HERALDRY.length]} seats={d.staff.slice(0, 8).map(() => civ)} label={`${d.civilization.hall} — малый совет подразделения «${d.name}»`} />
      <p className="muted small">
        Малый совет обсуждает обращения подразделения: участники, повестка, доводы, рекомендации. Решение принимает ответственный за решение — по тем же
        правилам, что и везде. Межотдельские и стратегические вопросы передают к Большому Круглому столу.
      </p>
      {d.canCallCouncil ? (
        <div>
          <a className="btn primary" href={`#/meetings/new?department=${d.id}&title=${encodeURIComponent(`${d.civilization.hall}: ${d.name}`)}${agenda}`}>
            Созвать Малый совет
          </a>
        </div>
      ) : null}
      <section className="stack">
        <h2 className="section-title">У малого совета · {d.civilization.hall}</h2>
        {small.length ? (
          <ul className="district-list">
            {small.map((c) => (
              <li key={c.number}>
                <a href={`#/council/${c.number}`}>
                  <span className="num">№{c.number}</span> {c.title}
                </a>
                <span className="small muted">{c.entries ? `${c.entries} ${plural(c.entries, 'запись', 'записи', 'записей')} обсуждения` : 'обсуждение ещё не начато'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Сейчас у малого совета нет обращений.</p>
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Переданы к Большому Круглому столу</h2>
        {great.length ? (
          <ul className="district-list">
            {great.map((c) => (
              <li key={c.number}>
                <a href={`#/council/${c.number}`}>
                  <span className="num">№{c.number}</span> {c.title}
                </a>
                <span className="small muted">рассматривается в Большом совете компании</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Вопросов подразделения у Большого совета нет.</p>
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Решения</h2>
        {d.council.decisions.length ? (
          <ul className="district-list">
            {d.council.decisions.map((x, i) => (
              <li key={`${x.number}-${i}`}>
                <a href={`#/items/${x.number}`}>
                  <span className="num">№{x.number}</span> {x.title}
                </a>
                <span className="small muted">
                  {x.outcome === 'merge' ? 'Внедрять' : 'Отклонить'} — решил(а) {x.by}, {date(x.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Решений пока нет.</p>
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Заседания</h2>
        <p className="muted small">Видны только участникам заседания.</p>
        {d.council.meetings.length ? (
          <ul className="district-list">
            {d.council.meetings.map((m) => (
              <li key={m.id}>
                <a href={`#/meetings/${m.id}`}>{m.title}</a>
                <span className="small muted">
                  {date(m.at)}
                  {m.cancelled ? ' · отменено' : ''}
                  {m.idea ? ` · обращение №${m.idea}` : ''}
                  {m.great ? ' · Большой совет' : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Нет заседаний, где вы участник.</p>
        )}
      </section>
    </div>
  );
}

const LEVEL_NAME: Record<string, string> = { chronicle: 'Летопись', library: 'Библиотека решений', archive: 'Высший Архив' };
function LegacyTab({ d }: { d: DistrictData }) {
  return (
    <div className="stack">
      {d.legacy.length ? (
        <ul className="district-list">
          {d.legacy.map((k) => (
            <li key={k.id}>
              <a href={`#/library/${k.id}`}>{k.title}</a>
              <span className="small muted">{LEVEL_NAME[k.level] ?? k.level}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Из обращений подразделения пока ничего не записано в Летопись.</p>
      )}
      <a className="btn" href="#/library">
        Великая библиотека
      </a>
    </div>
  );
}

function GrowthTab({ d, color }: { d: DistrictData; color: string }) {
  const who = hashParams().get('who');
  const person = who ? d.staff.find((p) => p.membershipId === who) : undefined;
  const history = person ? d.development.history.filter((h) => h.credited === person.name) : d.development.history;
  return (
    <div className="stack-lg">
      <section className="stack">
        <h2 className="section-title">Пять уровней района</h2>
        <ol className="civ-levels">
          {d.levels.names.map((n, i) => (
            <li key={n} data-reached={i + 1 <= d.level ? 'yes' : 'no'}>
              <svg viewBox="-70 -95 140 120" aria-hidden="true">
                <DistrictHouses civ={d.civilization.id} level={i + 1} u={8} color={color} />
                <CivCastle civ={d.civilization.id} level={i + 1} color={color} u={8} />
              </svg>
              <b>
                {i + 1}. {n}
              </b>
              <span className="small muted">от {d.levels.thresholds[i]} XP</span>
            </li>
          ))}
        </ol>
      </section>
      <section className="stack">
        <h2 className="section-title">{person ? `Вклад: ${person.name}` : 'История опыта'}</h2>
        {person ? (
          <p className="small">
            <a href={`#/castles/${d.id}/growth`}>Показать весь опыт замка</a>
          </p>
        ) : null}
        <p className="muted small">Опыт начисляется только за подтверждённое внедрение (+100) и подтверждённый эффект (до +50), один раз за событие.</p>
        {history.length ? (
          <ol className="xp-history">
            {history.map((h, i) => (
              <li key={`${h.number}-${h.kind}-${i}`}>
                <span className="xp-plus">+{h.xp} XP</span>
                <span>
                  <a href={`#/items/${h.number}`}>Обращение №{h.number}</a> {h.title}
                  <span className="small muted">
                    {' '}
                    — {h.kind === 'implementation' ? 'внедрение' : 'подтверждённый эффект'}, автор {h.credited}, {date(h.at)}
                  </span>
                  {h.levelUp ? <span className="level-up-note">Новый уровень: {h.levelUp.name}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">{person ? 'Опыта, записанного на этого сотрудника как автора, пока нет.' : 'Опыта пока нет.'}</p>
        )}
      </section>
      <section className="stack">
        <h2 className="section-title">Достижения</h2>
        <ul className="achievements">
          {d.development.achievements.map((a) => (
            <li key={a.key} data-earned={a.earnedAt ? 'yes' : 'no'}>
              <b>{a.title}</b>
              <span className="small muted">{a.earnedAt ? `получено ${date(a.earnedAt)}` : 'ещё нет'}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="stack">
        <h2 className="section-title">Смена стиля района</h2>
        {d.development.civilizationHistory.length ? (
          <ul className="district-list">
            {d.development.civilizationHistory.map((h, i) => (
              <li key={i}>
                <span>
                  {h.from} → <b>{h.to}</b>
                </span>
                <span className="small muted">
                  {h.actor ?? 'сотрудник'}, {date(h.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Стиль не менялся.</p>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Выбор цивилизации
// ---------------------------------------------------------------------------
function CivPicker({ d, color, onClose, onSaved }: { d: DistrictData; color: string; onClose: () => void; onSaved: () => void }) {
  const s = useSession();
  const [pick, setPick] = useState<Civ>(civOf(d.civilization.id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const civ = CIVS.find((c) => c.id === pick)!;
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/castles/${d.id}/civilization`, { method: 'PUT', json: { civilization: pick } });
      onSaved();
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="civ-title" tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <div>
            <h2 id="civ-title">Стиль района «{d.name}»</h2>
            <p className="muted small">Стиль — только архитектура на карте. Опыт, уровень, рейтинг и права не меняются. Смена записывается в журнал.</p>
          </div>
          <button type="button" className="btn quiet small sheet-close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </header>
        <div className="sheet-body stack">
          <div className="civ-choices" role="radiogroup" aria-label="Цивилизация">
            {CIVS.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={pick === c.id} className="civ-choice" onClick={() => setPick(c.id)}>
                <svg viewBox="-70 -95 140 120" aria-hidden="true">
                  <CivCastle civ={c.id} level={3} color={color} u={10} />
                </svg>
                <b>{c.name}</b>
                <span className="small muted">{c.motto}</span>
              </button>
            ))}
          </div>
          <h3 className="realm-sub-h">«{civ.name}»: все пять уровней</h3>
          <ol className="civ-levels">
            {d.levels.names.map((n, i) => (
              <li key={n} data-reached={i + 1 <= d.level ? 'yes' : 'no'}>
                <svg viewBox="-70 -95 140 120" aria-hidden="true">
                  <DistrictHouses civ={pick} level={i + 1} u={8} color={color} />
                  <CivCastle civ={pick} level={i + 1} color={color} u={8} />
                </svg>
                <b>
                  {i + 1}. {n}
                </b>
                {i + 1 === d.level ? <span className="small">сейчас</span> : null}
              </li>
            ))}
          </ol>
          {err ? (
            <p className="notice error" role="alert">
              {err}
            </p>
          ) : null}
          <div className="sheet-actions">
            <button type="button" className="btn primary" disabled={busy || pick === d.civilization.id} onClick={() => void save()}>
              {pick === d.civilization.id ? 'Этот стиль уже выбран' : busy ? 'Сохраняем…' : `Выбрать «${civ.name}»`}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Отмена
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="section-title">
        {title}
      </h2>
      {children}
    </section>
  );
}
