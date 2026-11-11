import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, errorText, qs } from '../lib/api';
import { date, dateTime } from '../lib/format';
import { go } from '../lib/router';
import { useLoad, useSession } from '../lib/session';
import { ErrorBox, Loading, PageHead } from '../components/ui';

/**
 * «Великая библиотека» (ADR-0017): three halls over one knowledge model.
 * Летопись — registered events; Библиотека решений — cases checked by the archivist;
 * Высший Архив — heritage approved by an authorized person. Every result shows its hall
 * and what that says about checking. Level changes happen only through the buttons
 * below, each a real, recorded act; the archive animation plays after a confirmed one.
 */
type Level = 'chronicle' | 'library' | 'archive';
type Status = 'active' | 'needs_review' | 'outdated';
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
interface Row {
  id: string;
  level: Level;
  hall: string;
  proof: string;
  status: Status;
  statusTitle: string;
  review: string;
  kind: Kind;
  kindTitle: string;
  title: string;
  summary: string;
  visibility: string;
  version: number;
  sources: string[];
  applications: number;
  lastVerifiedAt: string | null;
  stale: boolean;
  updatedAt: string;
}
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
  timeline: { at: string; what: string; who: string | null; source: string; link: string | null }[];
  can: Partial<Record<ActionId | 'revise' | 'addSource' | 'addApplication', boolean>>;
  roles: { archivist: boolean; approver: boolean; curator: boolean };
}
interface Helper {
  label: string;
  ai: { connected: boolean; note: string };
  similar: { id: string; title: string; hall: string; score: number }[];
  items: { number: number; title: string; status: string; suggestion: string }[];
  contradictions: { id: string; title: string; note: string }[];
  note: string;
  noteLabel: string;
}

const HALLS: { id: Level; name: string; what: string }[] = [
  { id: 'chronicle', name: 'Летопись', what: 'события и проблемы, как они были' },
  { id: 'library', name: 'Библиотека решений', what: 'кейсы, проверенные Архивариусом' },
  { id: 'archive', name: 'Высший Архив', what: 'наследие, утверждённое Советом' },
];
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

function HallMark({ level, proof }: { level: Level; proof?: string }) {
  const h = HALLS.find((x) => x.id === level)!;
  return (
    <span className="hall-mark" data-level={level}>
      <span className="hall-mark-name">{h.name}</span>
      {proof ? <span className="hall-mark-proof">{proof}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The library: three doors, one search
// ---------------------------------------------------------------------------
export function Library() {
  const s = useSession();
  const p = hashParams();
  const [hall, setHall] = useState<Level | 'all'>((p.get('hall') as Level) || 'all');
  const [q, setQ] = useState(p.get('q') ?? '');
  const [query, setQuery] = useState(q);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, error, loading, reload } = useLoad(
    () => api<ListData>(`/orgs/${s.org}/knowledge${qs({ q: query || undefined, kind: kind || undefined, status: status || undefined })}`),
    [s.org, query, kind, status],
  );
  const counts = useMemo(() => Object.fromEntries(HALLS.map((h) => [h.id, (data?.items ?? []).filter((i) => i.level === h.id).length])), [data]);
  const shown = (data?.items ?? []).filter((i) => hall === 'all' || i.level === hall);
  const curator = data?.roles.curator ?? (s.isLead || s.isAdmin || s.isArchivist);

  return (
    <div className="stack-lg library">
      <PageHead title="Великая библиотека" sub="Что компания решила, почему, что из этого вышло и чему научились.">
        {curator ? (
          <a className="btn primary" href="#/library/new">
            Новая запись в Летописи
          </a>
        ) : null}
      </PageHead>

      <nav className="halls" aria-label="Залы библиотеки">
        <button type="button" className="hall-door all" aria-pressed={hall === 'all'} onClick={() => setHall('all')}>
          <span className="hall-door-name">Все залы</span>
          <span className="hall-door-what">общий поиск</span>
          <span className="hall-door-count">{data ? data.items.length : '…'}</span>
        </button>
        {HALLS.map((h) => (
          <button key={h.id} type="button" className="hall-door" data-level={h.id} aria-pressed={hall === h.id} onClick={() => setHall(h.id)}>
            <span className="hall-door-name">{h.name}</span>
            <span className="hall-door-what">{h.what}</span>
            <span className="hall-door-count">{data ? counts[h.id] : '…'}</span>
          </button>
        ))}
      </nav>

      <div className="library-filters">
        <div className="field grow">
          <label htmlFor="lib-q">Поиск по всем залам</label>
          <input id="lib-q" className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="например: этикетки, приёмка, инвентаризация" />
          <span className="hint">По словам, среди знаний, доступных вам. У каждого результата — зал и уровень проверки.</span>
        </div>
        <div className="field">
          <label htmlFor="lib-kind">Вид знания</label>
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
      </div>

      {s.isArchivist ? (
        <p className="notice">Вы Архивариус. Роль даёт право проверять и представлять знания, но не открывает закрытые заседания: вы видите только то, что доступно вам по источникам.</p>
      ) : null}
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? (
        shown.length ? (
          <ol className="volumes" aria-live="polite">
            {shown.map((r) => (
              <li key={r.id}>
                <a className="volume" data-level={r.level} href={`#/library/${r.id}`}>
                  <HallMark level={r.level} proof={r.proof} />
                  <span className="volume-title">{r.title}</span>
                  {r.summary ? <span className="volume-summary">{r.summary}</span> : null}
                  <span className="volume-meta">
                    <span>{r.kindTitle}</span>
                    <span>Источники: {r.sources.join(', ')}</span>
                    {r.applications ? <span>Применено повторно: {r.applications}</span> : null}
                    <span>Версия {r.version}</span>
                    {r.status !== 'active' ? <span className="flag">{r.statusTitle}</span> : null}
                    {r.review === 'library_proposed' ? <span className="flag">ждёт проверки Архивариуса</span> : null}
                    {r.review === 'archive_proposed' ? <span className="flag">заключение у Совета</span> : null}
                    {r.stale ? <span className="flag">давно не проверялось</span> : null}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty">
            {query
              ? 'Ничего не нашлось среди доступных вам знаний. Попробуйте другое слово или откройте все залы.'
              : hall === 'chronicle' || hall === 'all'
                ? 'Записей пока нет. Запись в Летописи создаётся со страницы обращения кнопкой «Внести в Летопись».'
                : hall === 'library'
                  ? 'В Библиотеку попадают записи Летописи после проверки Архивариусом.'
                  : 'В Высший Архив знания попадают по заключению Архивариуса и с утверждения ответственного.'}
          </div>
        )
      ) : null}
      {data ? <p className="xs faint">{data.note}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card editor (registration and new versions)
// ---------------------------------------------------------------------------
function CardForm({ card, onChange, archive }: { card: Card; onChange: (c: Card) => void; archive: boolean }) {
  const s = useSession();
  const members = (s.directory?.members ?? []).filter((m) => m.access === 'member');
  const set = (k: keyof Card, v: unknown) => onChange({ ...card, [k]: v });
  const actions = card.actions ?? [];
  return (
    <div className="stack card-form">
      {FIELDS.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={`k-${f.key}`}>{f.label}</label>
          <textarea id={`k-${f.key}`} className="textarea" rows={f.key === 'problem' || f.key === 'decision' ? 3 : 2} value={(card[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />
          {f.hint ? <span className="hint">{f.hint}</span> : null}
        </div>
      ))}
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
      {archive ? (
        <fieldset className="panel stack archive-fields">
          <legend className="label">Заключение для Высшего Архива</legend>
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
      const numbers = ideas.split(/[\s,;№#]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
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

  return (
    <div className="stack-lg library">
      <a className="back" href="#/library">
        Великая библиотека
      </a>
      <PageHead title="Новая запись в Летописи" sub="Запись ссылается на источники и не копирует их. Расшифровки заседаний пересказывайте своими словами. Людей указывайте в полях «Автор инициативы» и «Ответственные», без телефонов, адресов и других личных сведений в тексте." />
      {note ? <p className="notice">{note}</p> : null}
      <form
        className="stack panel"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid-2">
          <div className="field">
            <label htmlFor="k-title">Название</label>
            <input id="k-title" className="input" required minLength={3} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="k-kind">Вид знания</label>
            <select id="k-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="k-sources">Обращения-источники</label>
          <input id="k-sources" className="input" value={ideas} onChange={(e) => setIdeas(e.target.value)} placeholder="номера через запятую, например 12, 15" />
          <span className="hint">
            {meeting ? 'Заседание добавлено источником. ' : ''}Без источника запись не регистрируется. Сослаться можно только на то, что доступно вам.
          </span>
        </div>
        <CardForm card={card} onChange={setCard} archive={false} />
        <div className="field">
          <label htmlFor="k-reason">Комментарий к записи</label>
          <input id="k-reason" className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="например: итог разбора приёмки" />
        </div>
        {err ? (
          <div className="notice error" role="alert">
            {err}
          </div>
        ) : null}
        <div className="row">
          <button className="btn primary" disabled={busy || title.trim().length < 3}>
            {busy ? 'Вносим…' : 'Внести в Летопись'}
          </button>
          <span className="xs faint">В Библиотеку запись попадёт только после проверки Архивариусом.</span>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One piece of knowledge
// ---------------------------------------------------------------------------
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="k-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
const Text = ({ v }: { v?: string }) => (v ? <p className="prose k-text">{v}</p> : <p className="faint small">Не заполнено</p>);

function changedFields(a: Card, b: Card | undefined): string[] {
  if (!b) return [];
  const all = [...FIELDS, ...ARCHIVE_FIELDS, { key: 'actions' as const, label: 'Действия и сроки' }, { key: 'archiveCategory' as const, label: 'Категория' }, { key: 'lastChecked' as const, label: 'Дата проверки' }, { key: 'responsible' as const, label: 'Ответственные' }];
  return all.filter((f) => JSON.stringify(a[f.key] ?? null) !== JSON.stringify(b[f.key] ?? null)).map((f) => f.label);
}

export function KnowledgePage({ id }: { id: string }) {
  const s = useSession();
  const { data: k, error, loading, reload } = useLoad(() => api<View>(`/orgs/${s.org}/knowledge/${id}`), [s.org, id]);
  const [helper, setHelper] = useState<Helper | null>(null);
  const [helperErr, setHelperErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [vault, setVault] = useState<string | null>(null);

  if (error) return <ErrorBox error={error} retry={() => void reload()} />;
  if (loading && !k) return <Loading />;
  if (!k) return null;
  const c = k.card;

  return (
    <div className="stack-lg library" data-level={k.level}>
      <a className="back" href={`#/library?hall=${k.level}`}>
        {k.hall}
      </a>
      <header className="k-head stack" data-level={k.level}>
        <HallMark level={k.level} proof={k.proof} />
        <h1>{k.title}</h1>
        <div className="row small muted">
          <span>{k.kindTitle}</span>
          {k.archiveCategoryTitle ? <span>{k.archiveCategoryTitle}</span> : null}
          <span>Версия {k.version}</span>
          <span>Внёс(ла) {k.creator}, {date(k.createdAt)}</span>
          {k.lastVerifiedAt ? <span>Последняя проверка: {date(k.lastVerifiedAt)}</span> : null}
        </div>
        {k.status !== 'active' ? (
          <p className={`notice ${k.status === 'outdated' ? '' : 'warn'}`}>
            {k.status === 'outdated'
              ? 'Знание отмечено как устаревшее. Карточка и вся история сохранены, чтобы было видно, что и почему решали раньше.'
              : 'Знание требует повторной проверки: что-то изменилось с момента утверждения.'}{' '}
            {[...k.transitions].reverse().find((t) => t.action === 'outdated' || t.action === 'reverify_requested')?.reason ?? ''}
          </p>
        ) : null}
      </header>

      <div className="k-grid">
        <div className="stack-lg">
          {editing ? (
            <Revise k={k} onDone={() => { setEditing(false); void reload(); }} onCancel={() => setEditing(false)} />
          ) : (
            <article className="panel k-card" aria-label="Карточка знания">
              <div className="k-pair">
                <Section title="Исходная проблема"><Text v={c.problem} /></Section>
                <Section title="Рассмотренные варианты"><Text v={c.options} /></Section>
              </div>
              <div className="k-pair args">
                <Section title="Аргументы за"><Text v={c.argumentsFor} /></Section>
                <Section title="Аргументы против"><Text v={c.argumentsAgainst} /></Section>
              </div>
              <Section title="Принятое решение"><Text v={c.decision} /></Section>
              <Section title="Причины выбора"><Text v={c.reasons} /></Section>
              <div className="k-pair">
                <Section title="Автор инициативы"><p>{k.initiator ?? <span className="faint small">Не указан</span>}</p></Section>
                <Section title="Ответственные"><p>{k.responsible.length ? k.responsible.join(', ') : <span className="faint small">Не указаны</span>}</p></Section>
              </div>
              <Section title="Действия и сроки">
                {c.actions?.length ? (
                  <ul className="plain k-actions">
                    {c.actions.map((a, i) => (
                      <li key={i}>
                        {a.what}
                        {a.due ? <span className="faint"> — до {date(a.due)}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="faint small">Не заполнено</p>
                )}
              </Section>
              <Section title="Результаты"><Text v={c.results} /></Section>
              <div className="k-pair">
                <Section title="Положительный опыт"><Text v={c.positive} /></Section>
                <Section title="Отрицательный опыт"><Text v={c.negative} /></Section>
              </div>
              <Section title="Доказательства"><Text v={c.evidence} /></Section>
              {c.proof || c.applicability || c.basis || c.lastChecked ? (
                <div className="k-conclusion">
                  <h3>Заключение для Высшего Архива</h3>
                  <dl>
                    <dt>Доказанность</dt>
                    <dd>{c.proof ?? '—'}</dd>
                    <dt>Область применимости</dt>
                    <dd>{c.applicability ?? '—'}</dd>
                    <dt>Дата последней проверки</dt>
                    <dd>{c.lastChecked ? date(c.lastChecked) : '—'}</dd>
                    <dt>Основания включения</dt>
                    <dd>{c.basis ?? '—'}</dd>
                  </dl>
                </div>
              ) : null}
              {k.can.revise ? (
                <div className="row">
                  <button className="btn" onClick={() => setEditing(true)}>
                    Новая версия карточки
                  </button>
                  <span className="xs faint">Прежние версии и причины изменений сохраняются.</span>
                </div>
              ) : k.level === 'archive' && k.status === 'active' ? (
                <p className="xs faint">Знание Высшего Архива меняется только после запроса повторной проверки.</p>
              ) : null}
            </article>
          )}

          <section className="panel stack" aria-labelledby="apps-h">
            <h2 className="section-title" id="apps-h">Повторные применения</h2>
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
              <p className="small muted">Метод пока не применялся на других обращениях.</p>
            )}
            {k.can.addApplication ? <AddApplication id={k.id} onDone={() => void reload()} /> : null}
          </section>

          <section className="panel stack" aria-labelledby="chron-h">
            <h2 className="section-title" id="chron-h">Летопись событий</h2>
            <p className="xs faint">Собрана из записей источников и истории этого знания. Ничего не дописано от руки.</p>
            <ol className="timeline">
              {k.timeline.map((e, i) => (
                <li key={i} className="event">
                  <span className="xs muted">{dateTime(e.at)}, {e.source}</span>
                  <span>
                    {e.link ? <a href={e.link}>{e.what}</a> : e.what}
                    {e.who ? <span className="muted">, {e.who}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel stack" aria-labelledby="ver-h">
            <h2 className="section-title" id="ver-h">Версии и причины пересмотра</h2>
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

        <aside className="stack-lg">
          <Actions k={k} onDone={(action) => {
            if (action === 'archive_approved') setVault(k.title);
            void reload();
          }} />
          <section className="panel stack" aria-labelledby="src-h">
            <h2 className="section-title" id="src-h">Происхождение</h2>
            <ul className="plain k-list">
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
          </section>
          <section className="panel stack" aria-labelledby="hist-h">
            <h2 className="section-title" id="hist-h">История переходов</h2>
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
          <section className="panel stack" aria-labelledby="help-h">
            <h2 className="section-title" id="help-h">Помощник Архивариуса</h2>
            {helper ? (
              <div className="stack">
                <p className="xs notice warn">{helper.label}</p>
                <p className="xs faint">{helper.ai.note}</p>
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
        </aside>
      </div>
      {vault ? <Vault title={vault} onClose={() => setVault(null)} /> : null}
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
    <section className="panel stack k-actions-panel" aria-labelledby="act-h">
      <h2 className="section-title" id="act-h">Рассмотрение</h2>
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
        <p className="small muted">{waiting ? 'Решение — за другим человеком.' : 'Для вас действий нет.'}</p>
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
      className="panel stack"
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
      <h2 className="section-title">Новая версия карточки</h2>
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
