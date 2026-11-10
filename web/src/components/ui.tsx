import type { ReactNode } from 'react';
import { errorText } from '../lib/api';
import { ago, due } from '../lib/format';
import { CHANNEL, PHASES, STATUS } from '../lib/status';
import type { ListItem, Status } from '../lib/types';

/**
 * The signal line: the item's path as a one-line schematic, the same five
 * stops the owner named («рассмотрение — решение — реализация»). The current
 * stop carries the status tone; a rejected item ends red, never "done".
 */
export function Signal({ status, mini = false }: { status: Status; mini?: boolean }) {
  const s = STATUS[status];
  const skipImplementation = status === 'rejected' || status === 'closed';
  const fill = Math.min(s.phase, 4) / 4;
  return (
    <div className={`signal${mini ? ' mini' : ''}`} role="img" aria-label={`Этап: ${PHASES[s.phase]}. ${s.label}`}>
      {!mini && <span className="fill" style={{ width: `${fill * 80}%` }} aria-hidden="true" />}
      {PHASES.map((name, i) => {
        const state = i < s.phase ? (skipImplementation && i === 3 ? 'skip' : 'done') : i === s.phase ? 'current' : 'todo';
        const label = i === 4 && s.phase === 4 ? s.label : name;
        return (
          <div className="node" key={name} data-state={state} data-tone={state === 'current' ? s.tone : undefined} aria-hidden="true">
            <span className="dot" />
            <span className="name">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export function StatusChip({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span className="chip" data-tone={s.tone} title={s.hint}>
      <span className="lamp" aria-hidden="true" />
      {s.label}
    </span>
  );
}

/** Overdue / stale flags — only facts, never guesses. */
export function Flags({ item }: { item: Pick<ListItem, 'overdueFirstResponse' | 'overdueResolution' | 'stale' | 'firstResponseDueAt' | 'resolutionDueAt'> }) {
  const out: ReactNode[] = [];
  if (item.overdueFirstResponse) {
    out.push(
      <span key="f" className="flag red">
        Первый ответ {due(item.firstResponseDueAt)?.text}
      </span>,
    );
  } else if (item.overdueResolution) {
    out.push(
      <span key="r" className="flag red">
        Срок решения {due(item.resolutionDueAt)?.text}
      </span>,
    );
  }
  if (item.stale) out.push(<span key="s" className="flag">Нет движения</span>);
  return out.length ? <span className="row">{out}</span> : null;
}

export function ItemList({ items, empty, showAuthor = true }: { items: ListItem[]; empty: ReactNode; showAuthor?: boolean }) {
  if (!items.length) return <div className="list"><div className="empty">{empty}</div></div>;
  return (
    <div className="list">
      {items.map((i) => (
        <a key={i.number} className="list-row" href={`#/items/${i.number}`}>
          <span className="num">№{i.number}</span>
          <span className="title">{i.title}</span>
          <span className="side">
            <StatusChip status={i.status} />
            <Flags item={i} />
          </span>
          <span className="meta">
            {i.category && <span>{i.category}</span>}
            {showAuthor && <span>{i.raisedBy ? `${i.raisedBy} (записал ${i.author})` : i.author}</span>}
            {i.sourceChannel !== 'app' && <span>{CHANNEL[i.sourceChannel]}</span>}
            <span>{i.maintainer ? `Ведёт: ${i.maintainer}` : 'Ответственный не назначен'}</span>
            <span>{ago(i.updatedAt)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

export function Loading({ label = 'Загружаем…' }: { label?: string }) {
  return (
    <div className="empty" role="status">
      {label}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      {errorText(error)}
      {retry && (
        <button className="btn small" style={{ marginLeft: 12 }} onClick={retry}>
          Повторить
        </button>
      )}
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </header>
  );
}
