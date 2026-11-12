import { useEffect } from 'react';
import { api } from '../lib/api';
import { date } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import type { PersonCard, PersonListItem } from '../lib/types';
import { ErrorBox, Loading, StatusChip } from '../components/ui';
import { Section } from './District';
import { EnvoySection } from '../components/EnvoySection';

/**
 * The working card of a person (ADR-0019): job, department, game title, questionnaire, tasks,
 * initiatives, confirmed results. Skills and hours are shown to the person and to leads;
 * preferences only to the person; the load is «Нет данных» because task hours are not recorded.
 */
const NO_DATA = 'Нет данных';

export function PersonPage({ id }: { id: string }) {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<PersonCard>(`/orgs/${s.org}/people/${id}`), [s.org, id]);
  const section = new URLSearchParams(location.hash.split('?')[1] ?? '').get('section');
  useEffect(() => {
    if (data && section) document.getElementById(`person-${section}`)?.scrollIntoView({ block: 'start' });
  }, [data, section]);
  if (error) return <ErrorBox error={error} retry={() => void reload()} />;
  if (loading && !data) return <Loading label="Открываем карточку…" rows={4} />;
  if (!data) return null;
  const p = data;
  const a = p.achievements;
  return (
    <div className="stack-lg person-page">
      {p.department?.id ? (
        <a className="back-link" href={`#/castles/${p.department.id}/staff`}>
          ← {p.department.name}
        </a>
      ) : (
        <a className="back-link" href="#/kingdom">
          ← Город
        </a>
      )}
      <header className="page-head">
        <div>
          <h1>{p.name}</h1>
          <p className="muted">
            {p.jobTitle ?? 'Должность не указана'}
            {p.department ? ` · ${p.department.name}` : ''}
          </p>
          {p.title ? <span className="title-chip">{p.title}</span> : null}
          <p className="muted small">Звание — игровое обращение, прав не даёт.</p>
        </div>
      </header>

      <dl className="realm-facts person-facts">
        <div>
          <dt>Загрузка</dt>
          <dd className="none">{NO_DATA}</dd>
        </div>
        <div>
          <dt>Доступность по анкете</dt>
          <dd className={p.weeklyHours === null ? 'none' : ''}>{p.weeklyHours === null ? NO_DATA : `${p.weeklyHours} ч/нед`}</dd>
        </div>
        <div>
          <dt>Задач в работе</dt>
          <dd>{p.tasks.length}</dd>
        </div>
        <div>
          <dt>Внедрено</dt>
          <dd>{a.implemented + a.ideasImplemented}</dd>
        </div>
      </dl>

      <Section id="person-skills" title="Компетенции">
        {p.questionnaire === 'hidden' ? (
          <p className="muted">Анкета видна самому сотруднику и руководителям.</p>
        ) : p.skills?.length ? (
          <p className="row-tight">
            {p.skills.map((x) => (
              <span key={x} className="skill-chip">
                {x}
              </span>
            ))}
          </p>
        ) : (
          <p className="muted">Анкета не заполнена.</p>
        )}
        <ul className="plain small">
          <li>Внедрил(а) как исполнитель: {a.implemented}</li>
          <li>Предложенные идеи внедрены: {a.ideasImplemented}</li>
          <li>Подтверждённый эффект: {a.effectsConfirmed}</li>
          <li>Подтверждён(а) исполнителем: {a.confirmedAsExecutor}</li>
        </ul>
        {p.self ? (
          <div className="notice">
            <b>Предпочтения (видите только вы):</b> {p.preferences ?? 'не указаны'}.{' '}
            <a href="#/me">Изменить анкету</a>
          </div>
        ) : null}
      </Section>

      <Section id="person-envoy" title={p.self ? 'Мой посол' : 'Посол'}>
        <EnvoySection e={p.envoy} />
      </Section>

      <Section id="person-tasks" title="Задачи">
        <Items list={p.tasks} empty="Сейчас задач нет." />
      </Section>
      <Section id="person-initiatives" title="Инициативы">
        <Items list={p.initiatives} empty="Обращений пока нет." />
      </Section>
      <Section id="person-results" title="Результаты и история достижений">
        {p.results.length ? (
          <ul className="district-list">
            {p.results.map((r) => (
              <li key={`${r.number}-${r.role}`}>
                <a href={`#/items/${r.number}`}>
                  <span className="num">№{r.number}</span> {r.title}
                </a>
                <span className="small muted">
                  {r.role}
                  {r.xp ? ` · замку +${r.xp} XP` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Подтверждённых результатов пока нет.</p>
        )}
      </Section>
    </div>
  );
}

function Items({ list, empty }: { list: PersonListItem[]; empty: string }) {
  if (!list.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="district-list">
      {list.map((i) => (
        <li key={i.number}>
          <a href={`#/items/${i.number}`}>
            <span className="num">№{i.number}</span> {i.title}
          </a>
          <span className="row-tight">
            <StatusChip status={i.status} />
            {i.overdue ? <span className="flag red">срок прошёл</span> : null}
            {i.due ? <span className="small muted">срок {date(i.due)}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
