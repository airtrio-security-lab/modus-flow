import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { useSession } from '../lib/session';
import { useTitles } from './Titles';

/**
 * Admin: who is King, Regent or a district's deputy (Каро, Султан, Сенешаль, Нойон — by the style of
 * the district). Every other title follows from real functions and the person's own choices.
 * A title grants nothing: rights are roles, set elsewhere.
 */
export function TitlesAdmin() {
  const s = useSession();
  const titles = useTitles();
  const [msg, setMsg] = useState<string | null>(null);
  const members = (s.directory?.members ?? []).filter((m) => m.access === 'member');
  async function set(membershipId: string, rank: string) {
    setMsg(null);
    try {
      if (rank) await api(`/orgs/${s.org}/titles/${membershipId}`, { method: 'PUT', json: { rank } });
      else await api(`/orgs/${s.org}/titles/${membershipId}`, { method: 'DELETE' });
      setMsg('Звание обновлено');
      await titles.reload();
    } catch (e) {
      setMsg(errorText(e));
    }
  }
  return (
    <section className="panel stack" aria-labelledby="titles-admin-h">
      <h2 id="titles-admin-h" className="section-title">
        Игровые звания
      </h2>
      <p className="small muted">
        Звание — слово, а не право. Король, Регент и заместитель района назначаются здесь; остальные звания следуют из функции в подразделении (глава, ведёт или решает
        обращения, подтверждённые результаты) и из выбора самого сотрудника. Права задаются ролями.
      </p>
      <div className="table-wrap">
        <table className="rating">
          <thead>
            <tr>
              <th scope="col">Сотрудник</th>
              <th scope="col">Подразделение</th>
              <th scope="col">Звание сейчас</th>
              <th scope="col">Назначить</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const t = titles.get(m.membershipId);
              const assigned = t?.source === 'assigned' ? t.rank : '';
              return (
                <tr key={m.membershipId}>
                  <th scope="row">{m.name}</th>
                  <td>{m.department ?? '—'}</td>
                  <td>{t?.title ?? '—'}</td>
                  <td>
                    <select className="select compact" aria-label={`Звание: ${m.name}`} value={assigned} onChange={(e) => void set(m.membershipId, e.target.value)}>
                      <option value="">по функции</option>
                      {assigned === 'guild' ? (
                        <option value="guild" disabled>
                          {t?.title} (гильдия)
                        </option>
                      ) : null}
                      <option value="king">Король</option>
                      <option value="regent">Регент</option>
                      <option value="deputy">Заместитель района</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {msg ? <p className="small muted" role="status">{msg}</p> : null}
    </section>
  );
}
