import { api, qs } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import type { ListItem } from '../lib/types';
import { ErrorBox, ItemList, Loading, PageHead } from '../components/ui';

/**
 * The head's workplace: what is mine to answer, what nobody owns yet, what is
 * overdue or has stalled. Counts come from the same queries as the lists.
 */
const TABS = [
  { id: 'mine', label: 'Мне на рассмотрение', query: { assigned: true, open: true }, empty: 'Сейчас на вас ничего не назначено.' },
  { id: 'unrouted', label: 'Без ответственного', query: { status: 'unrouted' }, empty: 'Все обращения распределены.' },
  { id: 'overdue', label: 'Просрочено', query: { overdue: true, open: true }, empty: 'Просроченных обращений нет.' },
  { id: 'stale', label: 'Нет движения', query: { stale: true, open: true }, empty: 'Зависших обращений нет.' },
] as const;

export function Workspace({ tab }: { tab?: string }) {
  const s = useSession();
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const { data, error, loading, reload } = useLoad(
    () => Promise.all(TABS.map((t) => api<ListItem[]>(`/orgs/${s.org}/ideas${qs({ ...t.query, limit: 200 })}`))),
    [s.org],
  );
  const lists = data ?? [];
  const items = lists[TABS.indexOf(active)] ?? [];
  const waitingForMe = (lists[0] ?? []).filter((i) => !i.firstResponseAt).length;

  return (
    <div className="stack-lg">
      <PageHead
        title="Рабочее место"
        sub={
          data
            ? waitingForMe
              ? `Ждут вашего первого ответа: ${waitingForMe}. Ответ, вопрос автору или отчёт о ходе работ останавливают счётчик срока.`
              : 'Первого ответа от вас никто не ждёт.'
            : undefined
        }
      >
        <a className="btn" href="#/kingdom">
          Город Содружества
        </a>
      </PageHead>
      <nav className="tabs" aria-label="Очереди">
        {TABS.map((t, i) => (
          <a key={t.id} href={`#/work/${t.id}`} aria-current={t === active ? 'page' : undefined}>
            {t.label}
            {data && <span className={`count${(t.id === 'overdue' || t.id === 'unrouted') && (lists[i]?.length ?? 0) > 0 ? ' alert' : ''}`}>{lists[i]?.length ?? 0}</span>}
          </a>
        ))}
      </nav>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading /> : <ItemList items={items} empty={active.empty} />}
    </div>
  );
}
