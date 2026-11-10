import { useState } from 'react';
import { api, qs } from '../lib/api';
import { ago, hours, plural } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import { CHANNEL } from '../lib/status';
import type { Analytics } from '../lib/types';
import { ErrorBox, Loading, PageHead, StatusChip } from '../components/ui';

/**
 * Owner's view (from the owner's brief): what needs a decision, what is
 * forgotten, where questions come from, what keeps recurring. Every number is
 * a count of recorded facts; nothing is estimated and people are not ranked.
 */
const PERIODS = [
  { id: 'all', label: 'Всё время', days: null },
  { id: '30', label: '30 дней', days: 30 },
  { id: '7', label: '7 дней', days: 7 },
] as const;

export function Overview() {
  const s = useSession();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['id']>('all');
  const p = PERIODS.find((x) => x.id === period)!;
  const from = p.days ? new Date(Date.now() - p.days * 86400e3).toISOString().slice(0, 10) : undefined;
  const { data, error, loading, reload } = useLoad(() => api<Analytics>(`/orgs/${s.org}/analytics${qs({ from })}`), [s.org, from]);

  return (
    <div className="stack-lg">
      <PageHead title="Обзор" sub="Что требует решения, что забыто и откуда приходят вопросы.">
        <div className="segmented" role="group" aria-label="Период">
          {PERIODS.map((x) => (
            <button key={x.id} type="button" aria-pressed={x.id === period} onClick={() => setPeriod(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </PageHead>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading /> : data ? <Dashboard a={data} /> : null}
    </div>
  );
}

function Dashboard({ a }: { a: Analytics }) {
  const t = a.totals as Record<string, number>;
  const attention = a.needsAttention.length;
  const parts = [
    t.unrouted ? `${t.unrouted} без ответственного` : null,
    t.overdueFirstResponse ? `${t.overdueFirstResponse} без ответа в срок` : null,
    t.overdueResolution ? `${t.overdueResolution} с истёкшим сроком решения` : null,
    t.stale ? `${t.stale} без движения` : null,
  ].filter(Boolean);
  const maxChannel = Math.max(1, ...a.byChannel.map((c) => c.count));

  return (
    <>
      <section className={`verdict${attention ? ' warn' : ''}`} aria-live="polite">
        {attention ? (
          <>
            <p className="verdict-n">{attention}</p>
            <p>
              {plural(attention, 'обращение требует', 'обращения требуют', 'обращений требуют')} внимания: {parts.join(', ')}.
            </p>
          </>
        ) : (
          <p>Все обращения распределены и получают ответы в срок.</p>
        )}
      </section>

      <section className="metrics" aria-label="Показатели">
        <Metric value={String(t.total ?? 0)} label="Всего обращений" />
        <Metric value={String(t.open ?? 0)} label="Открыто сейчас" />
        <Metric value={a.metrics.shareResponded === null ? '—' : `${String(a.metrics.shareResponded).replace('.', ',')} %`} label="Получили ответ ответственного" />
        <Metric value={hours(a.metrics.medianFirstResponseHours)} label="Медиана до первого ответа" />
        <Metric value={String(a.metrics.implemented)} label="Реализовано" />
      </section>

      <div className="dash-grid">
        <section className="panel stack">
          <h2 className="section-title">Требует внимания</h2>
          {a.needsAttention.length === 0 ? (
            <p className="muted small">Ничего не просрочено.</p>
          ) : (
            <ul className="plain attention">
              {a.needsAttention.map((i) => (
                <li key={i.number}>
                  <a href={`#/items/${i.number}`}>
                    №{i.number} {i.title}
                  </a>
                  <span className="row xs">
                    <StatusChip status={i.status} />
                    <span className="faint">{i.maintainer ? `ведёт ${i.maintainer}` : 'никто не ведёт'}</span>
                    <span className="faint">{ago(i.publishedAt)}</span>
                    {i.overdueFirstResponse && <span className="flag red">нет ответа</span>}
                    {i.overdueResolution && <span className="flag red">срок решения истёк</span>}
                    {i.stale && <span className="flag">нет движения</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel stack">
          <h2 className="section-title">Повторяющиеся вопросы</h2>
          {a.recurring.length === 0 ? (
            <p className="muted small">Похожих открытых обращений не найдено.</p>
          ) : (
            <ul className="plain attention">
              {a.recurring.map((r) => (
                <li key={r.anchorNumber}>
                  <a href={`#/items/${r.anchorNumber}`}>
                    №{r.anchorNumber} {r.anchorTitle}
                  </a>
                  <span className="xs faint">
                    {r.size} {plural(r.size, 'обращение', 'обращения', 'обращений')} о похожем:{' '}
                    {r.similarNumbers.map((n, i) => (
                      <span key={n}>
                        {i > 0 && ', '}
                        <a href={`#/items/${n}`}>№{n}</a>
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="xs faint">Сходство определяется по названиям открытых обращений.</p>
        </section>

        <section className="panel stack">
          <h2 className="section-title">Откуда приходят вопросы</h2>
          <div className="bars">
            {a.byChannel.map((c) => (
              <div className="bar" key={c.channel}>
                <span>{CHANNEL[c.channel]}</span>
                <span className="track">
                  <span style={{ width: `${(c.count / maxChannel) * 100}%` }} />
                </span>
                <span className="n">{c.count}</span>
              </div>
            ))}
          </div>
          <p className="xs faint">Вопросы с совещаний, из почты и звонков записываются со слов сотрудника — они больше не теряются.</p>
        </section>

        <section className="panel stack">
          <h2 className="section-title">По подразделениям</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Подразделение</th>
                  <th className="n">Всего</th>
                  <th className="n">Открыто</th>
                  <th className="n">Просрочено</th>
                </tr>
              </thead>
              <tbody>
                {a.byDepartment.map((d) => (
                  <tr key={d.department}>
                    <td>{d.department}</td>
                    <td className="n">{d.total}</td>
                    <td className="n">{d.open}</td>
                    <td className={`n${d.overdue ? ' flag red' : ''}`}>{d.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel stack">
        <h2 className="section-title">По темам</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Тема</th>
                <th className="n">Всего</th>
                <th className="n">Открыто</th>
                <th className="n">Реализовано</th>
                <th className="n">Отклонено</th>
                <th className="n">Просрочено</th>
              </tr>
            </thead>
            <tbody>
              {a.byCategory.map((c) => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td className="n">{c.total}</td>
                  <td className="n">{c.open}</td>
                  <td className="n">{c.implemented}</td>
                  <td className="n">{c.rejected}</td>
                  <td className={`n${c.overdue ? ' flag red' : ''}`}>{c.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}
