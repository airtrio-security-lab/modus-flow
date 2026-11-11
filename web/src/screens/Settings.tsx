import { KnowledgePrivacy } from '../components/KnowledgePrivacy';
import { TitlesAdmin } from '../components/TitlesAdmin';
import { RetentionSettings } from '../components/Retention';
import { useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import type { Directory, Rule } from '../lib/types';
import { ErrorBox, Loading, PageHead } from '../components/ui';

/**
 * Administration: deadlines, routing rules, topics, departments. Nothing is
 * deleted — entries are switched off, so past items keep their labels.
 */
export function Settings() {
  const s = useSession();
  const rules = useLoad(() => api<Rule[]>(`/orgs/${s.org}/routing-rules`), [s.org]);
  const [error, setError] = useState<string | null>(null);

  async function send(path: string, method: 'POST' | 'PATCH', json: unknown, done: string) {
    setError(null);
    try {
      await api(`/orgs/${s.org}${path}`, { method, json });
      await Promise.all([s.reloadDirectory(), rules.reload()]);
      s.toast(done);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }

  const dir = s.directory;
  if (!dir) return <Loading />;
  const members = dir.members.filter((m) => m.access === 'member');
  const name = (id: string | null) => members.find((m) => m.membershipId === id)?.name ?? '—';

  return (
    <div className="stack-lg">
      <PageHead title="Настройки" sub="Кто отвечает за какие вопросы и в какие сроки. Изменения действуют для новых обращений." />
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}

      <RealmSettings
        current={dir.settings?.realmName ?? s.realmName}
        company={s.orgName}
        onSave={async (realmName) => {
          // The new name appears in the whole interface after the session reloads.
          if (await send('/settings', 'PATCH', { realmName }, 'Название Содружества сохранено')) window.location.reload();
        }}
      />

      <Deadlines settings={dir.settings} members={members} onSave={(v) => send('/settings', 'PATCH', v, 'Сроки сохранены')} />

      <section className="panel stack">
        <h2 className="section-title">Правила распределения</h2>
        <p className="small muted">
          Срабатывает самое точное правило: тема и подразделение, затем только тема или только подразделение. Если правила нет, обращение ведёт руководитель подразделения;
          если нет и его — оно попадает в очередь «Без ответственного».
        </p>
        {rules.error ? <ErrorBox error={rules.error} retry={() => void rules.reload()} /> : null}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Тема</th>
                <th>Подразделение</th>
                <th>Ведёт</th>
                <th>Решает</th>
                <th className="n">Ответ, ч</th>
                <th className="n">Решение, дн</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(rules.data ?? []).map((r) => (
                <tr key={r.id} className={r.active ? '' : 'off'}>
                  <td>{r.category ?? 'Любая'}</td>
                  <td>{r.department ?? 'Любое'}</td>
                  <td>{r.maintainerName}</td>
                  <td>{r.decisionOwnerName ?? (r.maintainerName ? 'он же' : '—')}</td>
                  <td className="n">{r.firstResponseHours ?? 'общий'}</td>
                  <td className="n">{r.resolutionDays ?? 'общий'}</td>
                  <td>
                    <button className="btn quiet small" onClick={() => void send(`/routing-rules/${r.id}/active`, 'POST', { active: !r.active }, r.active ? 'Правило выключено' : 'Правило включено')}>
                      {r.active ? 'Выключить' : 'Включить'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <RuleForm dir={dir} members={members} onSave={(v) => send('/routing-rules', 'POST', v, 'Правило добавлено')} />
      </section>

      <div className="dash-grid">
        <section className="panel stack">
          <h2 className="section-title">Темы обращений</h2>
          <ul className="plain settings-list">
            {dir.categories.map((c) => (
              <li key={c.id} className={c.active ? '' : 'off'}>
                <span>{c.name}</span>
                <button className="btn quiet small" onClick={() => void send(`/categories/${c.id}`, 'PATCH', { active: !c.active }, c.active ? 'Тема скрыта из формы' : 'Тема снова доступна')}>
                  {c.active ? 'Скрыть' : 'Вернуть'}
                </button>
              </li>
            ))}
          </ul>
          <AddByName label="Новая тема" min={2} onAdd={(n) => send('/categories', 'POST', { name: n }, 'Тема добавлена')} />
        </section>

        <section className="panel stack">
          <h2 className="section-title">Подразделения</h2>
          <ul className="plain settings-list">
            {dir.departments.map((d) => (
              <li key={d.id} className={d.active ? '' : 'off'}>
                <span>
                  {d.name}
                  <span className="xs faint"> руководитель: {name(d.headMembershipId)}</span>
                </span>
                <select
                  aria-label={`Руководитель: ${d.name}`}
                  className="select compact"
                  value={d.headMembershipId ?? ''}
                  onChange={(e) => void send(`/departments/${d.id}`, 'PATCH', { head: e.target.value || null }, 'Руководитель назначен')}
                >
                  <option value="">Без руководителя</option>
                  {members
                    .filter((m) => m.roles.includes('maintainer'))
                    .map((m) => (
                      <option key={m.membershipId} value={m.membershipId}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </li>
            ))}
          </ul>
          <AddByName label="Новое подразделение" min={2} onAdd={(n) => send('/departments', 'POST', { name: n }, 'Подразделение добавлено')} />
        </section>
      </div>
      <RetentionSettings />

      <KnowledgePrivacy />
      <TitlesAdmin />

      <section className="panel stack" aria-labelledby="archivists-h">
        <h2 className="section-title" id="archivists-h">Архивариусы</h2>
        <p className="small muted">
          Архивариус проверяет происхождение и доказательства знаний и готовит заключения для Высшего Архива. Роль не открывает закрытые заседания и
          конфиденциальные материалы: знание видит только тот, кому доступны его источники. Назначение и снятие записываются в журнал.
        </p>
        <ul className="plain settings-list">
          {members.map((m) => {
            const on = m.roles.includes('archivist');
            return (
              <li key={m.membershipId}>
                <span>
                  {m.name}
                  {m.jobTitle ? <span className="xs faint">, {m.jobTitle}</span> : null}
                </span>
                <button className={on ? 'btn small' : 'btn quiet small'} aria-pressed={on} onClick={() => void send(`/members/${m.membershipId}/archivist`, 'POST', { grant: !on }, on ? `${m.name}: роль Архивариуса снята` : `${m.name}: назначен(а) Архивариусом`)}>
                  {on ? 'Архивариус — снять' : 'Назначить Архивариусом'}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );

}

function RuleForm({ dir, members, onSave }: { dir: Directory; members: Directory['members']; onSave: (v: unknown) => Promise<boolean> }) {
  const [categoryId, setCategoryId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [maintainer, setMaintainer] = useState('');
  const [decisionOwner, setDecisionOwner] = useState('');
  const [hoursV, setHours] = useState('');
  const [daysV, setDays] = useState('');
  return (
    <form
      className="rule-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!maintainer) return;
        void onSave({
          ...(categoryId ? { categoryId } : {}),
          ...(departmentId ? { departmentId } : {}),
          maintainer,
          ...(decisionOwner ? { decisionOwner } : {}),
          ...(hoursV ? { firstResponseHours: Number(hoursV) } : {}),
          ...(daysV ? { resolutionDays: Number(daysV) } : {}),
        }).then((ok) => ok && (setMaintainer(''), setDecisionOwner('')));
      }}
    >
      <h3 className="small">Добавить правило</h3>
      <div className="grid-3">
        <select aria-label="Тема" className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Любая тема</option>
          {dir.categories.filter((c) => c.active).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select aria-label="Подразделение" className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">Любое подразделение</option>
          {dir.departments.filter((d) => d.active).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select aria-label="Ведёт" className="select" value={maintainer} onChange={(e) => setMaintainer(e.target.value)}>
          <option value="">Кто ведёт</option>
          {members.filter((m) => m.roles.includes('maintainer')).map((m) => (
            <option key={m.membershipId} value={m.membershipId}>
              {m.name}
            </option>
          ))}
        </select>
        <select aria-label="Решает" className="select" value={decisionOwner} onChange={(e) => setDecisionOwner(e.target.value)}>
          <option value="">Решает он же</option>
          {members.filter((m) => m.roles.includes('decision_owner') && m.membershipId !== maintainer).map((m) => (
            <option key={m.membershipId} value={m.membershipId}>
              {m.name}
            </option>
          ))}
        </select>
        <input aria-label="Срок первого ответа, часов" className="input" inputMode="numeric" placeholder="Ответ, часов" value={hoursV} onChange={(e) => setHours(e.target.value.replace(/\D/g, ''))} />
        <input aria-label="Срок решения, дней" className="input" inputMode="numeric" placeholder="Решение, дней" value={daysV} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
      </div>
      <button className="btn" type="submit" disabled={!maintainer}>
        Добавить правило
      </button>
    </form>
  );
}

function Deadlines({
  settings,
  members,
  onSave,
}: {
  settings: { defaultFirstResponseHours: number; defaultResolutionDays: number; staleDays: number; escalationMembershipId: string | null } | null;
  members: { membershipId: string; name: string }[];
  onSave: (v: unknown) => Promise<boolean>;
}) {
  const [h, setH] = useState('');
  const [d, setD] = useState('');
  const [st, setSt] = useState('');
  const [esc, setEsc] = useState('');
  useEffect(() => {
    if (!settings) return;
    setH(String(settings.defaultFirstResponseHours));
    setD(String(settings.defaultResolutionDays));
    setSt(String(settings.staleDays));
    setEsc(settings.escalationMembershipId ?? '');
  }, [settings]);
  if (!settings) return null;
  return (
    <form
      className="panel stack"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ defaultFirstResponseHours: Number(h), defaultResolutionDays: Number(d), staleDays: Number(st), escalationMembershipId: esc || null });
      }}
    >
      <h2 className="section-title">Сроки и эскалация</h2>
      <div className="grid-4">
        <div className="field">
          <label htmlFor="st-h">Первый ответ, часов</label>
          <input id="st-h" className="input" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="st-d">Решение, дней</label>
          <input id="st-d" className="input" inputMode="numeric" value={d} onChange={(e) => setD(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="st-s">«Нет движения» после, дней</label>
          <input id="st-s" className="input" inputMode="numeric" value={st} onChange={(e) => setSt(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="st-e">Кому эскалировать</label>
          <select id="st-e" className="select" value={esc} onChange={(e) => setEsc(e.target.value)}>
            <option value="">Только администраторам</option>
            {members.map((m) => (
              <option key={m.membershipId} value={m.membershipId}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="xs faint">Сроки из правил распределения важнее общих. Эскалация приходит, если нет первого ответа, истёк срок решения или по обращению давно нет движения.</p>
      <div>
        <button className="btn" type="submit">
          Сохранить сроки
        </button>
      </div>
    </form>
  );
}

function AddByName({ label, min, onAdd }: { label: string; min: number; onAdd: (name: string) => Promise<boolean> }) {
  const [v, setV] = useState('');
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim().length >= min) void onAdd(v.trim()).then((ok) => ok && setV(''));
      }}
    >
      <input aria-label={label} className="input grow" placeholder={label} value={v} onChange={(e) => setV(e.target.value)} maxLength={120} />
      <button className="btn" type="submit" disabled={v.trim().length < min}>
        Добавить
      </button>
    </form>
  );
}

/** The organization's game world (ADR-0021): its name is configurable; the real company name is not changed here. */
function RealmSettings({ current, company, onSave }: { current: string; company: string; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const ok = name.trim().length >= 3 && name.trim().length <= 60 && name.trim() !== current;
  return (
    <section className="panel stack" aria-labelledby="realm-h">
      <h2 id="realm-h" className="section-title">
        Игровой мир
      </h2>
      <p className="small muted">
        Организация «{company}» в игре — одно Содружество. Подразделения — его районы, каждое со своей цивилизацией; цивилизации — стили, а не отдельные
        организации. Реальное название компании остаётся в администрировании и документах.
      </p>
      <div className="field">
        <label htmlFor="realm-name">Название Содружества</label>
        <input id="realm-name" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <span className="hint">От 3 до 60 символов. Показывается в игровом интерфейсе: город, советы, послания.</span>
      </div>
      <div>
        <button
          type="button"
          className="btn primary"
          disabled={!ok || busy}
          onClick={() => {
            setBusy(true);
            void onSave(name.trim()).finally(() => setBusy(false));
          }}
        >
          Сохранить название
        </button>
      </div>
    </section>
  );
}
