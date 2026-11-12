import { api, qs } from '../lib/api';
import { useRemembered } from '../lib/remember';
import { useLoad, useSession } from '../lib/session';
import type { Rating } from '../lib/types';
import { ErrorBox, Loading, PageHead } from '../components/ui';

/**
 * Department rating (owner brief 2026-11-11, ADR-0012). Departments, never
 * people. XP comes only from confirmed implementations and approved effect;
 * the normalized column (per 10 people) is shown separately and only when the
 * administrator has entered the department's size.
 */
const PERIODS = [
  { id: '30', label: '30 дней' },
  { id: '90', label: 'Квартал' },
  { id: '365', label: 'Год' },
  { id: 'all', label: 'Всё время' },
] as const;
type PeriodId = (typeof PERIODS)[number]['id'];

export function RatingPage() {
  const s = useSession();
  const [period, setPeriod] = useRemembered<PeriodId>('rating.period', 'all');
  const [sort, setSort] = useRemembered<'xp' | 'per10'>('rating.sort', 'xp');
  const { data, error, loading, reload } = useLoad(() => api<Rating>(`/orgs/${s.org}/rating${qs({ period })}`), [s.org, period]);
  const rows = data
    ? sort === 'xp'
      ? data.rows
      : [...data.rows].sort((a, b) => (b.xpPer10 ?? -1) - (a.xpPer10 ?? -1) || b.xpPeriod - a.xpPeriod)
    : [];
  const all = period === 'all';

  return (
    <div className="stack-lg">
      <PageHead title="Рейтинг подразделений" sub="Опыт замков за подтверждённые внедрения и подтверждённый эффект. Это рейтинг подразделений, не людей.">
        <div className="segmented" role="group" aria-label="Период">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" aria-pressed={p.id === period} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
      </PageHead>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading rows={6} /> : null}
      {data ? (
        <>
          <div className="row">
            <span className="small muted">Порядок:</span>
            <div className="segmented" role="group" aria-label="Порядок">
              <button type="button" aria-pressed={sort === 'xp'} onClick={() => setSort('xp')}>
                По опыту
              </button>
              <button type="button" aria-pressed={sort === 'per10'} onClick={() => setSort('per10')}>
                На 10 сотрудников
              </button>
            </div>
          </div>
          <div className="panel tight rating-wrap">
            <table className="rating">
              <caption className="sr-only">Рейтинг подразделений, период: {PERIODS.find((p) => p.id === period)!.label}</caption>
              <thead>
                <tr>
                  <th scope="col">Место</th>
                  <th scope="col">Подразделение</th>
                  <th scope="col">Уровень</th>
                  <th scope="col" className="num">{all ? 'XP' : 'XP за период'}</th>
                  {all ? null : <th scope="col" className="num">XP всего</th>}
                  <th scope="col" className="num">Внедрено</th>
                  <th scope="col" className="num">Эффект, XP</th>
                  <th scope="col" className="num">XP на 10 сотрудников</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.departmentId}>
                    <td className="num">{sort === 'xp' ? r.rank : '—'}</td>
                    <th scope="row">{r.name}</th>
                    <td>
                      <span className="level-chip">
                        {r.level} · {r.levelName}
                      </span>
                    </td>
                    <td className="num strong">{r.xpPeriod}</td>
                    {all ? null : <td className="num">{r.xpTotal}</td>}
                    <td className="num">{r.implementedPeriod}</td>
                    <td className="num">{r.effectXpPeriod}</td>
                    <td className="num">{r.xpPer10 ?? <span className="muted" title="Численность подразделения не указана">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="rating-cards" aria-label="Рейтинг подразделений">
            {rows.map((r) => (
              <li key={r.departmentId} className="panel">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>
                    {sort === 'xp' ? `${r.rank}. ` : ''}
                    {r.name}
                  </b>
                  <span className="level-chip">
                    {r.level} · {r.levelName}
                  </span>
                </div>
                <p className="small muted">
                  {r.xpPeriod} XP{all ? '' : ` за период (всего ${r.xpTotal})`}, внедрено {r.implementedPeriod}, эффект {r.effectXpPeriod} XP
                  {r.xpPer10 !== null ? `, ${r.xpPer10} XP на 10 сотрудников` : ''}
                </p>
              </li>
            ))}
          </ul>
          <p className="small muted">
            Опыт: +{100} XP за подтверждённое внедрение, до +50 XP за эффект, подтверждённый ответственным за решение. За подачу, рассмотрение
            и отклонение опыт не начисляется. Нормированный показатель зависит от численности подразделения, которую указывает администратор;
            где она не указана — прочерк.
          </p>
        </>
      ) : null}
    </div>
  );
}
