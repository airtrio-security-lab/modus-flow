import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { useLite } from '../lib/lite';
import { useSession } from '../lib/session';
import { facts } from '../lib/can';
import { due } from '../lib/format';
import { useLoad } from '../lib/session';
import type { Castle, Envoy, IdeaDetail, Kingdom as KingdomData, ListItem } from '../lib/types';
import { AiAssessment, DeferControl, ItemTrack } from '../components/ItemQuick';
import { CIVS, civOf, type Civ } from '../components/civ';
import { World, webglSupported, type Anchor, type AnchorKind, type Quality, type View } from '../world3d/world';
import { HERALDRY, envoyState } from './Kingdom';

/**
 * «3D-город» (ADR-0026): the commonwealth as a real-time scene with a dark game HUD. Everything
 * shown comes from the same `/kingdom` response as the schematic map and the table: departments,
 * their civilization and server-computed level, open items and their stage. The scene has no
 * rules of its own — a click only moves the camera and opens existing screens.
 */
const VIEW_KEY = 'modus.w3d.view';
const HINT_KEY = 'modus.w3d.hint';
type Mode = '3d' | 'city' | 'work';
interface PersonHit {
  id: string;
  name: string;
  job: string | null;
  departmentId: string | null;
  department: string | null;
}

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const coarse = () => {
  try {
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;
  } catch {
    return false;
  }
};

/** Original emblems of the four styles and of the neutral places: simple marks, no borrowed heraldry. */
export function Emblem({ kind }: { kind: Civ | 'realm' | 'library' | 'archive' | 'plaza' | 'camp' }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  let body: ReactNode;
  if (kind === 'camelot') body = <path {...p} d="M7 19V9h2V6h2v3h2V6h2v3h2v10M7 19h10M11 19v-4h2v4" />;
  else if (kind === 'japan')
    body = (
      <>
        <circle {...p} cx="12" cy="12" r="8" />
        {[0, 1, 2, 3, 4].map((i) => {
          const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
          return <circle key={i} cx={12 + Math.cos(a) * 4} cy={12 + Math.sin(a) * 4} r="1.7" fill="currentColor" />;
        })}
      </>
    );
  else if (kind === 'kazakh')
    body = (
      <>
        <path {...p} d="M12 3.5l6.5 8.5-6.5 8.5L5.5 12z" />
        <circle cx="12" cy="12" r="2" fill="currentColor" />
      </>
    );
  else if (kind === 'mongolia') body = <path {...p} d="M6 18V6h12v8.500H10V10h4" />;
  else if (kind === 'library') body = <path {...p} d="M4 6.500c2.5-1 5.5-1 8 .5 2.5-1.5 5.5-1.5 8-.5v11c-2.5-1-5.5-1-8 .5-2.5-1.5-5.5-1.5-8-.5zM12 7v11" />;
  else if (kind === 'archive') body = <path {...p} d="M5 9l7-4.500L19 9M6.5 9v8M10 9v8M14 9v8M17.5 9v8M4.5 19.500h15" />;
  else if (kind === 'plaza') body = <path {...p} d="M8 4h8v4a4 4 0 01-8 0zM8 6H5.500a2.5 2.5 0 002.5 3M16 6h2.500A2.5 2.5 0 0116 9M12 12v4M8.5 19.500h7M10 16h4" />;
  else if (kind === 'camp') body = <path {...p} d="M3.5 19L12 5l8.5 14zM12 5v14M9.5 19l2.5-4.5 2.5 4.5" />;
  else
    body = (
      <>
        <circle {...p} cx="12" cy="12" r="4.5" />
        {[0, 1, 2, 3].map((i) => (
          <circle key={i} cx={12 + Math.cos((i * Math.PI) / 2) * 8.5} cy={12 + Math.sin((i * Math.PI) / 2) * 8.5} r="1.5" fill="currentColor" />
        ))}
      </>
    );
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {body}
    </svg>
  );
}

const PLACES: { id: string; kind: Exclude<AnchorKind, 'district' | 'envoy'>; title: string; sub: string; href: string }[] = [
  { id: 'palace', kind: 'palace', title: 'Большой Круглый стол', sub: 'Совет Содружества', href: '#/council' },
  { id: 'library', kind: 'library', title: 'Великая библиотека', sub: 'Летопись и решения', href: '#/library' },
  { id: 'archive', kind: 'archive', title: 'Высший Архив', sub: 'Наследие Совета', href: '#/library?hall=archive' },
  { id: 'plaza', kind: 'plaza', title: 'Площадь достижений', sub: 'Рейтинг подразделений', href: '#/rating' },
  { id: 'camp', kind: 'camp', title: 'Без подразделения', sub: 'Ждут распределения', href: '#/all' },
];

export function City3D({ k, onMode, onUnavailable, onReload }: { k: KingdomData; onMode: (m: Mode) => void; onUnavailable: (why: string) => void; onReload: () => void }) {
  const s = useSession();
  const [lite] = useLite();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<World | null>(null);
  const labels = useRef(new Map<string, HTMLElement>());
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [hoverEnvoy, setHoverEnvoy] = useState<string | null>(null);
  const [envoyOpen, setEnvoyOpen] = useState<number | null>(null);
  const envoyOpenRef = useRef<number | null>(null);
  envoyOpenRef.current = envoyOpen;
  const [flying, setFlying] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const pending = useRef<string | null>(null);
  const colors = useMemo(() => new Map(k.castles.map((c, i) => [c.id, HERALDRY[i % HERALDRY.length]!])), [k.castles]);
  const current = selected ? k.castles.find((c) => c.id === selected) : undefined;

  // The engine lives as long as the screen: created once, fed with data, disposed on leave.
  useEffect(() => {
    if (!host.current || !canvas.current) return;
    if (!webglSupported()) {
      onUnavailable('На этом устройстве нет WebGL — показана схема города.');
      return;
    }
    // The device's own choice wins (key `modus.w3d.quality`); otherwise phones get the middle tier.
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('modus.w3d.quality');
    } catch {
      /* ignore */
    }
    const quality: Quality = stored === 'low' || stored === 'medium' || stored === 'high' ? stored : lite ? 'low' : coarse() ? 'medium' : 'high';
    let w: World;
    try {
      w = new World(canvas.current, host.current, quality);
    } catch {
      onUnavailable('Не удалось запустить 3D на этом устройстве — показана схема города.');
      return;
    }
    world.current = w;
    w.live = !lite && !reducedMotion();
    w.onLost = () => onUnavailable('Графический контекст потерян — показана схема города.');
    w.onFlight = setFlying;
    w.onHover = (id, kind) => setHoverEnvoy(kind === 'envoy' ? id : null);
    w.onAnchors = (list) => place(list);
    const ro = new ResizeObserver(() => {
      const el = host.current;
      if (el) w.resize(el.clientWidth, el.clientHeight);
    });
    ro.observe(host.current);
    w.resize(host.current.clientWidth, host.current.clientHeight);
    (window as unknown as { __world?: World }).__world = w;
    return () => {
      try {
        sessionStorage.setItem(VIEW_KEY, JSON.stringify(w.getView()));
      } catch {
        /* storage unavailable */
      }
      ro.disconnect();
      w.dispose();
      world.current = null;
      delete (window as unknown as { __world?: World }).__world;
    };
    // The engine is rebuilt only when the quality tier changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lite]);

  /** Put every label where its building is on the screen; far labels shrink to an emblem. */
  const place = (list: Anchor[]) => {
    const narrow = (host.current?.clientWidth ?? 1200) < 760;
    const height = host.current?.clientHeight ?? 800;
    const taken: { x: number; y: number }[] = [];
    // Nearest first, so the card of the envoy in front wins the place; the opened one is always shown.
    const order = [...list].sort((p, q) => (p.kind === 'envoy' ? 1 : 0) - (q.kind === 'envoy' ? 1 : 0) || p.dist - q.dist);
    for (const a of order) {
      const el = labels.current.get(a.id);
      if (!el) continue;
      let show = a.visible;
      if (a.kind === 'envoy' && show) {
        const mine = `e${envoyOpenRef.current}` === a.id;
        // Not under the top bar or the bottom bar, where a card could not be read anyway.
        const clear = a.y > 96 && a.y < height - (narrow ? 150 : 84);
        show = mine || (clear && a.dist < (narrow ? 560 : 820) && !taken.some((t) => Math.abs(t.x - a.x) < 132 && Math.abs(t.y - a.y) < 34));
        if (show) taken.push({ x: a.x, y: a.y });
      }
      if (!show) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = 'visible';
      el.style.transform = `translate3d(${Math.round(a.x)}px, ${Math.round(a.y)}px, 0) translate(-50%, -100%)`;
      el.style.zIndex = String(100000 - Math.round(a.dist));
      // Far away a plate shrinks to its emblem, so the centre of the city stays readable.
      const limit = a.kind === 'district' ? (narrow ? 700 : 1500) : a.kind === 'palace' ? 2600 : narrow ? 380 : 560;
      el.dataset.far = a.dist > limit ? 'yes' : 'no';
    }
  };

  // Districts: civilization and level are whatever the server says.
  const sig = k.castles.map((c) => `${c.id}:${c.civilization}:${c.level}`).join('|');
  const achievements = k.castles.reduce((n, c) => n + (c.achievements ?? 0), 0);
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    w.setData({
      districts: k.castles.map((c) => ({ id: c.id, name: c.name, civ: civOf(c.civilization), level: c.level, color: colors.get(c.id)! })),
      achievements,
    });
    if (!ready) {
      // Coming back from a district or a hall: the camera is where it was left.
      try {
        const saved = sessionStorage.getItem(VIEW_KEY);
        if (saved) w.setView(JSON.parse(saved) as View);
      } catch {
        /* ignore */
      }
      setReady(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, achievements, lite]);

  // Envoys stand where their real status puts them.
  const envoySig = k.envoys.map((e) => `${e.number}:${e.status}:${e.departmentId}:${e.responded}:${e.overdueFirstResponse}:${e.mine}:${e.deferredUntil}`).join('|');
  useEffect(() => {
    world.current?.setEnvoys(
      k.envoys.map((e) => ({ id: `e${e.number}`, districtId: e.departmentId, t: envoyState(e).t, tone: e.deferredUntil ? 'paused' : e.overdueFirstResponse || e.overdueResolution ? 'late' : e.mine ? 'mine' : 'normal' })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envoySig, sig, lite]);

  useEffect(() => {
    const w = world.current;
    const el = host.current;
    if (!w || !el) return;
    w.select(selected);
    // The card covers the right side on a desktop and the lower half on a phone.
    const open = Boolean(selected) || listOpen || envoyOpen !== null;
    // Even with no card open the bottom bar (and the tab bar on a phone) hides the lower edge of the city.
    if (!open) w.setCovered(0, el.clientWidth < 900 ? 150 : 84);
    else if (el.clientWidth < 900) w.setCovered(0, el.clientHeight * 0.46);
    else w.setCovered(360, 0);
  }, [selected, listOpen, envoyOpen, ready]);

  const fly = useCallback(async (id: string, then?: string) => {
    const w = world.current;
    if (!w) {
      if (then) location.hash = then;
      return;
    }
    const v = w.viewOf(id);
    pending.current = then ?? null;
    if (v) await w.flyTo(v, lite || reducedMotion() ? 0 : 1900);
    if (pending.current === then && then) location.hash = then;
  }, [lite]);

  const openDistrict = useCallback(
    (id: string) => {
      setSelected(id);
      setListOpen(false);
      setEnvoyOpen(null);
      void fly(id);
    },
    [fly],
  );

  const openEnvoy = useCallback(
    (number: number) => {
      setEnvoyOpen(number);
      setSelected(null);
      setListOpen(false);
      // The camera comes to the envoy, so its card stays in view next to the sheet.
      void fly(`e${number}`);
    },
    [fly],
  );

  // A click on the building itself (not only on its label) does the same as the label.
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    w.onPick = (id, kind) => {
      if (!id) {
        setSelected(null);
        setEnvoyOpen(null);
        return;
      }
      if (kind === 'district') openDistrict(id);
      else if (kind === 'envoy') openEnvoy(Number(id.slice(1)));
      else {
        const p = PLACES.find((x) => x.id === id);
        if (p) void fly(id, p.href);
      }
    };
  }, [openDistrict, openEnvoy, fly, ready]);

  const dismissHint = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const w = world.current;
    if (!w) return;
    const map: Record<string, Parameters<World['nudge']>[0]> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', q: 'ccw', e: 'cw', й: 'ccw', у: 'cw', Home: 'home' };
    const key = map[e.key];
    if (e.key === 'Escape') {
      if (w.flying) {
        pending.current = null;
        w.skip();
      } else if (listOpen) setListOpen(false);
      else if (envoyOpen !== null) setEnvoyOpen(null);
      else setSelected(null);
    } else if (key && !(e.target as HTMLElement).closest('a, button')) {
      e.preventDefault();
      w.nudge(key);
    }
  };
  const ref = (id: string) => (el: HTMLElement | null) => {
    if (el) labels.current.set(id, el);
    else labels.current.delete(id);
  };
  const inWork = k.envoys.filter((e) => e.status === 'in_progress').length;
  const waiting = k.envoys.filter((e) => !e.responded && e.status !== 'in_progress').length;
  const late = k.envoys.filter((e) => e.overdueFirstResponse || e.overdueResolution).length;
  const xp = k.castles.reduce((n, c) => n + c.xp, 0);

  return (
    <div className="w3d" data-sheet={selected || listOpen || envoyOpen !== null ? 'yes' : 'no'} ref={host} tabIndex={0} onKeyDown={onKey} role="application" aria-label={`${s.realmName}: трёхмерный город подразделений. Стрелки двигают камеру, плюс и минус приближают, Q и E поворачивают. Все здания доступны кнопками ниже.`}>
      <canvas ref={canvas} className="w3d-canvas" aria-hidden="true" />
      {!ready ? (
        <div className="w3d-loading" role="status">
          Строим город…
        </div>
      ) : null}

      <div className="w3d-labels">
        {k.castles.map((c) => {
          const civ = CIVS.find((x) => x.id === civOf(c.civilization))!;
          return (
            <button
              key={c.id}
              type="button"
              data-world-ui=""
              ref={ref(c.id)}
              className="w3d-plate"
              data-on={selected === c.id ? 'yes' : 'no'}
              style={{ ['--plate' as string]: colors.get(c.id) }}
              aria-label={`${civ.name}. ${c.name}, уровень ${c.level} — ${c.levelName}. ${c.envoys} ${plural(c.envoys, 'обращение', 'обращения', 'обращений')} в работе`}
              onClick={() => openDistrict(c.id)}
              onDoubleClick={() => void fly(c.id, `#/castles/${c.id}`)}
            >
              <span className="w3d-plate-mark">
                <Emblem kind={civ.id} />
              </span>
              <span className="w3d-plate-text">
                <b>{civ.name}</b>
                <span>
                  {c.name} · уровень {c.level}
                </span>
              </span>
            </button>
          );
        })}
        {PLACES.map((p) => (
          <a
            key={p.id}
            data-world-ui=""
            ref={ref(p.id)}
            className="w3d-plate"
            data-kind={p.kind}
            href={p.href}
            aria-label={`${p.title}: ${p.sub}${p.kind === 'camp' ? `, ${k.wildlands}` : ''}`}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey || e.button !== 0) return;
              e.preventDefault();
              void fly(p.id, p.href);
            }}
          >
            <span className="w3d-plate-mark">
              <Emblem kind={p.kind === 'palace' ? 'realm' : p.kind} />
            </span>
            <span className="w3d-plate-text">
              <b>{p.title}</b>
              <span>{p.kind === 'camp' ? `${k.wildlands} ${plural(k.wildlands, 'обращение', 'обращения', 'обращений')}` : p.kind === 'plaza' ? `${achievements} ${plural(achievements, 'достижение', 'достижения', 'достижений')}` : p.sub}</span>
            </span>
          </a>
        ))}
        {k.envoys.map((e) => {
          const st = envoyState(e);
          const late = e.overdueFirstResponse || e.overdueResolution;
          const from = e.author ? shortName(e.author) : (k.castles.find((c) => c.id === e.departmentId)?.name ?? 'Без подразделения');
          return (
            <button
              key={e.number}
              type="button"
              data-world-ui=""
              ref={ref(`e${e.number}`)}
              className="w3d-envoy"
              data-tone={e.deferredUntil ? 'paused' : late ? 'late' : e.mine ? 'mine' : 'normal'}
              data-on={envoyOpen === e.number || hoverEnvoy === `e${e.number}` ? 'yes' : 'no'}
              style={{ ['--plate' as string]: (e.departmentId && colors.get(e.departmentId)) || '#7d8798' }}
              aria-label={`Обращение №${e.number} от ${e.author ?? 'сотрудника'}: ${e.title}. ${st.label}`}
              onClick={() => openEnvoy(e.number)}
            >
              <span className="w3d-envoy-head">
                <i aria-hidden="true" />
                <b>№{e.number}</b>
                <span>{from}</span>
              </span>
              <span className="w3d-envoy-more">
                <em>{e.title}</em>
                <small>{st.label}</small>
              </span>
            </button>
          );
        })}
      </div>

      <Hud k={k} onMode={onMode} onPick={openDistrict} onItem={(n) => (location.hash = `#/items/${n}`)} onPerson={(p) => (location.hash = `#/people/${p.id}`)} />

      <div className="w3d-bottom" data-world-ui="">
        <dl className="w3d-stats">
          <div>
            <dt>Обращения в пути</dt>
            <dd>{k.envoys.length}</dd>
          </div>
          <div>
            <dt>Ждут ответа</dt>
            <dd>{waiting}</dd>
          </div>
          <div>
            <dt>Внедряется</dt>
            <dd>{inWork}</dd>
          </div>
          <div data-alert={late ? 'yes' : 'no'}>
            <dt>Срок прошёл</dt>
            <dd>{late}</dd>
          </div>
          <div>
            <dt>Подтверждённый опыт</dt>
            <dd>{xp.toLocaleString('ru-RU')} XP</dd>
          </div>
        </dl>
        <a className="w3d-cta" href="#/new">
          Создать обращение
        </a>
      </div>

      <div className="w3d-controls" data-world-ui="" role="group" aria-label="Камера">
        {flying ? (
          <button
            type="button"
            className="w3d-skip"
            onClick={() => {
              world.current?.skip();
            }}
          >
            Пропустить перелёт
          </button>
        ) : null}
        <button type="button" aria-label="Список подразделений" aria-expanded={listOpen} onClick={() => setListOpen((v) => !v)}>
          ☰
        </button>
        <button type="button" aria-label="Повернуть влево" onClick={() => world.current?.nudge('ccw')}>
          ⟲
        </button>
        <button type="button" aria-label="Повернуть вправо" onClick={() => world.current?.nudge('cw')}>
          ⟳
        </button>
        <button type="button" aria-label="Приблизить" onClick={() => world.current?.nudge('in')}>
          +
        </button>
        <button type="button" aria-label="Отдалить" onClick={() => world.current?.nudge('out')}>
          −
        </button>
        <button
          type="button"
          aria-label="Весь город"
          onClick={() => {
            setSelected(null);
            const w = world.current;
            if (w) void w.flyTo(w.overview(), lite || reducedMotion() ? 0 : 1500);
          }}
        >
          ⌂
        </button>
      </div>

      {hint && ready ? (
        <div className="w3d-hint" data-world-ui="" role="note">
          <span>{coarse() ? 'Ведите пальцем, чтобы двигать город, двумя — приближать и поворачивать. Нажмите на замок, чтобы войти.' : 'Тяните мышью, чтобы двигать город; колесо приближает; правая кнопка или Shift поворачивает. Нажмите на замок, чтобы войти.'}</span>
          <button type="button" onClick={dismissHint}>
            Понятно
          </button>
        </div>
      ) : null}

      {listOpen ? (
        <div className="w3d-sheet" data-world-ui="" data-world-scroll="" role="dialog" aria-label="Подразделения Содружества">
          <header>
            <b>Подразделения</b>
            <button type="button" onClick={() => setListOpen(false)} aria-label="Закрыть список">
              ×
            </button>
          </header>
          <ul>
            {k.castles.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => openDistrict(c.id)}>
                  <span className="w3d-dot" style={{ background: colors.get(c.id) }} />
                  <span>
                    <b>{c.name}</b>
                    <small>
                      {CIVS.find((x) => x.id === civOf(c.civilization))!.name} · уровень {c.level} · {c.levelName}
                    </small>
                  </span>
                  <em>{c.envoys}</em>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {envoyOpen !== null && !listOpen ? <EnvoySheet key={envoyOpen} number={envoyOpen} envoy={k.envoys.find((e) => e.number === envoyOpen)} onClose={() => setEnvoyOpen(null)} onChanged={onReload} /> : null}

      {current && !listOpen && envoyOpen === null ? <DistrictSheet c={current} color={colors.get(current.id)!} envoys={k.envoys.filter((e) => e.departmentId === current.id)} onClose={() => setSelected(null)} onEnter={(href) => void fly(current.id, href)} /> : null}
    </div>
  );
}

const shortName = (full: string) => {
  const [first, ...rest] = full.trim().split(/\s+/);
  return rest.length ? `${first![0]}. ${rest[rest.length - 1]}` : full;
};

/**
 * The envoy's card: who it is from, what it says, where it stands — and the two things a reader may do
 * right here: ask the AI for an assessment and, for the person who decides, postpone the decision.
 */
function EnvoySheet({ number, envoy, onClose, onChanged }: { number: number; envoy: Envoy | undefined; onClose: () => void; onChanged: () => void }) {
  const s = useSession();
  const { data: item, error, reload } = useLoad(() => api<IdeaDetail>(`/orgs/${s.org}/ideas/${number}`), [s.org, number]);
  const [full, setFull] = useState(false);
  const rev = item ? (item.revisions.find((r) => r.status === 'current') ?? item.revisions[item.revisions.length - 1]) : undefined;
  const f = item ? facts({ membershipId: s.membershipId, roles: s.roles }, item) : null;
  const deadline = item && !item.deferral ? due(item.resolutionDueAt) : null;
  const long = (rev?.problem.length ?? 0) > 260;
  return (
    <section className="w3d-sheet w3d-item" data-world-ui="" data-world-scroll="" aria-label={`Обращение №${number}`}>
      <header>
        <span>
          <small>Обращение №{number}</small>
          <b>{rev?.title ?? envoy?.title ?? '…'}</b>
        </span>
        <button type="button" onClick={onClose} aria-label="Закрыть карточку обращения">
          ×
        </button>
      </header>
      {error ? <p className="quick-note" data-kind="warn">Не удалось открыть обращение. Возможно, оно вам недоступно.</p> : null}
      {!item && !error ? <p className="w3d-more">Читаем обращение…</p> : null}
      {item && rev && f ? (
        <>
          <dl className="w3d-who">
            <div>
              <dt>От кого</dt>
              <dd>
                {item.author.name}
                {item.department ? <small>{item.department}</small> : null}
              </dd>
            </div>
            <div>
              <dt>Кто отвечает</dt>
              <dd>
                {item.maintainer?.name ?? 'ищем ответственного'}
                {item.decisionOwner && item.decisionOwner.membershipId !== item.maintainer?.membershipId ? <small>решает {item.decisionOwner.name}</small> : null}
              </dd>
            </div>
          </dl>
          <ItemTrack status={item.status} paused={Boolean(item.deferral)} />
          <p className="w3d-state">
            {envoy ? envoyState(envoy).label : ''}
            {deadline ? <span data-late={deadline.late ? 'yes' : 'no'}> · срок решения {deadline.text}</span> : null}
          </p>
          <div className="w3d-text" data-full={full || !long ? 'yes' : 'no'}>
            <p>{rev.problem}</p>
            {rev.proposal && rev.proposal !== rev.problem ? (
              <p>
                <b>Предложение.</b> {rev.proposal}
              </p>
            ) : null}
          </div>
          {long ? (
            <button type="button" className="w3d-link" onClick={() => setFull((v) => !v)}>
              {full ? 'Свернуть' : 'Читать полностью'}
            </button>
          ) : null}
          <div className="w3d-actions">
            <a className="w3d-cta" href={`#/items/${number}`}>
              Открыть обращение
            </a>
          </div>
          <DeferControl
            item={item}
            f={f}
            onChanged={() => {
              void reload();
              onChanged();
            }}
          />
          <AiAssessment number={number} />
        </>
      ) : null}
    </section>
  );
}

/** The department's card over the city: desktop — a side panel, phone — a bottom sheet. */
function DistrictSheet({ c, color, envoys, onClose, onEnter }: { c: Castle; color: string; envoys: Envoy[]; onClose: () => void; onEnter: (href: string) => void }) {
  const civ = CIVS.find((x) => x.id === civOf(c.civilization))!;
  const pct = Math.round(Math.max(0, Math.min(1, c.progress)) * 100);
  return (
    <section className="w3d-sheet w3d-district" data-world-ui="" data-world-scroll="" aria-label={`${c.name}: ${civ.name}`} style={{ ['--plate' as string]: color }}>
      <header>
        <span className="w3d-plate-mark">
          <Emblem kind={civ.id} />
        </span>
        <span>
          <b>{c.name}</b>
          <small>
            {civ.name} · {civ.hall}
          </small>
        </span>
        <button type="button" onClick={onClose} aria-label="Закрыть карточку подразделения">
          ×
        </button>
      </header>
      <p className="w3d-level">
        Уровень {c.level} · {c.levelName}
      </p>
      <div className="w3d-xp" role="img" aria-label={c.nextLevelXp ? `${c.xp} XP из ${c.nextLevelXp} до уровня «${c.nextLevelName}»` : `${c.xp} XP, высший уровень`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="w3d-xp-text">{c.nextLevelXp ? `${c.xp} / ${c.nextLevelXp} XP до уровня «${c.nextLevelName}»` : `${c.xp} XP — высший уровень`}</p>
      <dl className="w3d-facts">
        <div>
          <dt>Внедрено</dt>
          <dd>{c.towers}</dd>
        </div>
        <div>
          <dt>В работе</dt>
          <dd>{c.envoys}</dd>
        </div>
        <div>
          <dt>Ждут ответа</dt>
          <dd>{c.waiting}</dd>
        </div>
        <div>
          <dt>Сотрудников</dt>
          <dd>{c.headcount ?? 'нет данных'}</dd>
        </div>
      </dl>
      <div className="w3d-actions">
        <button type="button" className="w3d-cta" onClick={() => onEnter(`#/castles/${c.id}`)}>
          Войти в цитадель
        </button>
        <button type="button" className="w3d-ghost" onClick={() => onEnter(`#/castles/${c.id}/council`)}>
          {civ.hall}
        </button>
      </div>
      {envoys.length ? (
        <>
          <h3>Обращения подразделения</h3>
          <ul className="w3d-items">
            {envoys.slice(0, 5).map((e) => (
              <li key={e.number} data-late={e.overdueFirstResponse || e.overdueResolution ? 'yes' : 'no'}>
                <a href={`#/items/${e.number}`}>
                  <b>№{e.number}</b> {e.title}
                  <small>{envoyState(e).label}</small>
                </a>
              </li>
            ))}
          </ul>
          {envoys.length > 5 ? <p className="w3d-more">и ещё {envoys.length - 5} — в цитадели</p> : null}
        </>
      ) : (
        <p className="w3d-more">Открытых обращений нет.</p>
      )}
      <p className="w3d-note">Замок растёт только после подтверждённого внедрения. Уровень считает сервер.</p>
    </section>
  );
}

/** The game HUD: sections of the product, search across departments, colleagues and items, the person. */
function Hud({ k, onMode, onPick, onItem, onPerson }: { k: KingdomData; onMode: (m: Mode) => void; onPick: (id: string) => void; onItem: (n: number) => void; onPerson: (p: PersonHit) => void }) {
  const s = useSession();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ListItem[]>([]);
  const [people, setPeople] = useState<PersonHit[]>([]);
  const [busy, setBusy] = useState(false);
  const term = q.trim().toLowerCase();
  const depts = term.length >= 1 ? k.castles.filter((c) => c.name.toLowerCase().includes(term) || CIVS.find((x) => x.id === civOf(c.civilization))!.name.toLowerCase().includes(term)) : [];
  useEffect(() => {
    if (term.length < 2) {
      setItems([]);
      setPeople([]);
      return;
    }
    let live = true;
    setBusy(true);
    const t = window.setTimeout(() => {
      const num = /^№?\s*(\d+)$/.exec(term);
      Promise.all([
        num ? Promise.resolve([] as ListItem[]) : api<ListItem[]>(`/orgs/${s.org}/ideas?q=${encodeURIComponent(term)}&limit=6`).catch(() => [] as ListItem[]),
        api<PersonHit[]>(`/orgs/${s.org}/people?q=${encodeURIComponent(term)}`).catch(() => [] as PersonHit[]),
      ]).then(([i, p]) => {
        if (!live) return;
        setItems(i);
        setPeople(p);
        setBusy(false);
      });
    }, 220);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [term, s.org]);
  // An id of the organizer's set (A-007) leads to the item it became.
  const setId = /^[a-zа-я]{1,3}-\d{1,6}$/i.test(term) ? term.toUpperCase() : null;
  const [setHit, setSetHit] = useState<{ externalId: string; number: number; title: string } | null>(null);
  useEffect(() => {
    setSetHit(null);
    if (!setId) return;
    let live = true;
    api<{ externalId: string; number: number; title: string }[]>(`/orgs/${s.org}/datasets/official-synthetic`)
      .then((rows) => live && setSetHit(rows.find((r) => r.externalId === setId) ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [setId, s.org]);
  const byNumber = /^№?\s*(\d+)$/.exec(term);
  const envoyHit = byNumber ? k.envoys.find((e) => e.number === Number(byNumber[1])) : undefined;
  const nothing = term.length >= 2 && !busy && !depts.length && !items.length && !people.length && !byNumber && !setHit;
  const nav = [
    { href: '#/kingdom', label: 'Город', on: true },
    { href: '#/', label: 'Обращения', on: false },
    { href: '#/council', label: 'Советы', on: false },
    { href: '#/library', label: 'Библиотека', on: false },
    ...(s.isLead || s.isAdmin ? [{ href: '#/overview', label: 'Аналитика', on: false }] : [{ href: '#/rating', label: 'Рейтинг', on: false }]),
  ];
  return (
    <header className="w3d-top" data-world-ui="">
      <a className="w3d-brand" href="#/kingdom">
        <img src="/icon.svg" alt="" />
        <span>
          MODUS FLOW
          <small>{s.realmName}</small>
        </span>
      </a>
      <nav aria-label="Разделы">
        {nav.map((n) => (
          <a key={n.href} href={n.href} aria-current={n.on ? 'page' : undefined}>
            {n.label}
          </a>
        ))}
      </nav>
      <div className="w3d-search" data-world-scroll="">
        <input
          type="search"
          value={q}
          placeholder="Подразделение, коллега или обращение"
          aria-label="Поиск по городу: подразделения, коллеги, обращения"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setQ('');
            }
          }}
        />
        {open && term.length >= 1 ? (
          <div className="w3d-results" role="listbox" aria-label="Результаты поиска">
            {depts.map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  setOpen(false);
                  onPick(c.id);
                }}
              >
                <small>Подразделение</small>
                {c.name}
              </button>
            ))}
            {byNumber ? (
              <button type="button" role="option" aria-selected="false" onClick={() => onItem(Number(byNumber[1]))}>
                <small>Обращение</small>№{byNumber[1]}
                {envoyHit ? ` — ${envoyHit.title}` : ''}
              </button>
            ) : null}
            {setHit ? (
              <button type="button" role="option" aria-selected="false" onClick={() => onItem(setHit.number)}>
                <small>Набор организатора · {setHit.externalId}</small>№{setHit.number} — {setHit.title}
              </button>
            ) : null}
            {people.map((p) => (
              <button key={p.id} type="button" role="option" aria-selected="false" onClick={() => onPerson(p)}>
                <small>{p.department ?? 'Без подразделения'}</small>
                {p.name}
              </button>
            ))}
            {items.map((i) => (
              <button key={i.number} type="button" role="option" aria-selected="false" onClick={() => onItem(i.number)}>
                <small>Обращение №{i.number}</small>
                {i.title}
              </button>
            ))}
            {busy && term.length >= 2 ? <p>Ищем…</p> : null}
            {nothing ? <p>Ничего не нашлось. Попробуйте название отдела, фамилию или номер обращения.</p> : null}
            {term.length === 1 && !depts.length ? <p>Введите ещё один символ.</p> : null}
          </div>
        ) : null}
      </div>
      <div className="w3d-modes" role="group" aria-label="Вид города">
        <button type="button" aria-pressed="true">
          3D
        </button>
        <button type="button" aria-pressed="false" onClick={() => onMode('city')}>
          Схема
        </button>
        <button type="button" aria-pressed="false" onClick={() => onMode('work')}>
          Таблица
        </button>
      </div>
      <a className="w3d-bell" href="#/inbox" aria-label={s.unread ? `Уведомления: ${s.unread} непрочитанных` : 'Уведомления'}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15zM10 20h4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {s.unread ? <i>{s.unread > 99 ? '99+' : s.unread}</i> : null}
      </a>
      <a className="w3d-user" href="#/me">
        <b>{s.me.displayName}</b>
      </a>
    </header>
  );
}
