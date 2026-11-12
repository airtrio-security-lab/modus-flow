import { api } from '../lib/api';
import { useLoad, useSession } from '../lib/session';

/**
 * A row of an imported data set on the item card (0017, ADR-0022): the organizer's own id, type,
 * category, priority and conditional status are shown as they were given — next to, not instead of,
 * the product's real status. A demo confirmation is always labelled.
 */
export interface DatasetRow {
  dataset: string;
  externalId: string;
  originalType: string;
  originalCategory: string;
  originalPriority: string;
  originalStatus: string;
  originalAuthor: string;
  originalOwner: string;
  routedBy: 'category_rule' | 'fallback';
  demoConfirmedAt: string | null;
}
export function DatasetNote({ number }: { number: number }) {
  const s = useSession();
  const { data } = useLoad(() => api<DatasetRow | null>(`/orgs/${s.org}/ideas/${number}/dataset`).catch(() => null), [s.org, number]);
  if (!data) return null;
  return (
    <section className="panel stack dataset-note" aria-label="Строка официального набора данных">
      <p className="small">
        <b>{data.externalId}</b> · строка <a href={`#/dataset/${data.dataset}`}>официального синтетического набора организатора</a>. Данные условные, людей за ними нет.
      </p>
      <dl className="dataset-facts">
        <div>
          <dt>Тип по набору</dt>
          <dd>{data.originalType}</dd>
        </div>
        <div>
          <dt>Категория</dt>
          <dd>{data.originalCategory}</dd>
        </div>
        <div>
          <dt>Приоритет</dt>
          <dd>{data.originalPriority}</dd>
        </div>
        <div>
          <dt>Условный статус набора</dt>
          <dd>{data.originalStatus}</dd>
        </div>
        <div>
          <dt>Автор по набору</dt>
          <dd>{data.originalAuthor}</dd>
        </div>
        <div>
          <dt>Ответственный по набору</dt>
          <dd>
            {data.originalOwner} · {data.routedBy === 'category_rule' ? 'назначен по правилу категории' : 'запасной маршрут: правила для категории нет'}
          </dd>
        </div>
      </dl>
      {data.demoConfirmedAt ? (
        <p className="small notice warn">Демо-подтверждение: внедрение отмечено только для показа роста замка. Фактического внедрения не было.</p>
      ) : data.originalStatus === 'Реализовано' ? (
        <p className="small muted">В наборе строка отмечена «Реализовано». Опыт замку не начислен: внедрение в системе не подтверждено.</p>
      ) : null}
    </section>
  );
}
