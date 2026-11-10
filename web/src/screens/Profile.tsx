import { api } from '../lib/api';
import { ThemeToggle } from '../lib/env';
import { LiteToggle } from '../lib/lite';
import { useLoad, useSession } from '../lib/session';
import type { Contribution } from '../lib/types';
import { ErrorBox, Loading, PageHead, StatusChip } from '../components/ui';

/**
 * «Мой профиль»: who I am here, what I raised and what my implemented ideas
 * brought to their department's castle. Credit, not a score: there is no
 * personal total and no comparison with colleagues.
 */
const ROLE: Record<string, string> = {
  employee: 'Сотрудник',
  maintainer: 'Ведёт обращения',
  decision_owner: 'Принимает решения',
  org_admin: 'Администратор',
};

export function Profile() {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<Contribution>(`/orgs/${s.org}/me/contribution`), [s.org]);
  const me = s.directory?.members.find((m) => m.membershipId === s.membershipId);
  const implemented = data?.items.filter((i) => i.xp > 0) ?? [];
  const open = data?.items.filter((i) => !['implemented', 'rejected', 'closed'].includes(i.status)) ?? [];

  return (
    <div className="stack-lg">
      <PageHead title="Мой профиль" sub={[me?.jobTitle, me?.department].filter(Boolean).join(', ') || s.orgName} />
      <section className="panel stack">
        <h2 className="section-title">{s.me.displayName}</h2>
        <div className="row">
          {s.roles.map((r) => (
            <span key={r} className="level-chip">
              {ROLE[r] ?? r}
            </span>
          ))}
        </div>
        <div className="row">
          <a className="btn primary" href="#/new">
            Подать обращение
          </a>
          <a className="btn" href="#/">
            Мои обращения
          </a>
          <a className="btn" href="#/inbox">
            Уведомления{s.unread ? `: ${s.unread}` : ''}
          </a>
          {s.isLead || s.isAdmin ? (
            <a className="btn" href="#/overview">
              Обзор для руководства
            </a>
          ) : null}
          {s.isAdmin ? (
            <a className="btn" href="#/settings">
              Настройки
            </a>
          ) : null}
        </div>
      </section>

      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading rows={3} /> : null}
      {data ? (
        <div className="dash-grid">
          <section className="panel stack">
            <h2 className="section-title">Мой вклад в замки</h2>
            {implemented.length ? (
              <ul className="realm-envoys">
                {implemented.map((i) => (
                  <li key={i.number}>
                    <a href={`#/items/${i.number}`}>
                      <span className="num">Обращение №{i.number}</span> {i.title}
                    </a>
                    <span className="small muted">
                      Принесло замку «{i.department ?? 'без подразделения'}» +{i.xp} XP{i.credited ? ' (вопрос записан с ваших слов)' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Когда ваша идея будет внедрена и это подтвердят, здесь появится, что она принесла подразделению.</p>
            )}
          </section>
          <section className="panel stack">
            <h2 className="section-title">В работе ({open.length})</h2>
            {open.length ? (
              <ul className="realm-envoys">
                {open.map((i) => (
                  <li key={i.number}>
                    <a href={`#/items/${i.number}`}>
                      <span className="num">Обращение №{i.number}</span> {i.title}
                    </a>
                    <StatusChip status={i.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Открытых обращений нет.</p>
            )}
          </section>
        </div>
      ) : null}

      <section className="panel stack">
        <h2 className="section-title">Настройки на этом устройстве</h2>
        <div className="row">
          <ThemeToggle />
          <LiteToggle />
          <button className="btn quiet" onClick={s.signOut}>
            Выйти
          </button>
        </div>
      </section>
    </div>
  );
}
