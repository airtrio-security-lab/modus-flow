import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, setToken } from '../lib/api';
import { useLite } from '../lib/lite';
import type { Persona, Personas } from '../lib/types';
import { Crest, crestKind } from '../components/Crest';
import '../components/kingdom-login.css';

/** The picture is decoration and loads after the panel; sign-in never waits for it. */
const KingdomScene = lazy(() => import('../components/KingdomScene'));

/** Characters shown on the first screen; the rest are one click away, with search. */
const FEATURED = 5;
const ENTER_MS = 1100;

/** Rights in words, straight from the person's roles — the same for every style and title. */
const RIGHTS: [string, string][] = [
  ['org_admin', 'администрирует организацию'],
  ['decision_owner', 'принимает решения'],
  ['maintainer', 'ведёт обращения'],
  ['archivist', 'проверяет знания Библиотеки'],
  ['employee', 'подаёт обращения'],
];
function rightsOf(p: Persona): string {
  if (!p.roles?.length) return cap(p.hint.split(': ')[1] ?? p.hint);
  return cap(RIGHTS.filter(([r]) => p.roles!.includes(r)).map(([, t]) => t).join(', '));
}

/** Where the person lands. A start page only: every page stays reachable by the usual rules. */
function startOf(p: Persona): { href: string; label: string } {
  if (p.titleRank === 'king' || p.titleRank === 'regent') return { href: '#/kingdom', label: 'обзор Королевства' };
  if (p.titleRank === 'castle_head' && p.castleId) return { href: `#/castles/${p.castleId}`, label: `замок «${p.department}»` };
  return { href: '#/', label: 'мои обращения' };
}

/**
 * Sign-in to the Kingdom. In the demo (MODUS_DEMO_LOGIN=true, refused in production by the server)
 * the visitor picks a fictional character that is one of the seeded demo accounts. Without the demo
 * the server answers 404 and the screen shows no people at all: corporate SSO (OIDC, ADR-0009)
 * replaces it at rollout and is not imitated here.
 */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [data, setData] = useState<Personas | null>(null);
  const [ssoOnly, setSsoOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [entering, setEntering] = useState<Persona | null>(null);
  const [lite] = useLite();
  const band = useNarrow();
  const cardsRef = useRef<HTMLFieldSetElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);

  useEffect(() => {
    api<Personas>('/demo/personas')
      .then(setData)
      .catch((e) => (e?.status === 404 ? setSsoOnly(true) : setError(errorText(e))));
  }, []);

  const people = data?.personas ?? [];
  const chosen = people.find((p) => p.userId === selected) ?? null;
  const shown = useMemo(() => {
    const top = people.slice(0, FEATURED);
    return chosen && !top.includes(chosen) ? [...top, chosen] : top;
  }, [people, chosen]);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    onSignedIn();
  };
  useEffect(() => {
    if (!entering) return;
    const t = window.setTimeout(finish, ENTER_MS);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && finish();
    window.addEventListener('keydown', esc);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', esc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entering]);

  function pick(id: string) {
    setSelected(id);
    setHint(null);
    setError(null);
  }

  async function enter() {
    if (!chosen) {
      setHint('Сначала выберите персонажа.');
      cardsRef.current?.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token } = await api<{ token: string }>('/demo/login', { json: { userId: chosen.userId }, idempotent: false });
      setToken(token);
      // A shared link (#/items/12) wins over the start page.
      if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = startOf(chosen).href;
      if (lite) finish();
      else setEntering(chosen);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <main className="kl">
      <div className="kl-scene">
        <Suspense fallback={null}>
          <KingdomScene still={lite} band={band} />
        </Suspense>
      </div>

      <section className="kl-panel" aria-labelledby="kl-title">
        <header className="kl-brand">
          <img src="/icon.svg" alt="" width={32} height={32} />
          <span className="kl-wordmark">MODUS FLOW</span>
          {!ssoOnly && <span className="kl-demo" title="Демонстрационный стенд">DEMO</span>}
        </header>

        <div className="kl-intro">
          <h1 id="kl-title">Добро пожаловать в Королевство идей</h1>
          <p>Каждая идея имеет значение. Каждое решение меняет Королевство.</p>
        </div>

        {ssoOnly ? (
          <div className="kl-sso">
            <h2>Вход через корпоративную учётную запись</h2>
            <p>
              Корпоративный вход (SSO) подключается при внедрении. На этом сервере демонстрационный вход выключен, поэтому
              персонажи не показываются.
            </p>
          </div>
        ) : (
          <>
            <p className="kl-note">
              <strong>Демо-режим.</strong> Персонажи вымышлены. Корпоративный вход (SSO) подключается при внедрении.
            </p>

            {error && (
              <div className="kl-error" role="alert">
                {error}
              </div>
            )}

            {!data && !error && (
              <div className="kl-cards" aria-busy="true" aria-label="Загружаем персонажей">
                {Array.from({ length: FEATURED }, (_, i) => (
                  <div key={i} className="kl-card kl-skeleton" />
                ))}
              </div>
            )}

            {data && (
              <>
                <fieldset className="kl-cards" ref={cardsRef}>
                  <legend>Выберите персонажа</legend>
                  {shown.map((p) => (
                    <CharacterCard key={p.userId} p={p} selected={p.userId === selected} onPick={pick} disabled={busy} />
                  ))}
                </fieldset>
                <div className="kl-after-cards">
                  {people.length > FEATURED && <AllCharacters people={people} onPick={(id) => (pick(id), enterRef.current?.focus())} disabled={busy} />}
                  <span className="kl-footnote">Звание — игровое и прав не даёт. Права задаются ролями.</span>
                </div>
                {hint && (
                  <p className="kl-hint" role="alert">
                    {hint}
                  </p>
                )}
                <button ref={enterRef} type="button" className="kl-enter" data-ready={chosen ? '' : undefined} onClick={() => void enter()} disabled={busy}>
                  {busy ? 'Открываем ворота…' : chosen ? `Войти в Королевство · ${chosen.name}` : 'Войти в Королевство'}
                </button>
              </>
            )}
          </>
        )}
      </section>

      {entering && <Gate p={entering} onSkip={finish} />}
    </main>
  );
}

function CharacterCard({ p, selected, onPick, disabled }: { p: Persona; selected: boolean; onPick: (id: string) => void; disabled: boolean }) {
  return (
    <label className="kl-card" data-selected={selected || undefined}>
      <input type="radio" name="persona" value={p.userId} checked={selected} onChange={() => onPick(p.userId)} disabled={disabled} className="sr-only" />
      <Crest kind={crestKind(p.civilization, p.titleRank)} />
      <span className="kl-card-body">
        <span className="kl-who">
          <span className="kl-name">{p.name}</span>
          {p.gameTitle && <span className="kl-rank">{p.gameTitle}</span>}
        </span>
        <span className="kl-job">
          {p.title} · {p.department}
        </span>
        {selected && (
          <span className="kl-detail">
            <span>
              <b>Права:</b> {rightsOf(p).toLowerCase()}.
            </span>
            <span>
              <b>Откроется:</b> {startOf(p).label}.
            </span>
          </span>
        )}
      </span>
      <span className="kl-pick" aria-hidden="true">
        {selected ? 'Выбран' : 'Выбрать'}
      </span>
    </label>
  );
}

function AllCharacters({ people, onPick, disabled }: { people: Persona[]; onPick: (id: string) => void; disabled: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const found = needle
    ? people.filter((p) => [p.name, p.title, p.department, p.gameTitle ?? ''].some((t) => t.toLowerCase().includes(needle)))
    : people;
  const close = () => {
    ref.current?.close();
    setQ('');
  };
  return (
    <>
      <button type="button" className="kl-all" onClick={() => ref.current?.showModal()} disabled={disabled}>
        Все персонажи · {people.length}
      </button>
      <dialog ref={ref} className="kl-dialog" aria-labelledby="kl-all-title" onClose={() => setQ('')}>
        <div className="kl-dialog-head">
          <h2 id="kl-all-title">Все персонажи</h2>
          <button type="button" className="kl-close" onClick={close} aria-label="Закрыть">
            ×
          </button>
        </div>
        <label className="kl-search">
          <span className="sr-only">Поиск по имени, должности или подразделению</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // One Escape closes the list (the search field would otherwise only clear itself).
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              }
            }}
            placeholder="Имя, должность или подразделение"
            autoFocus
          />
        </label>
        <ul className="kl-all-list">
          {found.map((p) => (
            <li key={p.userId}>
              <button
                type="button"
                onClick={() => {
                  close();
                  onPick(p.userId);
                }}
              >
                <Crest kind={crestKind(p.civilization, p.titleRank)} size={34} />
                <span>
                  <span className="kl-name">{p.name}</span>
                  <span className="kl-job">
                    {p.gameTitle ? `${p.gameTitle} · ` : ''}
                    {p.title} · {p.department}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {!found.length && <li className="kl-empty">Никого не нашли. Попробуйте другое слово.</li>}
        </ul>
      </dialog>
    </>
  );
}

function Gate({ p, onSkip }: { p: Persona; onSkip: () => void }) {
  return (
    <div className="kl-gate" role="status">
      <div className="kl-gate-inner">
        <Crest kind={crestKind(p.civilization, p.titleRank)} size={72} />
        <p className="kl-gate-title">Ворота открываются</p>
        <p className="kl-gate-who">
          {p.gameTitle ? `${p.gameTitle} ` : ''}
          {p.name} входит в Королевство
        </p>
        <span className="kl-gate-bar" aria-hidden="true">
          <span />
        </span>
        <button type="button" className="kl-skip" onClick={onSkip} autoFocus>
          Пропустить
        </button>
      </div>
    </div>
  );
}

/** The one-column layout (≤ 960 px) shows the picture as a band framed on the castle. */
function useNarrow() {
  const q = '(max-width: 960px)';
  const [v, setV] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setV(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return v;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
