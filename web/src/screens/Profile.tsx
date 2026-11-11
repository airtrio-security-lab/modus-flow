import { useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';
import { ThemeToggle } from '../lib/env';
import { LiteToggle } from '../lib/lite';
import { useLoad, useSession } from '../lib/session';
import type { Contribution, EmployeeProfile } from '../lib/types';
import { ErrorBox, Loading, PageHead, StatusChip } from '../components/ui';
import { useTitles } from '../components/Titles';
import { NotePrefs } from '../components/NotePrefs';

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
  const titles = useTitles();
  const title = titles.get(s.membershipId);
  const implemented = data?.items.filter((i) => i.xp > 0) ?? [];
  const open = data?.items.filter((i) => !['implemented', 'rejected', 'closed'].includes(i.status)) ?? [];

  return (
    <div className="stack-lg">
      <PageHead title="Мой профиль" sub={[me?.jobTitle, me?.department].filter(Boolean).join(', ') || s.orgName} />
      <section className="panel stack">
        <h2 className="section-title">{s.me.displayName}</h2>
        <dl className="identity">
          <div>
            <dt>Должность</dt>
            <dd>{[me?.jobTitle, me?.department].filter(Boolean).join(', ') || 'не указана в справочнике'}</dd>
          </div>
          <div>
            <dt>Права в системе</dt>
            <dd className="row">
              {s.roles.map((r) => (
                <span key={r} className="level-chip">
                  {ROLE[r] ?? r}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt>Игровое звание</dt>
            <dd>
              {title ? <span className={`title-chip rank-${title.rank}`}>{title.title}</span> : titles.data ? 'нет' : '…'}
              <span className="small muted">
                {' '}
                {title?.source === 'assigned' ? 'назначено администратором' : title?.source === 'castle_head' ? 'как глава подразделения' : title ? 'звание гильдии подразделения' : ''}. Звание прав не даёт.
              </span>
            </dd>
          </div>
          <div>
            <dt>Достижения</dt>
            <dd>
              {implemented.length ? `Внедрено идей: ${implemented.length} — опыт получает замок подразделения` : 'Пока нет внедрённых идей'}.{' '}
              <a href="#/kingdom">Мой замок</a>
            </dd>
          </div>
        </dl>
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

      <Questionnaire />

      <NotePrefs />

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

/**
 * Short questionnaire for MODUS ADVISOR (ADR-0013): skills, preferences and
 * hours a week. Seen by the person and by leads who pick executors, never by
 * colleagues. Nothing here is filled in automatically.
 */
function Questionnaire() {
  const s = useSession();
  const { data, error, reload } = useLoad(() => api<EmployeeProfile>(`/orgs/${s.org}/me/profile`), [s.org]);
  const [skills, setSkills] = useState('');
  const [prefs, setPrefs] = useState('');
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    setSkills(data.skills.join(', '));
    setPrefs(data.preferences ?? '');
    setHours(data.weeklyHours === null ? '' : String(data.weeklyHours));
  }, [data]);
  const list = skills
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const tooShort = list.some((x) => x.length < 2 || x.length > 40);
  const h = hours.trim() === '' ? null : Number(hours);
  const badHours = h !== null && (!Number.isInteger(h) || h < 0 || h > 60);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || tooShort || badHours || list.length > 12) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/me/profile`, { method: 'PUT', json: { skills: list, preferences: prefs.trim() || undefined, weeklyHours: h } });
      await reload();
      s.toast('Анкета сохранена');
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={(e) => void save(e)} noValidate aria-labelledby="q-h">
      <h2 id="q-h" className="section-title">
        Анкета: в чём я могу помочь
      </h2>
      <p className="small muted">
        По анкете помощник Совета предлагает руководителю, кому поручить внедрение. Анкету видите вы и руководители, которые подбирают исполнителей;
        коллеги её не видят.
      </p>
      {error ? <p className="notice error">{errorText(error)}</p> : null}
      <div className="field">
        <label htmlFor="q-skills">Навыки и темы, через запятую</label>
        <input id="q-skills" className="input" value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="Сканеры, принтеры этикеток, 1С склад" />
        <span className="hint">{list.length > 12 ? 'Не больше 12 навыков' : tooShort ? 'Каждый навык — от 2 до 40 символов' : `${list.length} из 12`}</span>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="q-prefs">Что хотелось бы делать</label>
          <textarea id="q-prefs" className="textarea" rows={2} maxLength={500} value={prefs} onChange={(e) => setPrefs(e.target.value)} placeholder="Настройка оборудования, утренние смены" />
        </div>
        <div className="field">
          <label htmlFor="q-hours">Часов в неделю на улучшения</label>
          <input id="q-hours" className="input" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Например, 4" />
          <span className="hint">{badHours ? 'Целое число от 0 до 60' : '0 — сейчас не готов(а) брать задачи'}</span>
        </div>
      </div>
      {err ? <p className="notice error">{err}</p> : null}
      <div>
        <button type="submit" className="btn primary" disabled={busy || tooShort || badHours || list.length > 12}>
          {busy ? 'Сохраняем…' : 'Сохранить анкету'}
        </button>
      </div>
    </form>
  );
}
