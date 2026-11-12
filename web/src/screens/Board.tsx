import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, qs } from '../lib/api';
import { facts, type Facts } from '../lib/can';
import { ago, plural } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import type { IdeaDetail, ListItem, Status } from '../lib/types';
import { ErrorBox, Flags, Loading, PageHead, StatusChip } from '../components/ui';
import { useRemembered } from '../lib/remember';

/**
 * Kanban board over the same five stages the author sees. Moving a card is not
 * a raw status change: it opens the workflow step that move means (take over,
 * decide with a reason, confirm implementation), so every move keeps its
 * explanation in the history. Moves the rules do not allow are explained.
 */
type ColId = 'new' | 'review' | 'decision' | 'progress' | 'done';
const COLUMNS: { id: ColId; title: string; short: string; statuses: Status[]; hint: string }[] = [
  { id: 'new', title: 'Новые', short: 'Новые', statuses: ['unrouted'], hint: 'Ждут ответственного' },
  { id: 'review', title: 'Рассмотрение', short: 'Рассмотр.', statuses: ['in_review', 'needs_info', 'in_verification'], hint: 'Изучают, уточняют, проверяют' },
  { id: 'decision', title: 'Решение', short: 'Решение', statuses: ['decision'], hint: 'После проверки ждут вывода' },
  { id: 'progress', title: 'Реализация', short: 'Реализ.', statuses: ['in_progress'], hint: 'Решено, внедряется' },
  { id: 'done', title: 'Итог', short: 'Итог', statuses: ['implemented', 'rejected', 'closed'], hint: 'Реализовано, отклонено, закрыто' },
];
const columnOf = (s: Status): ColId => COLUMNS.find((c) => c.statuses.includes(s))!.id;
const ORDER: ColId[] = ['new', 'review', 'decision', 'progress', 'done'];

type Move =
  | { kind: 'take' }
  | { kind: 'merge' }
  | { kind: 'reject' }
  | { kind: 'complete' }
  | { kind: 'blocked'; why: string };

/** What dropping a card on a column means, given the viewer's rights on that item. */
function moveFor(from: ColId, to: ColId, f: Facts, item: IdeaDetail): Move {
  if (from === to) return { kind: 'blocked', why: 'Карточка уже в этой колонке.' };
  if (ORDER.indexOf(to) < ORDER.indexOf(from)) {
    return { kind: 'blocked', why: 'Назад по этапам обращения не возвращаются: принятые решения остаются в истории. Если решение нужно пересмотреть, откройте обращение и напишите комментарий.' };
  }
  if (f.originator) return { kind: 'blocked', why: 'Это ваше обращение (вы его подали или подняли вопрос) — вести и решать его будет другой руководитель.' };
  if (from === 'new') {
    if (to === 'review') return f.takeOver || f.assign ? { kind: 'take' } : { kind: 'blocked', why: 'Брать обращения в работу могут руководители, которые ведут обращения.' };
    return { kind: 'blocked', why: 'Сначала обращение берут в работу — перетащите его в «Рассмотрение».' };
  }
  if (to === 'decision') {
    return { kind: 'blocked', why: 'В «Решение» обращение переходит само после проверки на практике. Решить его можно сразу: перетащите в «Реализация» (внедрить) или в «Итог» (отклонить).' };
  }
  if ((from === 'review' || from === 'decision') && (to === 'progress' || to === 'done')) {
    if (!f.decide) {
      const who = item.decisionOwner?.name;
      if (item.status === 'needs_info') return { kind: 'blocked', why: 'Сначала нужен ответ автора на заданный вопрос.' };
      if (item.status === 'in_verification') return { kind: 'blocked', why: 'Идёт проверка на практике — решение принимают после её итога.' };
      return { kind: 'blocked', why: who ? `Решение по этому обращению принимает ${who}.` : 'Сначала назначьте, кто принимает решение.' };
    }
    return to === 'progress' ? { kind: 'merge' } : { kind: 'reject' };
  }
  if (from === 'progress' && to === 'done') {
    return f.complete ? { kind: 'complete' } : { kind: 'blocked', why: 'Отметить «реализовано» могут исполнитель или ответственные, если они не поднимали этот вопрос.' };
  }
  return { kind: 'blocked', why: 'Такой переход не предусмотрен.' };
}

export function Board() {
  const s = useSession();
  const [scope, setScope] = useRemembered<'mine' | 'all'>('board.scope', s.isLead ? 'mine' : 'all');
  const [category, setCategory] = useRemembered('board.category', '');
  const [activeCol, setActiveCol] = useRemembered<ColId>('board.column', 'review');
  const [showOldDone, setShowOldDone] = useState(false);
  const query = scope === 'mine' ? (s.isLead ? { assigned: true } : { mine: true }) : {};
  const { data, error, loading, reload } = useLoad(
    () => api<ListItem[]>(`/orgs/${s.org}/ideas${qs({ ...query, category, limit: 200 })}`),
    [s.org, scope, category],
  );
  const [dragging, setDragging] = useState<ListItem | null>(null);
  const [over, setOver] = useState<ColId | null>(null);
  const [pending, setPending] = useState<{ item: ListItem; to: ColId } | null>(null);

  const columns = useMemo(() => {
    const items = data ?? [];
    const cutoff = Date.now() - 14 * 86400e3;
    return COLUMNS.map((c) => {
      let list = items.filter((i) => c.statuses.includes(i.status));
      const hidden = c.id === 'done' && !showOldDone ? list.filter((i) => Date.parse(i.updatedAt) < cutoff).length : 0;
      if (c.id === 'done' && !showOldDone) list = list.filter((i) => Date.parse(i.updatedAt) >= cutoff);
      // Overdue first, then the oldest: what is waiting longest is on top.
      list.sort((a, b) => Number(b.overdueFirstResponse || b.overdueResolution) - Number(a.overdueFirstResponse || a.overdueResolution) || a.publishedAt.localeCompare(b.publishedAt));
      return { ...c, list, hidden, overdue: list.filter((i) => i.overdueFirstResponse || i.overdueResolution).length };
    });
  }, [data, showOldDone]);

  return (
    <div className="stack-lg board-page">
      <PageHead title="Доска" sub="Перетащите карточку в следующую колонку — откроется нужный шаг: взять в работу, принять решение с причиной или отметить реализацию. Всё сохраняется в истории.">
        <div className="segmented" role="group" aria-label="Чьи обращения">
          <button type="button" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>
            {s.isLead ? 'Мне' : 'Мои'}
          </button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            Все
          </button>
        </div>
        <select aria-label="Тема" className="select compact-lg" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Все темы</option>
          {s.directory?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </PageHead>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? (
        <Loading />
      ) : (
        <>
        <nav className="segmented board-switch" aria-label="Колонка">
          {columns.map((c) => (
            <button key={c.id} type="button" aria-pressed={c.id === activeCol} aria-label={`${c.title}: ${c.list.length}`} onClick={() => setActiveCol(c.id)}>
              {c.short}
              <br />
              {c.list.length}
            </button>
          ))}
        </nav>
        <div className="board" role="list">
          {columns.map((c) => (
            <section
              key={c.id}
              role="listitem"
              aria-label={`${c.title}: ${c.list.length}`}
              className={`column${over === c.id ? ' over' : ''}`}
              data-active={c.id === activeCol || undefined}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(c.id);
              }}
              onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (dragging && columnOf(dragging.status) !== c.id) setPending({ item: dragging, to: c.id });
                setDragging(null);
              }}
            >
              <header className="column-head">
                <h2>{c.title}</h2>
                <span className="count">{c.list.length}</span>
                {c.overdue > 0 && <span className="flag red">{c.overdue} просрочено</span>}
                <p className="xs faint">{c.hint}</p>
              </header>
              <div className="cards">
                {c.list.map((i) => (
                  <article
                    key={i.number}
                    className="card"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', String(i.number));
                      e.dataTransfer.effectAllowed = 'move';
                      setDragging(i);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    data-dragging={dragging?.number === i.number || undefined}
                  >
                    <a href={`#/items/${i.number}`} className="card-title">
                      <span className="faint">№{i.number}</span> {i.title}
                    </a>
                    <div className="row">
                      {c.statuses.length > 1 && <StatusChip status={i.status} />}
                      <Flags item={i} />
                    </div>
                    <div className="card-meta xs faint">
                      <span>{i.maintainer ?? 'никто не ведёт'}</span>
                      <span>{ago(i.publishedAt)}</span>
                    </div>
                    {c.id !== 'done' && (
                      <button className="btn quiet small card-move" onClick={() => setPending({ item: i, to: ORDER[ORDER.indexOf(c.id) + 1]! })}>
                        Перевести
                      </button>
                    )}
                  </article>
                ))}
                {c.list.length === 0 && <p className="xs faint empty-col">Пусто</p>}
                {c.hidden > 0 && (
                  <button className="btn quiet small" onClick={() => setShowOldDone(true)}>
                    Ещё {c.hidden} {plural(c.hidden, 'завершённое', 'завершённых', 'завершённых')} раньше 14 дней
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>
        </>
      )}
      {data && data.length >= 200 && <p className="xs faint">Показаны первые 200 обращений — уточните тему или выберите «Мне».</p>}
      {pending && (
        <MoveDialog
          item={pending.item}
          initialTo={pending.to}
          onClose={() => setPending(null)}
          onDone={async (msg) => {
            setPending(null);
            s.toast(msg);
            await reload();
            void s.refreshInbox();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function MoveDialog({ item, initialTo, onClose, onDone }: { item: ListItem; initialTo: ColId; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const s = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const from = columnOf(item.status);
  const [to, setTo] = useState<ColId>(initialTo);
  const [detail, setDetail] = useState<IdeaDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<'reject' | 'close'>('reject');
  const [person, setPerson] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    api<IdeaDetail>(`/orgs/${s.org}/ideas/${item.number}`).then(setDetail, setLoadError);
  }, [s.org, item.number]);

  const f = detail ? facts({ membershipId: s.membershipId, roles: s.roles }, detail) : null;
  const move = detail && f ? moveFor(from, to, f, detail) : null;
  const targets = ORDER.filter((c) => ORDER.indexOf(c) > ORDER.indexOf(from));

  useEffect(() => {
    if (move?.kind === 'take' && !person) setPerson(s.membershipId);
  }, [move?.kind, person, s.membershipId]);

  async function submit() {
    if (!move || busy) return;
    setBusy(true);
    setError(null);
    const base = `/orgs/${s.org}/ideas/${item.number}`;
    try {
      if (move.kind === 'take') {
        const me = person === s.membershipId && s.roles.includes('decision_owner');
        await api(`${base}/assignments`, { json: { maintainer: person, ...(me ? { decisionOwner: person } : {}) } });
        await onDone(person === s.membershipId ? `№${item.number}: вы ведёте обращение` : `№${item.number}: ответственный назначен`);
      } else if (move.kind === 'merge') {
        await api(`${base}/decision`, { json: { outcome: 'merge', rationale: text.trim(), ...(person ? { implementer: person } : {}) } });
        await onDone(`№${item.number}: решено внедрить`);
      } else if (move.kind === 'reject') {
        await api(`${base}/decision`, { json: { outcome, rationale: text.trim() } });
        await onDone(`№${item.number}: ${outcome === 'reject' ? 'отклонено' : 'закрыто'}, автор получил объяснение`);
      } else if (move.kind === 'complete') {
        await api(`${base}/implementation`, { json: { report: text.trim() } });
        await onDone(`№${item.number}: реализовано`);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  /** Typed explanations are not thrown away silently (sheet-dismiss-confirm). */
  const confirmDiscard = () => !text.trim() || window.confirm('Закрыть? Введённый текст не сохранится.');
  const needsText = move && (move.kind === 'merge' || move.kind === 'reject' || move.kind === 'complete');
  const ok = move && move.kind !== 'blocked' && (!needsText || text.trim().length >= 10) && (move.kind !== 'take' || !!person);
  const members = (s.directory?.members ?? []).filter((m) => m.access === 'member');
  const exclude = detail ? [detail.author.membershipId, detail.raisedByMembershipId] : [];

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        if (!confirmDiscard()) e.preventDefault();
      }}
      aria-labelledby="move-title"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void submit();
        }}
      >
        <div className="stack">
          <h2 id="move-title" className="small">
            №{item.number} {item.title}
          </h2>
          <div className="segmented wrap" role="group" aria-label="Куда перевести">
            {targets.map((c) => (
              <button key={c} type="button" aria-pressed={c === to} onClick={() => setTo(c)}>
                {COLUMNS.find((x) => x.id === c)!.title}
              </button>
            ))}
          </div>
        </div>

        {loadError ? <ErrorBox error={loadError} /> : !move ? <Loading /> : null}

        {move?.kind === 'blocked' && <div className="notice warn">{move.why}</div>}

        {move?.kind === 'take' && (
          <div className="field">
            <label htmlFor="mv-person">Кто ведёт</label>
            <select id="mv-person" className="select" value={person} onChange={(e) => setPerson(e.target.value)}>
              {members
                .filter((m) => m.roles.includes('maintainer') && !exclude.includes(m.membershipId))
                .map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.membershipId === s.membershipId ? `Я (${m.name})` : m.name}
                  </option>
                ))}
            </select>
            <span className="hint">Срок ответа уже идёт с момента регистрации. Автор получит уведомление.</span>
          </div>
        )}

        {move?.kind === 'reject' && (
          <div className="segmented" role="group" aria-label="Итог">
            <button type="button" aria-pressed={outcome === 'reject'} onClick={() => setOutcome('reject')}>
              Отклонить
            </button>
            <button type="button" aria-pressed={outcome === 'close'} onClick={() => setOutcome('close')}>
              Закрыть (дубликат, неактуально)
            </button>
          </div>
        )}

        {needsText && (
          <div className="field">
            <label htmlFor="mv-text">
              {move.kind === 'merge' ? 'Почему внедряем' : move.kind === 'complete' ? 'Что внедрено' : 'Причина — автор увидит её'}
            </label>
            <textarea id="mv-text" className="textarea" autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
            <span className="hint">Не меньше 10 символов. Объяснение остаётся в истории обращения.</span>
          </div>
        )}

        {move?.kind === 'merge' && (
          <div className="field">
            <label htmlFor="mv-impl">Кто внедряет</label>
            <select id="mv-impl" className="select" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Назначу позже</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <a className="btn quiet" href={`#/items/${item.number}`} onClick={() => ref.current?.close()}>
            Открыть обращение
          </a>
          <button type="button" className="btn" onClick={() => confirmDiscard() && ref.current?.close()}>
            {move?.kind === 'blocked' ? 'Понятно' : 'Отмена'}
          </button>
          {move && move.kind !== 'blocked' && (
            <button type="submit" className="btn primary" disabled={!ok || busy}>
              {busy ? 'Сохраняем…' : move.kind === 'take' ? 'Взять в работу' : move.kind === 'merge' ? 'Внедрить' : move.kind === 'complete' ? 'Реализовано' : outcome === 'reject' ? 'Отклонить' : 'Закрыть'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
