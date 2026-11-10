import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './lib/api';
import { useRoute } from './lib/router';
import { SessionProvider, useSession } from './lib/session';
import type { Me } from './lib/types';
import { ErrorBox, Loading } from './components/ui';
import { Login } from './screens/Login';
import { Mine } from './screens/Mine';
import { NewItem } from './screens/NewItem';
import { ItemPage } from './screens/Item';
import { Workspace } from './screens/Workspace';
import { AllItems } from './screens/AllItems';
import { Overview } from './screens/Overview';
import { Inbox } from './screens/Inbox';
import { Settings } from './screens/Settings';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'checking' | 'signed-out' | 'ready' | 'error'>(getToken() ? 'checking' : 'signed-out');
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setState('checking');
    try {
      const m = await api<Me>('/me');
      if (!m.memberships.length) throw new Error('У вашей учётной записи нет доступа ни к одной организации');
      setMe(m);
      setState('ready');
    } catch (e) {
      if (!getToken()) setState('signed-out');
      else {
        setError(e);
        setState('error');
      }
    }
  }, []);

  useEffect(() => {
    if (getToken()) void load();
  }, [load]);

  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
    location.hash = '';
    setState('signed-out');
  }, []);

  if (state === 'signed-out') return <Login onSignedIn={() => void load()} />;
  if (state === 'checking' || (state === 'ready' && !me)) return <Loading label="Открываем MODUS FLOW…" />;
  if (state === 'error' || !me)
    return (
      <main className="login">
        <div className="login-box">
          <ErrorBox error={error} retry={() => void load()} />
          <button className="btn" onClick={signOut}>
            Выйти
          </button>
        </div>
      </main>
    );
  return (
    <SessionProvider me={me} onSignOut={signOut}>
      <Shell />
    </SessionProvider>
  );
}

interface NavItem {
  href: string;
  label: string;
  short: string;
  match: (p: string[]) => boolean;
  count?: number;
}

function Shell() {
  const s = useSession();
  const route = useRoute();
  const head = route[0] ?? '';

  const nav: NavItem[] = [
    { href: '#/', label: 'Мои обращения', short: 'Мои', match: (p) => p.length === 0 },
    ...(s.isLead ? [{ href: '#/work', label: 'Рабочее место', short: 'Работа', match: (p: string[]) => p[0] === 'work' }] : []),
    { href: '#/all', label: 'Все обращения', short: 'Все', match: (p) => p[0] === 'all' },
    ...(s.isLead || s.isAdmin ? [{ href: '#/overview', label: 'Обзор', short: 'Обзор', match: (p: string[]) => p[0] === 'overview' }] : []),
    { href: '#/inbox', label: 'Уведомления', short: 'Уведомления', match: (p) => p[0] === 'inbox', count: s.unread },
    ...(s.isAdmin ? [{ href: '#/settings', label: 'Настройки', short: 'Настройки', match: (p: string[]) => p[0] === 'settings' }] : []),
  ];

  let page: ReactNode;
  if (head === '') page = <Mine />;
  else if (head === 'new') page = <NewItem />;
  else if (head === 'items' && route[1]) page = <ItemPage number={Number(route[1])} key={route[1]} />;
  else if (head === 'work' && s.isLead) page = <Workspace tab={route[1]} />;
  else if (head === 'all') page = <AllItems />;
  else if (head === 'overview' && (s.isLead || s.isAdmin)) page = <Overview />;
  else if (head === 'inbox') page = <Inbox />;
  else if (head === 'settings' && s.isAdmin) page = <Settings />;
  else
    page = (
      <div className="empty">
        Такой страницы нет.{' '}
        <a href="#/" className="btn">
          К моим обращениям
        </a>
      </div>
    );

  // Mobile tab bar: four or five destinations around the central «+».
  const tabs = nav.filter((n) => ['#/', '#/work', '#/all', '#/inbox', '#/overview'].includes(n.href));
  const left = tabs.slice(0, 2);
  const right = tabs.slice(2, s.isLead ? 4 : 3);

  return (
    <div className="shell">
      <aside className="rail" aria-label="Навигация">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <span>
            MODUS FLOW
            <small>{s.orgName}</small>
          </span>
        </div>
        <a href="#/new" className="btn primary" aria-current={head === 'new' ? 'page' : undefined}>
          Подать обращение
        </a>
        <nav className="nav">
          {nav.map((n) => (
            <a key={n.href} href={n.href} aria-current={n.match(route) ? 'page' : undefined}>
              <span>{n.label}</span>
              {!!n.count && <span className="count alert">{n.count}</span>}
            </a>
          ))}
        </nav>
        <div className="who">
          <div>{s.me.displayName}</div>
          <div className="faint xs">{roleLine(s.roles)}</div>
          <button className="btn quiet small" onClick={s.signOut}>
            Сменить сотрудника
          </button>
        </div>
      </aside>

      <main className="main" id="main">
        <div className="mobile-head">
          <div className="brand">
            <img src="/icon.svg" alt="" />
            <span>
              MODUS FLOW
              <small>{s.me.displayName}</small>
            </span>
          </div>
          <div className="row">
            {s.isAdmin && (
              <a className="btn quiet small" href="#/settings">
                Настройки
              </a>
            )}
            <button className="btn quiet small" onClick={s.signOut}>
              Выйти
            </button>
          </div>
        </div>
        <div className="page">{page}</div>
      </main>

      <nav className="tabbar" aria-label="Разделы" style={{ gridTemplateColumns: `repeat(${left.length + right.length + 1}, 1fr)` }}>
        {left.map((n) => (
          <Tab key={n.href} n={n} route={route} />
        ))}
        <a href="#/new" aria-current={head === 'new' ? 'page' : undefined}>
          <span className="plus" aria-hidden="true">
            +
          </span>
          Подать
        </a>
        {right.map((n) => (
          <Tab key={n.href} n={n} route={route} />
        ))}
      </nav>
    </div>
  );
}

function Tab({ n, route }: { n: NavItem; route: string[] }) {
  return (
    <a href={n.href} aria-current={n.match(route) ? 'page' : undefined}>
      <span className={`tab-mark${n.count ? ' alert' : ''}`} aria-hidden="true">
        {n.count ? n.count : ''}
      </span>
      {n.short}
    </a>
  );
}

function roleLine(roles: string[]) {
  const names: Record<string, string> = {
    employee: 'сотрудник',
    maintainer: 'ведёт обращения',
    decision_owner: 'принимает решения',
    org_admin: 'администратор',
  };
  const r = roles.filter((x) => x !== 'employee').map((x) => names[x]);
  return r.length ? r.join(', ') : 'сотрудник';
}
