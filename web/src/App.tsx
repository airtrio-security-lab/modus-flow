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
import { Kingdom } from './screens/Kingdom';
import { DatasetPage } from './screens/Dataset';
import { DistrictPage } from './screens/District';
import { PersonPage } from './screens/Person';
import { RatingPage } from './screens/Rating';
import { CouncilList, RoundTable } from './screens/Council';
import { Profile } from './screens/Profile';
import { Inbox } from './screens/Inbox';
import { Settings } from './screens/Settings';
import { Meeting } from './screens/Meeting';
import { ProtocolPage } from './screens/Protocol';
import { MeetingPage, MeetingsList, NewMeeting } from './screens/Meetings';
import { TitleChip, useTitles } from './components/Titles';
import { Board } from './screens/Board';
import { KnowledgePage, Library, NewKnowledge } from './screens/Library';

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
  const myTitle = useTitles().get(s.membershipId);

  // Three views over the same data (owner brief 2026-11-11): the game (Королевство, Совет, Рейтинг)
  // and the work (Обращения, Доска). Secondary pages stay one click away.
  const ITEMS = ['', 'all', 'work', 'meeting', 'items'];
  const nav: NavItem[] = [
    { href: '#/kingdom', label: s.realmName, short: 'Город', match: (p: string[]) => p[0] === 'kingdom' || p[0] === 'castles' || p[0] === 'people' },
    { href: '#/council', label: 'Совет', short: 'Совет', match: (p: string[]) => p[0] === 'council' || p[0] === 'meetings' },
    { href: '#/', label: 'Обращения', short: 'Обращения', match: (p) => ITEMS.includes(p[0] ?? '') },
    { href: '#/board', label: 'Доска', short: 'Доска', match: (p: string[]) => p[0] === 'board' },
    { href: '#/library', label: 'Великая библиотека', short: 'Библиотека', match: (p: string[]) => p[0] === 'library' },
    { href: '#/rating', label: 'Рейтинг', short: 'Рейтинг', match: (p: string[]) => p[0] === 'rating' },
    { href: '#/me', label: 'Мой профиль', short: 'Профиль', match: (p: string[]) => p[0] === 'me' },
  ];
  const more: NavItem[] = [
    { href: '#/inbox', label: 'Уведомления', short: 'Уведомления', match: (p) => p[0] === 'inbox', count: s.unread },
    ...(s.isLead || s.isAdmin ? [{ href: '#/overview', label: 'Обзор для руководства', short: 'Обзор', match: (p: string[]) => p[0] === 'overview' }] : []),
    ...(s.isAdmin ? [{ href: '#/settings', label: 'Настройки', short: 'Настройки', match: (p: string[]) => p[0] === 'settings' }] : []),
  ];
  const itemTabs: { href: string; label: string; on: boolean }[] = [
    { href: '#/', label: 'Мои', on: head === '' },
    { href: '#/all', label: 'Все обращения', on: head === 'all' },
    ...(s.isLead ? [{ href: '#/work', label: 'Мне на рассмотрение', on: head === 'work' }] : []),
    { href: '#/board', label: 'Доска', on: head === 'board' },
    { href: '#/meeting', label: 'Разбор совещания', on: head === 'meeting' },
  ];
  const gameTabs = [
    { href: '#/kingdom', label: 'Карта', on: head === 'kingdom' },
    { href: '#/rating', label: 'Рейтинг', on: head === 'rating' },
  ];
  const subnav = ['', 'all', 'work', 'board', 'meeting'].includes(head) ? itemTabs : ['kingdom', 'rating'].includes(head) ? gameTabs : null;

  let page: ReactNode;
  if (head === '') page = <Mine />;
  else if (head === 'new') page = <NewItem />;
  else if (head === 'meeting' && route[1] === 'protocol') page = <ProtocolPage id={route[2]} key={route[2] ?? 'new'} />;
  else if (head === 'meeting') page = <Meeting />;
  else if (head === 'board') page = <Board />;
  else if (head === 'items' && route[1]) page = <ItemPage number={Number(route[1])} key={route[1]} />;
  else if (head === 'work' && s.isLead) page = <Workspace tab={route[1]} />;
  else if (head === 'all') page = <AllItems />;
  else if (head === 'kingdom') page = <Kingdom />;
  else if (head === 'castles' && route[1]) page = <DistrictPage id={route[1]} tab={route[2]} key={route[1]} />;
  else if (head === 'people' && route[1]) page = <PersonPage id={route[1]} key={location.hash} />;
  else if (head === 'rating') page = <RatingPage />;
  else if (head === 'dataset') page = <DatasetPage dataset={/^[a-z0-9-]{2,60}$/.test(route[1] ?? '') ? route[1]! : 'official-synthetic'} />;
  else if (head === 'council' && route[1]) page = <RoundTable number={Number(route[1])} key={route[1]} />;
  else if (head === 'council') page = <CouncilList />;
  else if (head === 'meetings' && route[1] === 'new') page = <NewMeeting key={location.hash} />;
  else if (head === 'meetings' && route[1]) page = <MeetingPage id={route[1]} key={route[1]} />;
  else if (head === 'meetings') page = <MeetingsList />;
  else if (head === 'library' && route[1] === 'new') page = <NewKnowledge key={location.hash} />;
  else if (head === 'library' && route[1]) page = <KnowledgePage id={route[1]} key={route[1]} />;
  else if (head === 'library') page = <Library key={location.hash.split('?')[0]} />;
  else if (head === 'me') page = <Profile />;
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

  // Mobile tab bar: Королевство, Обращения | «+» | Совет, Профиль. Notifications: the bell in the header.
  const pickTab = (h: string) => nav.find((n) => n.href === h);
  const left = ['#/kingdom', '#/'].map(pickTab).filter((n): n is NavItem => !!n);
  const right = ['#/council', '#/me'].map(pickTab).filter((n): n is NavItem => !!n);

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
        <nav className="nav" aria-label="Основные разделы">
          {nav.map((n) => (
            <a key={n.href} href={n.href} aria-current={n.match(route) ? 'page' : undefined}>
              <Icon name={TAB_ICON[n.href] ?? 'inbox-stack'} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
        <nav className="nav nav-more" aria-label="Ещё">
          {more.map((n) => (
            <a key={n.href} href={n.href} aria-current={n.match(route) ? 'page' : undefined} aria-label={n.count ? `${n.label}: ${n.count} непрочитанных` : undefined}>
              <span>{n.label}</span>
              {!!n.count && <span className="count alert" aria-hidden="true">{n.count}</span>}
            </a>
          ))}
        </nav>
        <div className="who">
          <div>{s.me.displayName}</div>
          <TitleChip title={myTitle} />
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
            <a className="btn quiet small bell" href="#/inbox" aria-label={s.unread ? `Уведомления: ${s.unread} непрочитанных` : 'Уведомления'}>
              <Icon name="bell" />
              {s.unread ? (
                <span className="badge" aria-hidden="true">
                  {s.unread > 99 ? '99+' : s.unread}
                </span>
              ) : null}
            </a>
          </div>
        </div>
        <div className="page">
          {subnav ? (
            <nav className="subnav" aria-label={subnav === gameTabs ? s.realmName : 'Обращения'}>
              {subnav.map((t) => (
                <a key={t.href} href={t.href} aria-current={t.on ? 'page' : undefined}>
                  {t.label}
                </a>
              ))}
            </nav>
          ) : null}
          {page}
        </div>
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

const TAB_ICON: Record<string, IconName> = {
  '#/': 'inbox-stack',
  '#/work': 'briefcase',
  '#/board': 'columns',
  '#/inbox': 'bell',
  '#/overview': 'chart',
  '#/kingdom': 'castle',
  '#/council': 'table',
  '#/rating': 'trophy',
  '#/library': 'library',
  '#/me': 'person',
};

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
