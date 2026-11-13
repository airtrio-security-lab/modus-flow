import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, errorText, qs } from '../lib/api';
import { date, dateTime } from '../lib/format';
import { go } from '../lib/router';
import { useLoad, useSession } from '../lib/session';
import { ErrorBox, Loading } from '../components/ui';
import { ArchiveSeal, Crumbs, HALLS, HallHero, HallNavigation, KnowledgeProofBadge, KnowledgeTimeline, KnowledgeVolumeCard, Prose, ReadingSection, VolumeSkeleton, hallOf, type Level, type Status, type TimelineEvent, type VolumeRow } from '../components/halls';
import { useWorldBack } from '../lib/useWorldBack';
import './library.css';

/**
 * «Великая библиотека» (ADR-0017, ADR-0034): three halls over one knowledge model.
 * Летопись — registered events; Библиотека решений — cases checked by the archivist;
 * Высший Архив — heritage approved by an authorized person. Every result shows its hall
 * and what that says about checking. Level changes happen only through the buttons
 * below, each a real, recorded act; the archive animation plays after a confirmed one.
 * The look of the halls lives in components/halls.tsx and library.css; this file keeps the data,
 * the forms and the acts.
 */
type Kind = 'problem' | 'decision' | 'method' | 'improvement' | 'discovery' | 'lesson' | 'history';
type Category = 'method' | 'improvement' | 'reapplied' | 'discovery' | 'lesson' | 'history';
interface Card {
  problem?: string;
  options?: string;
  argumentsFor?: string;
  argumentsAgainst?: string;
  decision?: string;
  initiator?: string;
  responsible?: string[];
  reasons?: string;
  actions?: { what: string; due?: string }[];
  results?: string;
  positive?: string;
  negative?: string;
  evidence?: string;
  archiveCategory?: Category;
  proof?: string;
  applicability?: string;
  lastChecked?: string;
  basis?: string;
}
type Row = VolumeRow & { kind: Kind; visibility: string; updatedAt: string };
interface ListData {
  items: Row[];
  roles: { archivist: boolean; approver: boolean; curator: boolean };
  note: string;
}
type ActionId =
  | 'library_proposed' | 'library_accepted' | 'library_rejected'
  | 'archive_proposed' | 'archive_approved' | 'archive_rejected'
  | 'reverify_requested' | 'reconfirmed' | 'outdated' | 'opened_to_organization';
interface View {
  id: string;
  level: Level;
  hall: string;
  proof: string;
  status: Status;
  statusTitle: string;
  review: 'none' | 'library_proposed' | 'archive_proposed';
  kind: Kind;
  kindTitle: string;
  archiveCategoryTitle: string | null;
  title: string;
  visibility: 'sources' | 'organization';
  visibilityNote: string;
  version: number;
  card: Card;
  initiator: string | null;
  responsible: string[];
  lastVerifiedAt: string | null;
  createdAt: string;
  creator: string;
  sources: { type: string; label: string; detail?: string; available: boolean; note: string | null; addedBy: string; link: string | null }[];
  applications: { number: number; title: string; note: string | null; recordedBy: string; implemented: boolean; at: string }[];
  versions: { version: number; title: string; card: Card; reason: string; author: string; at: string }[];
  transitions: { action: string; title: string; reason: string | null; actor: string; at: string; version: number }[];
  timeline: TimelineEvent[];
  can: Partial<Record<ActionId | 'revise' | 'addSource' | 'addApplication', boolean>>;
  roles: { archivist: boolean; approver: boolean; curator: boolean };
}
type ArchivistAi =
  | { connected: false; note: string }
  | { connected: true; ok: false; model: string; remote: boolean; note: string }
  | {
      connected: true;
      ok: true;
      model: string;
      remote: boolean;
      summary: string;
      verdict: 'ready' | 'needs_work';
      duplicates: { id: string; title: string; hall: string; why: string }[];
      contradictions: { id: string; title: string; hall: string; why: string }[];
      related: { number: number; title: string; why: string }[];
      gaps: string[];
      note: string;
    };
interface Helper {
  label: string;
  ai: { connected: boolean; note: string };
  similar: { id: string; title: string; hall: string; score: number }[];
  items: { number: number; title: string; status: string; suggestion: string }[];
  contradictions: { id: string; title: string; note: string }[];
  note: string;
  noteLabel: string;
}

const KINDS: { id: Kind; label: string }[] = [
  { id: 'problem', label: 'Проблема' },
  { id: 'decision', label: 'Решение' },
  { id: 'method', label: 'Метод' },
  { id: 'improvement', label: 'Улучшение' },
  { id: 'discovery', label: 'Открытие' },
  { id: 'lesson', label: 'Урок из ошибки' },
  { id: 'history', label: 'Историческое решение' },
];
const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'method', label: 'Проверенный воспроизводимый метод' },
  { id: 'improvement', label: 'Подтверждённое улучшение' },
  { id: 'reapplied', label: 'Повторно успешно применённое решение' },
  { id: 'discovery', label: 'Важное инженерное открытие' },
  { id: 'lesson', label: 'Существенная ошибка с доказанным уроком' },
  { id: 'history', label: 'Исторически значимое решение' },
];
const FIELDS: { key: keyof Card; label: string; hint?: string }[] = [
  { key: 'problem', label: 'Исходная проблема' },
  { key: 'options', label: 'Рассмотренные варианты' },
  { key: 'argumentsFor', label: 'Аргументы за' },
  { key: 'argumentsAgainst', label: 'Аргументы против' },
  { key: 'decision', label: 'Принятое решение' },
  { key: 'reasons', label: 'Причины выбора' },
  { key: 'results', label: 'Результаты', hint: 'Что получилось, с цифрами, если они есть' },
  { key: 'positive', label: 'Положительный опыт' },
  { key: 'negative', label: 'Отрицательный опыт' },
  { key: 'evidence', label: 'Доказательства', hint: 'Акты, отчёты, замеры. Сами источники перечислены отдельно' },
];
const ARCHIVE_FIELDS: { key: keyof Card; label: string; hint?: string }[] = [
  { key: 'proof', label: 'Доказанность', hint: 'Чем подтверждено: отчёт о внедрении, замер, повторное применение' },
  { key: 'applicability', label: 'Область применимости', hint: 'Где метод работает и где нет' },
  { key: 'basis', label: 'Основания включения', hint: 'Почему это наследие компании' },
];
const ACTION: Record<ActionId, { label: string; reason: 'required' | 'optional' | 'none'; hint?: string; primary?: boolean }> = {
  library_proposed: { label: 'Предложить в Библиотеку', reason: 'required', hint: 'Почему запись готова: решение принято, результат известен' },
  library_accepted: { label: 'Внести в Библиотеку', reason: 'optional', primary: true, hint: 'Вы проверили происхождение, доказательства и классификацию' },
  library_rejected: { label: 'Вернуть на доработку', reason: 'required' },
  archive_proposed: { label: 'Представить заключение Совету', reason: 'required', primary: true, hint: 'Заключение — поля «Доказанность», «Применимость», «Дата проверки», «Основания» в текущей версии' },
  archive_approved: { label: 'Утвердить включение в Высший Архив', reason: 'optional', primary: true },
  archive_rejected: { label: 'Отклонить включение', reason: 'required' },
  reverify_requested: { label: 'Запросить повторную проверку', reason: 'required', hint: 'Что изменилось: оборудование, процесс, новые данные' },
  reconfirmed: { label: 'Подтвердить повторно', reason: 'optional' },
  outdated: { label: 'Отметить как устаревшее', reason: 'required', hint: 'История и все версии сохранятся' },
  opened_to_organization: {
    label: 'Открыть всей организации',
    reason: 'required',
    hint: 'Подтвердите, что в карточке нет содержания закрытых заседаний. Сами заседания останутся видны только участникам',
  },
};
const ORDER: ActionId[] = ['library_accepted', 'archive_proposed', 'archive_approved', 'library_proposed', 'reconfirmed', 'library_rejected', 'archive_rejected', 'reverify_requested', 'opened_to_organization', 'outdated'];

const hashParams = () => new URLSearchParams(location.hash.split('?')[1] ?? '');

const readHall = (): Level | 'all' => {
  const h = hashParams().get('hall');
  return h === 'chronicle' || h === 'library' || h === 'archive' ? h : 'all';
};
/** The server returns at most this many rows: the catalogue says so instead of passing a part for the whole. */
const LIST_LIMIT = 200;

// ---------------------------------------------------------------------------
// The library: three doors, one search
// ---------------------------------------------------------------------------
export function Library() {
  const worldBack = useWorldBack();
  const s = useSession();
  const [hall, setHall] = useState<Level | 'all'>(readHall);
  const [q, setQ] = useState(() => hashParams().get('q') ?? '');
  const [query, setQuery] = useState(() => q.trim());
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  // The address keeps the hall and the query, so a link opens the same catalogue.
  useEffect(() => {
    const p = new URLSearchParams();
    if (hall !== 'all') p.set('hall', hall);
    if (query) p.set('q', query);
    const tail = p.toString();
    const next = `#/library${tail ? `?${tail}` : ''}`;
    // Only while the catalogue is the open screen: a person who has already gone back (the browser's
    // «Назад» right after entering) must not have the address rewritten under them.
    if (!/^#\/library(\?|$)/.test(location.hash)) return;
    if (location.hash !== next) history.replaceState(null, '', next);
  }, [hall, query]);
  // A link that leads here while the library is open — the archive on the map, a crumb — changes the hall too.
  useEffect(() => {
    const sync = () => {
      if (!/^#\/library(\?|$)/.test(location.hash)) return;
      setHall(readHall());
      const next = hashParams().get('q') ?? '';
      setQ((cur) => (cur.trim() === next ? cur : next));
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const { data, error, loading, reload } = useLoad(
    () => api<ListData>(`/orgs/${s.org}/knowledge${qs({ q: query || undefined, kind: kind || undefined, status: status || undefined })}`),
    [s.org, query, kind, status],
  );
  const counts = useMemo(() => (data ? (Object.fromEntries(HALLS.map((h) => [h.id, data.items.filter((i) => i.level === h.id).length])) as Record<Level, number>) : null), [data]);
  const shown = (data?.items ?? []).filter((i) => hall === 'all' || i.level === hall);
  const curator = data?.roles.curator ?? (s.isLead || s.isAdmin || s.isArchivist);
  const filtered = !!(query || kind || status);
  const clear = () => {
    setQ('');
    setQuery('');
    setKind('');
    setStatus('');
  };

  return (
    <div className="gc library" data-level={hall === 'all' ? undefined : hall}>
      <HallHero
        hall={hall}
        crumbs={hall === 'all' ? null : <Crumbs trail={[{ label: 'Великая библиотека', href: '#/library' }, { label: hallOf(hall).name }]} />}
        actions={
          <>
            {curator ? (
              <a className="btn primary" href="#/library/new">
                Создать запись
              </a>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => {
                search.current?.focus();
                search.current?.scrollIntoView({ block: 'center' });
              }}
            >
              Найти знание
            </button>
            <a className="btn quiet" href={worldBack?.href ?? "#/kingdom"}>
              {worldBack?.label ?? "Вернуться в Содружество"}
            </a>
          </>
        }
      />

      <HallNavigation hall={hall} counts={counts} total={data ? data.items.length : null} filtered={filtered} onChange={setHall} />

      <section className="gc-search" aria-label="Поиск по библиотеке">
        <label htmlFor="lib-q" className="gc-search-label">
          Какое решение или опыт вы ищете?
        </label>
        <div className="gc-search-field">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path d="M10.500 4a6.500 6.500 0 1 0 4.100 11.550L19 20M10.500 4a6.500 6.500 0 0 1 4.100 11.550" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input id="lib-q" ref={search} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="пусконаладка, повторные ошибки, закупки" aria-describedby="lib-q-hint" autoComplete="off" />
          {q ? (
            <button
              type="button"
              className="gc-search-clear"
              onClick={() => {
                setQ('');
                search.current?.focus();
              }}
            >
              Очистить
            </button>
          ) : null}
        </div>
        <p id="lib-q-hint" className="gc-hint">
          Например: как сократить время пусконаладки, устранить повторные ошибки, улучшить процесс закупок. Поиск идёт по словам названия и карточки, во всех залах, среди знаний, доступных вам.
        </p>
        <div className="gc-filters">
          <div className="field">
            <label htmlFor="lib-kind">Тип знания</label>
            <select id="lib-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Любой</option>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="lib-status">Состояние</label>
            <select id="lib-status" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Любое</option>
              <option value="active">Действует</option>
              <option value="needs_review">Требует проверки</option>
              <option value="outdated">Устарело</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="lib-hall">Зал</label>
            <select id="lib-hall" className="select" value={hall} onChange={(e) => setHall(e.target.value as Level | 'all')}>
              <option value="all">Все залы</option>
              {HALLS.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
          {filtered || hall !== 'all' ? (
            <button
              type="button"
              className="btn quiet"
              onClick={() => {
                clear();
                setHall('all');
              }}
            >
              Очистить фильтры
            </button>
          ) : null}
        </div>
      </section>

      {s.isArchivist ? (
        <p className="notice">Вы Архивариус. Роль даёт право проверять и представлять знания, но не открывает закрытые заседания: вы видите только то, что доступно вам по источникам.</p>
      ) : null}

      <section className="gc-catalogue" aria-label="Каталог знаний">
        {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
        {loading && !data ? <VolumeSkeleton /> : null}
        {data ? (
          <>
            <p className="gc-result" aria-live="polite">
              {shown.length
                ? filtered
                  ? `Найдено: ${shown.length}${hall === 'all' ? '' : ` в зале «${hallOf(hall).name}»`}`
                  : hall === 'all'
                    ? `Доступно вам: ${shown.length}`
                    : `В зале «${hallOf(hall).name}» доступно вам: ${shown.length}`
                : ''}
              {data.items.length >= LIST_LIMIT ? ` Показаны первые ${LIST_LIMIT} записей — уточните запрос, чтобы увидеть остальные.` : ''}
            </p>
            {shown.length ? (
              <ol className="gc-volumes">
                {shown.map((r) => (
                  <li key={r.id}>
                    <KnowledgeVolumeCard r={r} />
                  </li>
                ))}
              </ol>
            ) : filtered ? (
              <div className="gc-empty">
                <p className="gc-empty-title">По вашему запросу среди доступных знаний ничего не найдено</p>
                <p>{hall !== 'all' && data.items.length ? `В других залах по этому запросу есть записи: ${data.items.length}.` : 'Попробуйте другое слово или снимите фильтры.'}</p>
                <div className="row">
                  <button type="button" className="btn" onClick={clear}>
                    Очистить поиск
                  </button>
                  {hall !== 'all' && data.items.length ? (
                    <button type="button" className="btn quiet" onClick={() => setHall('all')}>
                      Искать во всех залах
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="gc-empty">
                <p className="gc-empty-title">{hall === 'all' ? 'В библиотеке пока нет записей, доступных вам' : `В зале «${hallOf(hall).name}» пока нет записей, доступных вам`}</p>
                <p>{hallOf(hall === 'all' ? 'chronicle' : hall).from}</p>
                {hall !== 'all' ? (
                  <button type="button" className="btn" onClick={() => setHall('all')}>
                    Все залы
                  </button>
                ) : null}
              </div>
            )}
          </>
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card editor (registration and new versions)
// ---------------------------------------------------------------------------
/** The fields of a card in the order a case is told: the problem, the decision, what was done, what came of it. */
const GROUPS: { title: string; keys: (keyof Card)[] }[] = [
  { title: 'Проблема и варианты', keys: ['problem', 'options'] },
  { title: 'Решение и доводы', keys: ['decision', 'argumentsFor', 'argumentsAgainst', 'reasons'] },
  { title: 'Результат и опыт', keys: ['results', 'positive', 'negative', 'evidence'] },
];
const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f])) as Record<string, (typeof FIELDS)[number]>;

function CardForm({ card, onChange, archive }: { card: Card; onChange: (c: Card) => void; archive: boolean }) {
  const s = useSession();
  const members = (s.directory?.members ?? []).filter((m) => m.access === 'member');
  const set = (k: keyof Card, v: unknown) => onChange({ ...card, [k]: v });
  const actions = card.actions ?? [];
  const group = (g: (typeof GROUPS)[number]) => (
    <fieldset className="gc-group plain-fieldset" key={g.title}>
      <legend className="gc-group-title">{g.title}</legend>
      {g.keys.map((key) => {
        const f = FIELD[key]!;
        return (
          <div className="field" key={f.key}>
            <label htmlFor={`k-${f.key}`}>{f.label}</label>
            <textarea id={`k-${f.key}`} className="textarea" rows={f.key === 'problem' || f.key === 'decision' ? 3 : 2} value={(card[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />
            {f.hint ? <span className="hint">{f.hint}</span> : null}
          </div>
        );
      })}
    </fieldset>
  );
  return (
    <div className="stack card-form">
      {group(GROUPS[0]!)}
      {group(GROUPS[1]!)}
      <fieldset className="gc-group plain-fieldset">
        <legend className="gc-group-title">Кто и что сделал</legend>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="k-initiator">Автор инициативы</label>
            <select id="k-initiator" className="select" value={card.initiator ?? ''} onChange={(e) => set('initiator', e.target.value || undefined)}>
              <option value="">Не указан</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="field plain-fieldset">
            <legend className="label">Ответственные</legend>
            <div className="pick-list compact">
              {members.map((m) => (
                <label key={m.membershipId} className="check">
                  <input
                    type="checkbox"
                    checked={(card.responsible ?? []).includes(m.membershipId)}
                    onChange={(e) => set('responsible', e.target.checked ? [...(card.responsible ?? []), m.membershipId] : (card.responsible ?? []).filter((x) => x !== m.membershipId))}
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <fieldset className="field plain-fieldset">
          <legend className="label">Действия и сроки</legend>
          {actions.map((a, i) => (
            <div className="row" key={i}>
              <input className="input grow" aria-label={`Действие ${i + 1}`} value={a.what} onChange={(e) => set('actions', actions.map((x, j) => (j === i ? { ...x, what: e.target.value } : x)))} />
              <input className="input" type="date" aria-label={`Срок действия ${i + 1}`} value={a.due ?? ''} onChange={(e) => set('actions', actions.map((x, j) => (j === i ? { ...x, due: e.target.value || undefined } : x)))} />
              <button type="button" className="btn quiet small" onClick={() => set('actions', actions.filter((_, j) => j !== i))}>
                Убрать
              </button>
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => set('actions', [...actions, { what: '' }])}>
            Добавить действие
          </button>
        </fieldset>
      </fieldset>
      {group(GROUPS[2]!)}
      {archive ? (
        <fieldset className="gc-group archive-fields">
          <legend className="gc-group-title">Заключение для Высшего Архива</legend>
          <div className="field">
            <label htmlFor="k-cat">Категория наследия</label>
            <select id="k-cat" className="select" value={card.archiveCategory ?? ''} onChange={(e) => set('archiveCategory', e.target.value || undefined)}>
              <option value="">Не выбрана</option>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="hint">Метод и повторно применённое решение требуют подтверждённого повторного применения; улучшение — подтверждённого эффекта; урок — описанного отрицательного опыта.</span>
          </div>
          {ARCHIVE_FIELDS.map((f) => (
            <div className="field" key={f.key}>
              <label htmlFor={`k-${f.key}`}>{f.label}</label>
              <textarea id={`k-${f.key}`} className="textarea" rows={2} value={(card[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />
              {f.hint ? <span className="hint">{f.hint}</span> : null}
            </div>
          ))}
          <div className="field">
            <label htmlFor="k-checked">Дата последней проверки</label>
            <input id="k-checked" className="input" type="date" value={card.lastChecked ?? ''} onChange={(e) => set('lastChecked', e.target.value || undefined)} />
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

const clean = (c: Card): Card => ({
  ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== '' && v !== undefined && !(Array.isArray(v) && !v.length))),
  ...(c.actions?.length ? { actions: c.actions.filter((a) => a.what.trim().length >= 2) } : {}),
});

export function NewKnowledge() {
  const s = useSession();
  const p = hashParams();
  const idea = Number(p.get('idea')) || null;
  const meeting = p.get('meeting');
  const [kind, setKind] = useState<Kind>('decision');
  const [title, setTitle] = useState('');
  const [card, setCard] = useState<Card>({});
  const [ideas, setIdeas] = useState(idea ? String(idea) : '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!idea) return;
    void api<{ kind: Kind; title: string; card: Card; note: string }>(`/orgs/${s.org}/ideas/${idea}/knowledge-draft`)
      .then((d) => {
        setKind(d.kind);
        setTitle(d.title);
        setCard(d.card);
        setNote(d.note);
      })
      .catch((e) => setErr(errorText(e)));
  }, [s.org, idea]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const sources = [...numbers.map((n) => ({ type: 'idea', number: n })), ...(meeting ? [{ type: 'meeting', id: meeting }] : [])];
      const r = await api<{ id: string }>(`/orgs/${s.org}/knowledge`, { method: 'POST', json: { kind, title, card: clean(card), sources, reason: reason || undefined } });
      s.toast('Запись внесена в Летопись');
      go(`/library/${r.id}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const numbers = ideas.split(/[\s,;№#]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const hasSource = numbers.length > 0 || !!meeting;
  const ready = title.trim().length >= 3 && hasSource;

  return (
    <div className="gc library">
      <header className="gc-form-head">
        <Crumbs trail={[{ label: 'Великая библиотека', href: '#/library' }, { label: 'Летопись', href: '#/library?hall=chronicle' }, { label: 'Новая запись' }]} />
        <h1 className="gc-display">Новая запись в Летописи</h1>
        <p className="gc-hero-note">
          Запись ссылается на источники и не копирует их. Расшифровки заседаний пересказывайте своими словами. Людей указывайте в полях «Автор инициативы» и «Ответственные», без телефонов, адресов и других личных сведений в тексте.
        </p>
      </header>
      {note ? <p className="notice">{note}</p> : null}
      <div className="gc-form-grid">
        <form
          className="gc-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset className="gc-step">
            <legend>
              <span className="gc-step-mark" aria-hidden="true">
                A
              </span>
              Что мы хотим сохранить?
            </legend>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="k-title">
                  Название <span className="req">обязательно</span>
                </label>
                <input id="k-title" className="input" required minLength={3} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
                <span className="hint">Так, чтобы коллега нашёл запись поиском: что решали и где.</span>
              </div>
              <div className="field">
                <label htmlFor="k-kind">
                  Вид знания <span className="req">обязательно</span>
                </label>
                <select id="k-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  {KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <span className="hint">Неудачный опыт тоже знание: для него есть «Урок из ошибки».</span>
              </div>
            </div>
          </fieldset>

          <fieldset className="gc-step">
            <legend>
              <span className="gc-step-mark" aria-hidden="true">
                B
              </span>
              Откуда это известно?
            </legend>
            <div className="field">
              <label htmlFor="k-sources">
                Обращения-источники <span className="req">{meeting ? 'по желанию' : 'обязательно'}</span>
              </label>
              <input id="k-sources" className="input" inputMode="numeric" value={ideas} onChange={(e) => setIdeas(e.target.value)} placeholder="номера через запятую, например 12, 15" />
              <span className="hint">
                {meeting ? 'Заседание добавлено источником. ' : ''}Без источника запись не регистрируется. Сослаться можно только на то, что доступно вам.
              </span>
            </div>
          </fieldset>

          <fieldset className="gc-step">
            <legend>
              <span className="gc-step-mark" aria-hidden="true">
                C
              </span>
              Какой опыт получили?
            </legend>
            <p className="gc-hint">Все поля этого раздела необязательны. Заполните то, что известно сейчас: остальное добавится новой версией карточки.</p>
            <CardForm card={card} onChange={setCard} archive={false} />
          </fieldset>

          <fieldset className="gc-step">
            <legend>
              <span className="gc-step-mark" aria-hidden="true">
                D
              </span>
              Сохранение
            </legend>
            <div className="field">
              <label htmlFor="k-reason">
                Комментарий к записи <span className="req">по желанию</span>
              </label>
              <input id="k-reason" className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="например: итог разбора приёмки" />
            </div>
            {err ? (
              <div className="notice error" role="alert">
                {err}
              </div>
            ) : null}
            {!ready ? <p className="gc-hint">{title.trim().length < 3 ? 'Чтобы внести запись, укажите название.' : 'Чтобы внести запись, укажите хотя бы одно обращение-источник.'}</p> : null}
            <div className="row">
              <button className="btn primary" disabled={busy || title.trim().length < 3}>
                {busy ? 'Вносим…' : 'Внести в Летопись'}
              </button>
              <a className="btn quiet" href="#/library?hall=chronicle">
                Отмена
              </a>
            </div>
          </fieldset>
        </form>

        <aside className="gc-form-side" aria-label="О новой записи">
          <h2 className="gc-h">Что обязательно</h2>
          <p>Название, вид знания и хотя бы один источник. Остальное можно дополнить позже.</p>
          <h2 className="gc-h">Кто увидит запись</h2>
          <p>Те, кому доступны её источники. Открыть карточку всей организации может ответственный за решения или администратор.</p>
          <h2 className="gc-h">Что будет после сохранения</h2>
          <p>
            Запись появится в Летописи с отметкой «{hallOf('chronicle').proof}». В Библиотеку решений она попадёт только после проверки Архивариусом, в Высший Архив — после утверждения.
          </p>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One piece of knowledge
// ---------------------------------------------------------------------------
function changedFields(a: Card, b: Card | undefined): string[] {
  if (!b) return [];
  const all = [...FIELDS, ...ARCHIVE_FIELDS, { key: 'actions' as const, label: 'Действия и сроки' }, { key: 'archiveCategory' as const, label: 'Категория' }, { key: 'lastChecked' as const, label: 'Дата проверки' }, { key: 'responsible' as const, label: 'Ответственные' }];
  return all.filter((f) => JSON.stringify(a[f.key] ?? null) !== JSON.stringify(b[f.key] ?? null)).map((f) => f.label);
}

/** What the level means for the reader, next to the server's own wording of it. */
const PROOF_NOTE: Record<Level, string> = {
  chronicle: 'Запись зарегистрирована, её ещё никто не проверял. Читайте её как свидетельство о том, что было, а не как рекомендацию.',
  library: 'Архивариус проверил происхождение, доказательства и классификацию этой записи.',
  archive: 'Знание утверждено как наследие. Оно действует в пределах своей области применимости и может быть пересмотрено.',
};

export function KnowledgePage({ id }: { id: string }) {
  const worldBack = useWorldBack();
  const s = useSession();
  const { data: k, error, loading, reload } = useLoad(() => api<View>(`/orgs/${s.org}/knowledge/${id}`), [s.org, id]);
  const [helper, setHelper] = useState<Helper | null>(null);
  const [helperErr, setHelperErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [vault, setVault] = useState<string | null>(null);

  if (error) {
    // No access and «no such record» look the same on purpose: nothing about a closed record is revealed.
    const closed = error instanceof ApiError && (error.status === 404 || error.status === 403);
    return (
      <div className="gc library">
        <Crumbs trail={[{ label: 'Великая библиотека', href: '#/library' }, { label: closed ? 'Том недоступен' : 'Том не открылся' }]} />
        {closed ? (
          <div className="gc-empty">
            <p className="gc-empty-title">Этот том вам недоступен</p>
            <p>Такой записи нет, или она ссылается на источники, которые закрыты для вас. Содержание закрытых записей здесь не показывается.</p>
            <div className="row">
              <a className="btn" href="#/library">
                К каталогу библиотеки
              </a>
              <a className="btn quiet" href={worldBack?.href ?? "#/kingdom"}>
                {worldBack?.label ?? "Вернуться в Содружество"}
              </a>
            </div>
          </div>
        ) : (
          <ErrorBox error={error} retry={() => void reload()} />
        )}
      </div>
    );
  }
  if (loading && !k) return <Loading label="Открываем том…" rows={6} />;
  if (!k) return null;
  const c = k.card;
  const why = [...k.transitions].reverse().find((t) => t.action === (k.status === 'outdated' ? 'outdated' : 'reverify_requested'))?.reason;
  const waiting = k.review === 'library_proposed' ? 'ждёт проверки Архивариусом' : k.review === 'archive_proposed' ? 'заключение ждёт утверждения ответственным за решения' : null;

  return (
    <div className="gc library gc-volume" data-level={k.level}>
      <header className="gc-open" data-level={k.level}>
        <Crumbs trail={[{ label: 'Великая библиотека', href: '#/library' }, { label: k.hall, href: `#/library?hall=${k.level}` }, { label: k.title }]} />
        <div className="gc-open-head">
          <div className="gc-open-title">
            <h1 className="gc-display">{k.title}</h1>
            <dl className="gc-open-meta">
              <div>
                <dt>Тип</dt>
                <dd>{k.kindTitle}</dd>
              </div>
              <div>
                <dt>Версия</dt>
                <dd>{k.version}</dd>
              </div>
              <div>
                <dt>Последняя проверка</dt>
                <dd>{k.lastVerifiedAt ? date(k.lastVerifiedAt) : 'не проводилась'}</dd>
              </div>
              <div>
                <dt>Внёс(ла)</dt>
                <dd>
                  {k.creator}, {date(k.createdAt)}
                </dd>
              </div>
            </dl>
          </div>
          {k.level === 'archive' ? <ArchiveSeal size={76} title="Печать Высшего Архива: знание утверждено как наследие" /> : null}
        </div>
        <div className="gc-open-proof">
          <KnowledgeProofBadge level={k.level} proof={k.proof} large />
          <p>{PROOF_NOTE[k.level]}</p>
        </div>
        {k.status === 'outdated' ? (
          <p className="gc-alert outdated" role="note">
            <b>Запись устарела.</b> Карточка и вся история сохранены, чтобы было видно, что и почему решали раньше. {why ?? ''}
          </p>
        ) : null}
        {k.status === 'needs_review' ? (
          <p className="gc-alert review" role="note">
            <b>Запись требует повторной проверки.</b> Что-то изменилось с момента утверждения; до проверки применяйте её с оглядкой. {why ?? ''}
          </p>
        ) : null}
        <div className="gc-open-nav">
          <a href={`#/library?hall=${k.level}`}>К каталогу зала «{k.hall}»</a>
          <a href="#/kingdom">На карту Содружества</a>
        </div>
      </header>

      <div className="gc-read">
        <aside className="gc-read-aside" aria-label="Паспорт, действия и история знания">
        <div className="gc-read-side">
          <section className="gc-passport" aria-labelledby="pass-h">
            <h2 className="gc-h" id="pass-h">
              Паспорт знания
            </h2>
            <dl>
              <dt>Уровень</dt>
              <dd>
                {k.hall} — {k.proof}
              </dd>
              <dt>Состояние</dt>
              <dd>
                {k.statusTitle.charAt(0).toUpperCase() + k.statusTitle.slice(1)}
                {waiting ? `; ${waiting}` : ''}
              </dd>
              {k.archiveCategoryTitle ? (
                <>
                  <dt>Категория наследия</dt>
                  <dd>{k.archiveCategoryTitle}</dd>
                </>
              ) : null}
              <dt>Автор инициативы</dt>
              <dd>{k.initiator ?? <span className="gc-none">Не указан</span>}</dd>
              <dt>Ответственные</dt>
              <dd>{k.responsible.length ? k.responsible.join(', ') : <span className="gc-none">Не указаны</span>}</dd>
              <dt>Версия</dt>
              <dd>
                <a href="#ver-h" onClick={jump('ver-h')}>
                  {k.version} из {k.versions.length}
                </a>
              </dd>
              <dt>Проверка</dt>
              <dd>{k.lastVerifiedAt ? date(k.lastVerifiedAt) : <span className="gc-none">Не проводилась</span>}</dd>
              <dt>Источники</dt>
              <dd>
                <a href="#src-h" onClick={jump('src-h')}>
                  Показать источники: {k.sources.length}
                </a>
              </dd>
              <dt>Область применимости</dt>
              <dd>{c.applicability ?? <span className="gc-none">Не указана</span>}</dd>
            </dl>
          </section>
          <Actions k={k} onDone={(action) => {
            if (action === 'archive_approved') setVault(k.title);
            void reload();
          }} />
        </div>
        <div className="gc-read-more">
          <section className="gc-panel" aria-labelledby="hist-h">
            <h2 className="gc-h" id="hist-h">
              История переходов
            </h2>
            <ol className="plain k-list">
              {k.transitions.map((t, i) => (
                <li key={i}>
                  <span>{t.title}</span>
                  <div className="xs muted">
                    {t.actor}, {dateTime(t.at)}, версия {t.version}
                  </div>
                  {t.reason ? <div className="xs">{t.reason}</div> : null}
                </li>
              ))}
            </ol>
          </section>
          <section className="gc-panel stack" aria-labelledby="help-h">
            <h2 className="gc-h" id="help-h">Помощник Архивариуса</h2>
            {helper ? (
              <div className="stack">
                <p className="xs notice warn">{helper.label}</p>
                {s.roles.some((r) => ['archivist', 'maintainer', 'decision_owner', 'org_admin'].includes(r)) ? <ArchivistAiBox id={k.id} /> : <p className="xs faint">AI-Архивариуса запускает Архивариус или руководитель.</p>}
                <div>
                  <h3 className="small">Краткая справка</h3>
                  <p className="small">{helper.note}</p>
                  <p className="xs faint">{helper.noteLabel}</p>
                </div>
                <div>
                  <h3 className="small">Похожие знания</h3>
                  {helper.similar.length ? (
                    <ul className="plain k-list">
                      {helper.similar.map((x) => (
                        <li key={x.id}>
                          <a href={`#/library/${x.id}`}>{x.title}</a> <span className="xs faint">{x.hall}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="xs muted">Не найдено.</p>
                  )}
                </div>
                {helper.contradictions.length ? (
                  <div>
                    <h3 className="small">Возможные противоречия</h3>
                    <ul className="plain k-list">
                      {helper.contradictions.map((x) => (
                        <li key={x.id}>
                          <a href={`#/library/${x.id}`}>{x.title}</a>
                          <div className="xs flag">{x.note}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div>
                  <h3 className="small">Обращения, которые могут быть связаны</h3>
                  {helper.items.length ? (
                    <ul className="plain k-list">
                      {helper.items.map((x) => (
                        <li key={x.number}>
                          <a href={`#/items/${x.number}`}>№{x.number} «{x.title}»</a>
                          <div className="xs faint">{x.suggestion}</div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="xs muted">Не найдено.</p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <p className="small muted">Ищет похожие знания и связанные обращения по совпадению слов, отмечает возможные противоречия и собирает справку по шаблону. Это не AI-анализ.</p>
                {helperErr ? <p className="notice error">{helperErr}</p> : null}
                <button
                  className="btn"
                  onClick={() =>
                    void api<Helper>(`/orgs/${s.org}/knowledge/${k.id}/helper`)
                      .then(setHelper)
                      .catch((e) => setHelperErr(errorText(e)))
                  }
                >
                  Подобрать связи
                </button>
              </>
            )}
          </section>
        </div>
        </aside>

        <div className="gc-read-main">
          {editing ? (
            <Revise k={k} onDone={() => { setEditing(false); void reload(); }} onCancel={() => setEditing(false)} />
          ) : (
            <article className="gc-page" aria-label="Карточка знания">
              <ReadingSection no="01" title="Суть знания">
                <h3 className="gc-sub">Принятое решение</h3>
                <Prose v={c.decision} />
              </ReadingSection>
              <ReadingSection no="02" title="Исходная проблема">
                <Prose v={c.problem} />
              </ReadingSection>
              <ReadingSection no="03" title="Рассмотренные варианты">
                <Prose v={c.options} />
              </ReadingSection>
              <ReadingSection no="04" title="Почему выбрали это решение">
                <div className="gc-pair">
                  <div className="gc-side for">
                    <h3 className="gc-sub">Аргументы за</h3>
                    <Prose v={c.argumentsFor} />
                  </div>
                  <div className="gc-side against">
                    <h3 className="gc-sub">Аргументы против</h3>
                    <Prose v={c.argumentsAgainst} />
                  </div>
                </div>
                <h3 className="gc-sub">Причины выбора</h3>
                <Prose v={c.reasons} />
              </ReadingSection>
              <ReadingSection no="05" title="Что было сделано">
                {c.actions?.length ? (
                  <ul className="gc-done">
                    {c.actions.map((a, i) => (
                      <li key={i}>
                        {a.what}
                        {a.due ? <span className="gc-due"> — до {date(a.due)}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="gc-none">Действия и сроки не указаны</p>
                )}
                <dl className="gc-who">
                  <div>
                    <dt>Автор инициативы</dt>
                    <dd>{k.initiator ?? <span className="gc-none">Не указан</span>}</dd>
                  </div>
                  <div>
                    <dt>Ответственные</dt>
                    <dd>{k.responsible.length ? k.responsible.join(', ') : <span className="gc-none">Не указаны</span>}</dd>
                  </div>
                </dl>
              </ReadingSection>
              <ReadingSection no="06" title="Какой результат получили">
                <Prose v={c.results} />
              </ReadingSection>
              <ReadingSection no="07" title="Чему научились">
                <div className="gc-pair">
                  <div className="gc-side for">
                    <h3 className="gc-sub">Положительный опыт</h3>
                    <Prose v={c.positive} />
                  </div>
                  <div className="gc-side against">
                    <h3 className="gc-sub">Отрицательный опыт</h3>
                    <Prose v={c.negative} />
                  </div>
                </div>
              </ReadingSection>
              <ReadingSection no="08" title="Где метод применим">
                <h3 className="gc-sub">Область применимости</h3>
                <Prose v={c.applicability} />
                <h3 className="gc-sub" id="apps-h">
                  Повторные применения
                </h3>
                {k.applications.length ? (
                  <ul className="plain k-list">
                    {k.applications.map((a) => (
                      <li key={a.number}>
                        <a href={`#/items/${a.number}`}>№{a.number} «{a.title}»</a>{' '}
                        <span className={a.implemented ? 'tone-pro small' : 'flag'}>{a.implemented ? 'внедрено — подтверждено' : 'ещё не внедрено'}</span>
                        <div className="xs muted">
                          {a.note} Записал(а) {a.recordedBy}, {date(a.at)}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="gc-none">Метод пока не применялся на других обращениях.</p>
                )}
                {k.can.addApplication ? <AddApplication id={k.id} onDone={() => void reload()} /> : null}
              </ReadingSection>
              <ReadingSection no="09" title="Доказательства и источники">
                <h3 className="gc-sub">Доказательства</h3>
                <Prose v={c.evidence} />
                {c.proof || c.basis || c.lastChecked ? (
                  <div className="k-conclusion">
                    <h3>Заключение для Высшего Архива</h3>
                    <dl>
                      <dt>Доказанность</dt>
                      <dd>{c.proof ?? 'Не указана'}</dd>
                      <dt>Основания включения</dt>
                      <dd>{c.basis ?? 'Не указаны'}</dd>
                      <dt>Дата последней проверки</dt>
                      <dd>{c.lastChecked ? date(c.lastChecked) : 'Не указана'}</dd>
                    </dl>
                  </div>
                ) : null}
                <h3 className="gc-sub" id="src-h" tabIndex={-1}>
                  Источники
                </h3>
                <ul className="plain k-list gc-sources">
                  {k.sources.map((src, i) => (
                    <li key={i} className={src.available ? '' : 'k-closed'}>
                      {src.link ? <a href={src.link}>{src.label}</a> : <span>{src.label}</span>}
                      {src.detail ? <div className="xs muted">{src.detail}</div> : null}
                      {src.note ? <div className="xs">{src.note}</div> : null}
                      <div className="xs faint">Добавил(а) {src.addedBy}</div>
                    </li>
                  ))}
                </ul>
                {k.can.addSource ? <AddSource id={k.id} onDone={() => void reload()} /> : null}
                <p className="xs faint">{k.visibilityNote}</p>
              </ReadingSection>
              {k.can.revise ? (
                <div className="row gc-page-foot">
                  <button className="btn" onClick={() => setEditing(true)}>
                    Новая версия карточки
                  </button>
                  <span className="xs faint">Прежние версии и причины изменений сохраняются.</span>
                </div>
              ) : k.level === 'archive' && k.status === 'active' ? (
                <p className="xs faint gc-page-foot">Знание Высшего Архива меняется только после запроса повторной проверки.</p>
              ) : null}
            </article>
          )}

          <section className="gc-panel" aria-labelledby="chron-h">
            <h2 className="gc-h" id="chron-h">
              Летопись событий
            </h2>
            <p className="xs faint">Собрана из записей источников и истории этого знания. Ничего не дописано от руки.</p>
            <KnowledgeTimeline events={k.timeline} />
          </section>

          <section className="gc-panel" aria-labelledby="ver-h">
            <h2 className="gc-h" id="ver-h" tabIndex={-1}>
              Версии и причины пересмотра
            </h2>
            <ol className="plain k-list">
              {k.versions.map((v, i) => {
                const changed = changedFields(v.card, k.versions[i + 1]?.card);
                return (
                  <li key={v.version}>
                    <b>Версия {v.version}</b> <span className="small muted">— {v.author}, {dateTime(v.at)}</span>
                    <div className="small">{v.reason}</div>
                    {changed.length ? <div className="xs faint">Изменено: {changed.join(', ')}</div> : null}
                    <details>
                      <summary className="xs">Показать карточку этой версии</summary>
                      <dl className="k-version">
                        {[...FIELDS, ...ARCHIVE_FIELDS].filter((f) => v.card[f.key]).map((f) => (
                          <div key={f.key}>
                            <dt>{f.label}</dt>
                            <dd>{String(v.card[f.key])}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

      </div>
      {vault ? <Vault title={vault} onClose={() => setVault(null)} /> : null}
    </div>
  );
}
/** A link inside the page: moves the focus to the heading instead of changing the address (the address is the route). */
const jump = (id: string) => (e: { preventDefault: () => void }) => {
  e.preventDefault();
  const el = document.getElementById(id);
  el?.scrollIntoView({ block: 'start' });
  el?.focus({ preventScroll: true });
};

/** AI-Архивариус (ADR-0028): the answer of the connected model, or a plain «не подключён». */
function ArchivistAiBox({ id }: { id: string }) {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<ArchivistAi | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ask = () => {
    setBusy(true);
    setErr(null);
    void api<ArchivistAi>(`/orgs/${s.org}/knowledge/${id}/helper/ai`, { method: 'POST', idempotent: false })
      .then(setR)
      .catch((e) => setErr(errorText(e)))
      .finally(() => setBusy(false));
  };
  const links = (title: string, list: { id: string; title: string; hall: string; why: string }[]) =>
    list.length ? (
      <div>
        <h3 className="small">{title}</h3>
        <ul className="plain k-list">
          {list.map((x) => (
            <li key={x.id}>
              <a href={`#/library/${x.id}`}>{x.title}</a> <span className="xs faint">{x.hall}</span>
              <div className="xs">{x.why}</div>
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="stack archivist-ai">
      <button className="btn" onClick={ask} disabled={busy}>
        {busy ? 'Модель читает карточку…' : r && r.connected && r.ok ? 'Спросить AI-Архивариуса ещё раз' : 'Спросить AI-Архивариуса'}
      </button>
      <div aria-live="polite" className="stack">
        {err ? <p className="notice error">{err}</p> : null}
        {r && !r.connected ? <p className="xs notice">{r.note}</p> : null}
        {r && r.connected && !r.ok ? <p className="xs notice warn">{r.note}</p> : null}
        {r && r.connected && r.ok ? (
          <section className="stack" aria-label="Заключение языковой модели">
            <p className="small">
              <b>{r.verdict === 'ready' ? 'Карточка понятна и применима.' : 'Карточку стоит доработать.'}</b> {r.summary}
            </p>
            {r.gaps.length ? (
              <div>
                <h3 className="small">Чего не хватает</h3>
                <ul className="small">
                  {r.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {links('Повторяют это знание', r.duplicates)}
            {links('Возможные противоречия', r.contradictions)}
            {r.related.length ? (
              <div>
                <h3 className="small">Где можно применить</h3>
                <ul className="plain k-list">
                  {r.related.map((x) => (
                    <li key={x.number}>
                      <a href={`#/items/${x.number}`}>№{x.number} «{x.title}»</a>
                      <div className="xs">{x.why}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="xs faint">
              Отвечала {r.model}. {r.note}
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Actions({ k, onDone }: { k: View; onDone: (a: ActionId) => void }) {
  const s = useSession();
  const [open, setOpen] = useState<ActionId | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const allowed = ORDER.filter((a) => k.can[a]);
  const waiting =
    k.review === 'library_proposed'
      ? 'Запись предложена в Библиотеку и ждёт проверки Архивариусом.'
      : k.review === 'archive_proposed'
        ? 'Заключение Архивариуса ждёт утверждения ответственным за решения.'
        : null;

  async function run(a: ActionId) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/knowledge/${k.id}/actions`, { method: 'POST', json: { action: a, reason: reason.trim() || undefined } });
      s.toast(a === 'archive_approved' ? 'Включено в Высший Архив' : a === 'library_accepted' ? 'Внесено в Библиотеку' : 'Сохранено');
      setOpen(null);
      setReason('');
      onDone(a);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="gc-panel stack k-actions-panel" aria-labelledby="act-h">
      <h2 className="gc-h" id="act-h">Действия</h2>
      {waiting ? <p className="small">{waiting}</p> : null}
      {allowed.length ? (
        <div className="stack">
          {allowed.map((a) =>
            open === a ? (
              <div key={a} className="stack k-confirm">
                <label className="small" htmlFor="act-reason">
                  {ACTION[a].reason === 'required' ? 'Причина (обязательно)' : 'Комментарий'}
                </label>
                <textarea id="act-reason" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                {ACTION[a].hint ? <span className="xs faint">{ACTION[a].hint}</span> : null}
                {err ? (
                  <p className="notice error" role="alert">
                    {err}
                  </p>
                ) : null}
                <div className="row">
                  <button className="btn primary" disabled={busy || (ACTION[a].reason === 'required' && reason.trim().length < 5)} onClick={() => void run(a)}>
                    {busy ? 'Сохраняем…' : ACTION[a].label}
                  </button>
                  <button className="btn quiet" onClick={() => { setOpen(null); setErr(null); }}>
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <button key={a} className={ACTION[a].primary ? 'btn primary' : 'btn'} disabled={open !== null} onClick={() => { setOpen(a); setReason(''); setErr(null); }}>
                {ACTION[a].label}
              </button>
            ),
          )}
        </div>
      ) : (
        <p className="small muted">{waiting ? 'Решение — за другим человеком.' : 'Для вас действий с этой записью нет.'}</p>
      )}
      <p className="xs faint">Переходы между залами — только по решению людей с ролью. Лайки, XP и просмотры уровень не меняют.</p>
    </section>
  );
}

function Revise({ k, onDone, onCancel }: { k: View; onDone: () => void; onCancel: () => void }) {
  const s = useSession();
  const [title, setTitle] = useState(k.title);
  const [card, setCard] = useState<Card>(k.card);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="gc-page stack"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        void api(`/orgs/${s.org}/knowledge/${k.id}/versions`, { method: 'POST', json: { title, card: clean(card), reason } })
          .then(() => {
            s.toast('Новая версия сохранена');
            onDone();
          })
          .catch((x) => setErr(errorText(x)))
          .finally(() => setBusy(false));
      }}
    >
      <h2 className="gc-h">Новая версия карточки</h2>
      <div className="field">
        <label htmlFor="r-title">Название</label>
        <input id="r-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />
      </div>
      <CardForm card={card} onChange={setCard} archive={k.level !== 'chronicle' || k.roles.archivist} />
      <div className="field">
        <label htmlFor="r-reason">Причина изменения</label>
        <input id="r-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required placeholder="например: добавлены результаты пилота" />
        <span className="hint">Сохраняется в истории версий вместе с прежней карточкой.</span>
      </div>
      {err ? (
        <div className="notice error" role="alert">
          {err}
        </div>
      ) : null}
      <div className="row">
        <button className="btn primary" disabled={busy || reason.trim().length < 3}>
          {busy ? 'Сохраняем…' : 'Сохранить версию'}
        </button>
        <button type="button" className="btn quiet" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function AddApplication({ id, onDone }: { id: string; onDone: () => void }) {
  const s = useSession();
  const [n, setN] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="row k-inline"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        void api(`/orgs/${s.org}/knowledge/${id}/applications`, { method: 'POST', json: { ideaNumber: Number(n), note } })
          .then(() => {
            setN('');
            setNote('');
            s.toast('Повторное применение записано');
            onDone();
          })
          .catch((x) => setErr(errorText(x)));
      }}
    >
      <input className="input" inputMode="numeric" aria-label="Номер обращения" placeholder="№ обращения" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} style={{ width: '9em' }} />
      <input className="input grow" aria-label="Что применили" placeholder="что и где применили" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn small" disabled={!n || note.trim().length < 5}>
        Записать применение
      </button>
      {err ? (
        <p className="notice error" role="alert">
          {err}
        </p>
      ) : (
        <span className="xs faint">Применение считается подтверждённым, когда по обращению внесён отчёт о внедрении.</span>
      )}
    </form>
  );
}

function AddSource({ id, onDone }: { id: string; onDone: () => void }) {
  const s = useSession();
  const [n, setN] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="row k-inline"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        void api(`/orgs/${s.org}/knowledge/${id}/sources`, { method: 'POST', json: { type: 'idea', number: Number(n) } })
          .then(() => {
            setN('');
            s.toast('Источник добавлен');
            onDone();
          })
          .catch((x) => setErr(errorText(x)));
      }}
    >
      <input className="input" inputMode="numeric" aria-label="Номер обращения-источника" placeholder="№ обращения" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} style={{ width: '9em' }} />
      <button className="btn small" disabled={!n}>
        Добавить источник
      </button>
      {err ? (
        <p className="notice error" role="alert">
          {err}
        </p>
      ) : null}
    </form>
  );
}

/** Plays once after a confirmed approval: the hall doors open and the new volume takes its place on the shelf. */
function Vault({ title, onClose }: { title: string; onClose: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onClose, 4200);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const spines = ['#7a5c2e', '#4f6b5a', '#6a4a86', '#8a3a2e', '#3d5a80', '#7a6a3a'];
  return (
    <div className="vault" role="status" onClick={onClose}>
      <div className="vault-stage" aria-hidden="true">
        <div className="vault-shelf">
          {spines.slice(0, 3).map((c) => (
            <span key={c} className="vault-spine" style={{ background: c }} />
          ))}
          <span className="vault-spine vault-new" />
          {spines.slice(3).map((c) => (
            <span key={c} className="vault-spine" style={{ background: c }} />
          ))}
        </div>
        <span className="vault-door left" />
        <span className="vault-door right" />
      </div>
      <p className="vault-text">
        Том «{title}» занял место в Высшем Архиве
        <span className="small">Включение утверждено и записано в историю</span>
      </p>
    </div>
  );
}
