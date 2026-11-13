import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorText, setToken } from '../lib/api';
import { useLite } from '../lib/lite';
import type { Persona, Personas } from '../lib/types';
import { Crest, crestKind } from '../components/Crest';
import '@fontsource/cormorant-garamond/cyrillic-700.css';
import '@fontsource/cormorant-garamond/latin-700.css';
import '../components/kingdom-login.css';

/** Drawn fallback, used only if the castle picture cannot load; never blocks sign-in. */
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

/** What MODUS FLOW does, one tap each — words only, no data. */
const FEATURES: { id: string; label: ReactNode; text: string; icon: ReactNode }[] = [
  {
    id: 'ideas',
    label: (
      <>
        Идеи
        <br />
        сотрудников
      </>
    ),
    text: 'Любой сотрудник предлагает идею или сообщает о проблеме — у каждого обращения появляются ответственный и срок.',
    icon: <path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3ZM9.5 19h5M10.5 21.5h3" />,
  },
  {
    id: 'decisions',
    label: (
      <>
        Совместные
        <br />
        решения
      </>
    ),
    text: 'Совет обсуждает, решает назначенный ответственный. Никто не принимает решение по собственной идее.',
    icon: <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6M11 15.2c1.2-.8 2.9-1.2 5-1.2 3 0 5.5 2.7 5.5 6" />,
  },
  {
    id: 'growth',
    label: (
      <>
        Развитие
        <br />
        компании
      </>
    ),
    text: 'Внедрённые идеи растят замки подразделений. Без личных рейтингов — заслуга видна команде.',
    icon: <path d="M3 21h18M6 21v-5M10.5 21v-8M15 21v-6M19.5 21V9M4 12l5-5 4 3 7-6M16 4h4v4" />,
  },
];

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
  const cardsRef = useRef<HTMLFieldSetElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);

  useEffect(() => {
    api<Personas>('/demo/personas')
      .then((d) => {
        setData(d);
        // The first character is ready, so «Войти в Королевство» works with one tap.
        setSelected((s) => s ?? d.personas[0]?.userId ?? null);
      })
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
      <CastlePicture still={lite} />

      <header className="kl-hero">
        <span className="kl-ornament" aria-hidden="true">
          <CrownMark />
        </span>
        <h1 id="kl-title">
          <span className="kl-eyebrow">Добро пожаловать в</span>
          <span className="kl-title">Королевство идей</span>
        </h1>
        <p className="kl-sub">Каждая идея имеет значение. Каждое решение меняет Королевство.</p>
      </header>

      <section className="kl-panel" aria-labelledby="kl-title">
        <div className="kl-brand">
          <img src="/icon.svg" alt="" width={36} height={36} />
          <span>
            <span className="kl-wordmark">MODUS FLOW</span>
            <span className="kl-tagline">Обратная связь и предложения сотрудников</span>
          </span>
          {!ssoOnly && <span className="kl-demo" title="Демонстрационный стенд">DEMO</span>}
        </div>

        <Features />

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
            {error && (
              <div className="kl-error" role="alert">
                {error}
              </div>
            )}

            {data && (
              <button ref={enterRef} type="button" className="kl-enter" onClick={() => void enter()} disabled={busy}>
                <CrownMark />
                <span className="kl-enter-text">
                  <span>{busy ? 'Открываем ворота…' : 'Войти в Королевство'}</span>
                  {chosen && !busy && (
                    <small>
                      как {chosen.name}
                      {chosen.gameTitle ? ` · ${chosen.gameTitle}` : ''}
                    </small>
                  )}
                </span>
                <Arrow />
              </button>
            )}
            {hint && (
              <p className="kl-hint" role="alert">
                {hint}
              </p>
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
                  <legend>
                    <span>Выберите персонажа</span>
                  </legend>
                  {shown.map((p) => (
                    <CharacterCard key={p.userId} p={p} selected={p.userId === selected} onPick={pick} onEnter={() => void enter()} disabled={busy} />
                  ))}
                </fieldset>
                <div className="kl-after-cards">
                  {people.length > FEATURED && <AllCharacters people={people} onPick={(id) => (pick(id), enterRef.current?.focus())} disabled={busy} />}
                  <span className="kl-footnote">
                    <strong>Демо-режим:</strong> персонажи вымышлены, корпоративный вход (SSO) подключается при внедрении. Звание —
                    игровое и прав не даёт: права задаются ролями.
                  </span>
                </div>
              </>
            )}
          </>
        )}
      </section>

      {entering && <Gate p={entering} onSkip={finish} />}
    </main>
  );
}

/** The castle picture (two crops: wide for desktop, tighter for phones); the drawn scene if it fails to load. */
function CastlePicture({ still }: { still: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="kl-scene" aria-hidden="true">
      {failed ? (
        <Suspense fallback={null}>
          <KingdomScene still={still} />
        </Suspense>
      ) : (
        <picture>
          <source media="(max-width: 960px)" srcSet="/media/login/castle-m-640.webp 640w, /media/login/castle-m-941.webp 941w" sizes="100vw" />
          <img
            src="/media/login/castle-1672.webp"
            srcSet="/media/login/castle-1000.webp 1000w, /media/login/castle-1672.webp 1672w"
            sizes="100vw"
            alt=""
            decoding="async"
            onError={() => setFailed(true)}
          />
        </picture>
      )}
    </div>
  );
}

function Features() {
  const [open, setOpen] = useState<string | null>(null);
  const shown = FEATURES.find((f) => f.id === open);
  return (
    <div className="kl-features">
      <ul>
        {FEATURES.map((f) => (
          <li key={f.id}>
            <button type="button" aria-expanded={open === f.id} aria-controls="kl-feature-text" onClick={() => setOpen(open === f.id ? null : f.id)}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                {f.icon}
              </svg>
              <span>{f.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <p id="kl-feature-text" className="kl-feature-text" aria-live="polite" hidden={!shown}>
        {shown?.text}
      </p>
    </div>
  );
}

function CharacterCard({
  p,
  selected,
  onPick,
  onEnter,
  disabled,
}: {
  p: Persona;
  selected: boolean;
  onPick: (id: string) => void;
  onEnter: () => void;
  disabled: boolean;
}) {
  const kind = crestKind(p.civilization, p.titleRank);
  return (
    <div className="kl-card-wrap" data-selected={selected || undefined}>
      <label className="kl-card" data-selected={selected || undefined}>
        <input type="radio" name="persona" value={p.userId} checked={selected} onChange={() => onPick(p.userId)} disabled={disabled} className="sr-only" />
        <Crest kind={kind} />
        <span className="kl-card-body">
          <span className="kl-who">
            <span className="kl-name">{p.name}</span>
            {p.gameTitle && <span className={`kl-rank kl-rank-${kind}`}>{p.gameTitle}</span>}
          </span>
          <span className="kl-job">
            {p.title} · {p.department}
          </span>
        </span>
        <span className="kl-pick" aria-hidden="true" />
      </label>
      {selected && (
        <div className="kl-detail">
          <p>
            <b>Права:</b> {rightsOf(p).toLowerCase()}.
          </p>
          <p>
            <b>Откроется:</b> {startOf(p).label}.
          </p>
          <button type="button" className="kl-card-enter" onClick={onEnter} disabled={disabled}>
            Войти как {p.name.split(' ')[0]} <Arrow />
          </button>
        </div>
      )}
    </div>
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
        Все персонажи · {people.length} <Arrow />
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
          {found.map((p) => {
            const kind = crestKind(p.civilization, p.titleRank);
            return (
              <li key={p.userId}>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onPick(p.userId);
                  }}
                >
                  <Crest kind={kind} size={36} />
                  <span>
                    <span className="kl-who">
                      <span className="kl-name">{p.name}</span>
                      {p.gameTitle && <span className={`kl-rank kl-rank-${kind}`}>{p.gameTitle}</span>}
                    </span>
                    <span className="kl-job">
                      {p.title} · {p.department}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
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

function CrownMark() {
  return (
    <svg className="kl-crown" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 18 2 7l5.5 4.5L12 4l4.5 7.5L22 7l-1 11Z M3.5 20h17v2h-17Z" />
    </svg>
  );
}
function Arrow() {
  return (
    <svg className="kl-arrow" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 12h15M13 6l6 6-6 6" />
    </svg>
  );
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
