import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './lib/api';
import { useRoute } from './lib/router';
import { SessionProvider, useSession } from './lib/session';
import type { Me } from './lib/types';
import { ErrorBox, Loading } from './components/ui';
import { Icon, type IconName } from './components/icons';
import { ThemeToggle, useOnline } from './lib/env';
import { Login } from './screens/Login';
import { Mine } from './screens/Mine';
import { NewItem } from './screens/NewItem';
import { ItemPage } from './screens/Item';
import { Workspace } from './screens/Workspace';
import { AllItems } from './screens/AllItems';
import { Overview } from './screens/Overview';
import { Inbox } from './screens/Inbox';
import { Settings } from './screens/Settings';
import { Meeting } from './screens/Meeting';
import { Board } from './screens/Board';

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
    { href: '#/board', label: 'Доска', short: 'Доска', match: (p: string[]) => p[0] === 'board' },
    { href: '#/meeting', label: 'Разбор совещания', short: 'Совещание', match: (p) => p[0] === 'meeting' },
    { href: '#/all', label: 'Все обращения', short: 'Все', match: (p) => p[0] === 'all' },
    ...(s.isLead || s.isAdmin ? [{ href: '#/overview', label: 'Обзор', short: 'Обзор', match: (p: string[]) => p[0] === 'overview' }] : []),
    { href: '#/inbox', label: 'Уведомления', short: 'Уведомления', match: (p) => p[0] === 'inbox', count: s.unread },
    ...(s.isAdmin ? [{ href: '#/settings', label: 'Настройки', short: 'Настройки', match: (p: string[]) => p[0] === 'settings' }] : []),
  ];

  let page: ReactNode;
  if (head === '') page = <Mine />;
  else if (head === 'new') page = <NewItem />;
  else if (head === 'meeting') page = <Meeting />;
  else if (head === 'board') page = <Board />;
  else if (head === 'items' && route[1]) page = <ItemPage number={Number(route[1])} key={route[1]} />;
  else if (head === 'work' && s.isLead) page = <Workspace tab={route[1]} />;
  else if (head === 'all') page = <AllItems />;
  else if (head === 'overview' && (s.isLead || s.isAdmin)) page = <Overview />;
  else if (head === 'inbox') page = <Inbox />;
  else if (head === 'settings' && s.isAdmin) page = <Settings />;
  else
    page = (
      <div className="empty">
        {['work', 'overview', 'settings'].includes(head)
          ? head === 'settings'
            ? 'Настройки доступны администраторам системы.'
            : 'Этот раздел доступен руководителям, которые ведут обращения или принимают решения.'
          : 'Такой страницы нет.'}{' '}
        <a href="#/" className="btn">
          К моим обращениям
        </a>
      </div>
    );

  // Screen readers and keyboard users land on the new page, not on the old link.
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  const routeKey = route.join('/');
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [routeKey]);
  const online = useOnline();

  // Mobile tab bar: four or five destinations around the central «+».
  // Leads: Работа, Доска | Уведомления, Обзор. Employees: Мои, Доска | Уведомления.
  const pickTab = (h: string) => nav.find((n) => n.href === h);
  const left = (s.isLead ? ['#/work', '#/board'] : ['#/', '#/board']).map(pickTab).filter((n): n is NavItem => !!n);
  const right = (s.isLead || s.isAdmin ? ['#/inbox', '#/overview'] : ['#/inbox']).map(pickTab).filter((n): n is NavItem => !!n);

  return (
    <div className="shell">
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Перейти к содержимому
      </a>
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
            <a key={n.href} href={n.href} aria-current={n.match(route) ? 'page' : undefined} aria-label={n.count ? `${n.label}: ${n.count} непрочитанных` : undefined}>
              <span>{n.label}</span>
              {!!n.count && <span className="count alert" aria-hidden="true">{n.count}</span>}
            </a>
          ))}
        </nav>
        <div className="who">
          <div>{s.me.displayName}</div>
          <div className="faint xs">{roleLine(s.roles)}</div>
          <div className="row">
            <button className="btn quiet small" onClick={s.signOut}>
              Сменить сотрудника
            </button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <main className="main" id="main" ref={mainRef} tabIndex={-1}>
        {!online && (
          <div className="notice warn offline" role="status">
            Нет связи с сервером. Можно продолжать писать — черновик обращения сохраняется на этом устройстве; отправьте, когда связь вернётся.
          </div>
        )}
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
            <Icon name="plus" />
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

const TAB_ICON: Record<string, IconName> = { '#/': 'inbox-stack', '#/work': 'briefcase', '#/board': 'columns', '#/inbox': 'bell', '#/overview': 'chart' };

function Tab({ n, route }: { n: NavItem; route: string[] }) {
  return (
    <a href={n.href} aria-current={n.match(route) ? 'page' : undefined} aria-label={n.count ? `${n.label}: ${n.count} непрочитанных` : n.label}>
      <Icon name={TAB_ICON[n.href] ?? 'inbox-stack'} />
      {!!n.count && (
        <span className="badge" aria-hidden="true">
          {n.count > 99 ? '99+' : n.count}
        </span>
      )}
      <span aria-hidden="true">{n.short}</span>
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
