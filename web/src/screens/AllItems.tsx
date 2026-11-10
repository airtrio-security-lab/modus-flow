import { useEffect, useState } from 'react';
import { api, qs } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import { CHANNEL, STATUS } from '../lib/status';
import type { Channel, ListItem, Status } from '../lib/types';
import { ErrorBox, ItemList, Loading, PageHead } from '../components/ui';

/** Search and filters over every item: history is open, so duplicates are easy to find. */
export function AllItems() {
  const s = useSession();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status | ''>('');
  const [category, setCategory] = useState('');
  const [department, setDepartment] = useState('');
  const [channel, setChannel] = useState<Channel | ''>('');

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim().length >= 2 ? q.trim() : ''), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const { data, error, loading, reload } = useLoad(
    () => api<ListItem[]>(`/orgs/${s.org}/ideas${qs({ q: query, status, category, department, channel, limit: 200 })}`),
    [s.org, query, status, category, department, channel],
  );
  const filtered = !!(query || status || category || department || channel);

  return (
    <div className="stack-lg">
      <PageHead title="Все обращения" sub="Поиск по тексту понимает формы слов: «погрузчик» найдёт «погрузчики»." />
      <div className="filters">
        <div className="field grow">
          <label htmlFor="q" className="sr-only">
            Поиск
          </label>
          <input id="q" className="input" type="search" placeholder="Поиск по названию и тексту" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select aria-label="Статус" className="select" value={status} onChange={(e) => setStatus(e.target.value as Status | '')}>
          <option value="">Любой статус</option>
          {(Object.keys(STATUS) as Status[]).map((k) => (
            <option key={k} value={k}>
              {STATUS[k].label}
            </option>
          ))}
        </select>
        <select aria-label="Тема" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Любая тема</option>
          {s.directory?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Подразделение" className="select" value={department} onChange={(e) => setDepartment(e.target.value)}>
          <option value="">Любое подразделение</option>
          {s.directory?.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select aria-label="Источник" className="select" value={channel} onChange={(e) => setChannel(e.target.value as Channel | '')}>
          <option value="">Любой источник</option>
          {(Object.keys(CHANNEL) as Channel[]).map((c) => (
            <option key={c} value={c}>
              {CHANNEL[c]}
            </option>
          ))}
        </select>
      </div>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? (
        <Loading />
      ) : (
        <>
          {data && <p className="small muted">{filtered ? `Найдено: ${data.length}` : `Всего: ${data.length}`}</p>}
          <ItemList items={data ?? []} empty={filtered ? 'Ничего не найдено. Измените запрос или фильтры.' : 'Обращений пока нет.'} />
        </>
      )}
    </div>
  );
}
