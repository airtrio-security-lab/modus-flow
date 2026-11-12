import { api } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import { ErrorBox, Loading, PageHead, StatusChip } from '../components/ui';
import type { Status } from '../lib/types';

/** The imported set as a table: the organizer's ids and conditional statuses beside the real state of each item (0017). */
interface Row {
  externalId: string;
  number: number;
  title: string;
  status: Status;
  originalType: string;
  originalCategory: string;
  originalPriority: string;
  originalStatus: string;
  routedBy: 'category_rule' | 'fallback';
  demoConfirmedAt: string | null;
  xp: number;
}
export function DatasetPage({ dataset }: { dataset: string }) {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<Row[]>(`/orgs/${s.org}/datasets/${dataset}`), [s.org, dataset]);
  return (
    <div className="stack-lg">
      <PageHead title="Официальный набор организатора" sub="Синтетические обращения A-001—A-020, загруженные через обычную подачу, маршрутизацию и решения. Идентификаторы, типы, категории, приоритеты и условные статусы показаны как в наборе." />
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading rows={6} /> : null}
      {data && !data.length ? <p className="muted">Набор в эту организацию не загружен. Администратор может загрузить его командой импорта.</p> : null}
      {data?.length ? (
        <div className="table-wrap">
          <table className="table dataset-table">
            <caption className="sr-only">Строки набора и состояние соответствующих обращений</caption>
            <thead>
              <tr>
                <th scope="col">ID набора</th>
                <th scope="col">Обращение</th>
                <th scope="col">Тип</th>
                <th scope="col">Категория</th>
                <th scope="col">Приоритет</th>
                <th scope="col">Условный статус</th>
                <th scope="col">Состояние в системе</th>
                <th scope="col">Маршрут</th>
                <th scope="col">XP</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.externalId}>
                  <th scope="row">{r.externalId}</th>
                  <td>
                    <a href={`#/items/${r.number}`}>№{r.number}</a> {r.title}
                  </td>
                  <td>{r.originalType}</td>
                  <td>{r.originalCategory}</td>
                  <td>{r.originalPriority}</td>
                  <td>{r.originalStatus}</td>
                  <td>
                    <StatusChip status={r.status} />
                  </td>
                  <td>{r.routedBy === 'category_rule' ? 'правило категории' : 'запасной маршрут'}</td>
                  <td>{r.xp ? `${r.xp}${r.demoConfirmedAt ? ' · демо-подтверждение' : ''}` : '0'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="small muted">Опыт замкам за строки набора не начисляется автоматически, даже если в наборе стоит «Реализовано». Демо-подтверждение — отдельный, подписанный шаг.</p>
    </div>
  );
}
