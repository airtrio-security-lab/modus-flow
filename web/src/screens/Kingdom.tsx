import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import type { Castle, Envoy, Kingdom as KingdomData } from '../lib/types';
import { ErrorBox, Loading, PageHead, StatusChip } from '../components/ui';

/**
 * «Королевство» — the same items as a living map (owner decision 2026-11-11).
 * Every department is a castle. A castle gets a tower only for an implemented
 * item, so sending many envoys does not grow it. Open items are envoys on the
 * road to the council; where an envoy stands is its real status. Castles
 * belong to departments, never to people. The list under the map carries the
 * same facts for screen readers and small screens.
 */

const HERALDRY = ['#a2412f', '#2f4f7a', '#a87818', '#4d7448', '#73466a', '#2b6f6a', '#8a5a2b', '#55606e'];
const GOLD = '#b8860b';
const INK = '#3d3022';
const INK_SOFT = '#6b5a43';
const RED = '#b3261e';
const POLL_MS = 15000;

type Pt = { x: number; y: number };
/** `s` scales every drawn mark so that castles and envoys stay legible on the screen's real size. */
type Layout = { w: number; h: number; capital: Pt; rx: number; ry: number; camp: Pt; s: number; start: number };
const WIDE: Layout = { w: 1000, h: 760, capital: { x: 500, y: 400 }, rx: 390, ry: 270, camp: { x: 40, y: 80 }, s: 1.2, start: -72 };
const TALL: Layout = { w: 480, h: 1000, capital: { x: 240, y: 500 }, rx: 150, ry: 360, camp: { x: 30, y: 56 }, s: 1, start: NaN };

/** Where an envoy stands on its road (0 = home castle, 1 = council gates) and what it means. */
export function envoyState(e: Envoy): { t: number; label: string; home?: boolean } {
  if (e.status === 'in_progress') return { t: 0.16, label: 'вернулся с решением — строят', home: true };
  if (e.status === 'needs_info') return { t: 0.35, label: 'вернулся за уточнением к автору', home: true };
  if (e.overdueFirstResponse) return { t: 0.9, label: 'ждёт у ворот: срок первого ответа прошёл' };
  if (e.status === 'unrouted') return { t: 0.2, label: 'ищет, кому вручить послание' };
  if (e.status === 'in_verification') return { t: 0.7, label: 'проходит испытание на практике' };
  if (e.status === 'decision') return { t: 0.97, label: 'у трона: совет принимает решение' };
  if (e.responded) return { t: 0.82, label: 'на приёме у совета' };
  return { t: 0.55, label: 'в пути к совету' };
}

const towersWord = (n: number) => `${n} ${plural(n, 'башня', 'башни', 'башен')}`;
const envoysWord = (n: number) => `${n} ${plural(n, 'посол', 'посла', 'послов')}`;

function bezier(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

interface Road {
  from: Pt;
  ctrl: Pt;
  to: Pt;
  normal: Pt;
}

function placeCastles(castles: Castle[], L: Layout) {
  const n = castles.length;
  return castles.map((c, i) => {
    // Portrait: no castle sits level with the council, which would crowd it.
    const start = Number.isNaN(L.start) ? -90 + 180 / Math.max(n, 1) : L.start;
    const a = ((start + (360 * i) / Math.max(n, 1)) * Math.PI) / 180;
    const pos = { x: L.capital.x + L.rx * Math.cos(a), y: L.capital.y + L.ry * Math.sin(a) };
    const dx = L.capital.x - pos.x;
    const dy = L.capital.y - pos.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const normal = { x: -uy, y: ux };
    const from = { x: pos.x + ux * 62 * L.s, y: pos.y + uy * 62 * L.s };
    const to = { x: L.capital.x - ux * 100 * L.s, y: L.capital.y - uy * 50 * L.s };
    const bend = (i % 2 ? 1 : -1) * len * 0.16;
    const ctrl = { x: (from.x + to.x) / 2 + normal.x * bend, y: (from.y + to.y) / 2 + normal.y * bend };
    return { castle: c, pos, road: { from, ctrl, to, normal } as Road, color: HERALDRY[i % HERALDRY.length]! };
  });
}

export function Kingdom() {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<KingdomData>(`/orgs/${s.org}/kingdom`), [s.org]);
  const [selected, setSelected] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState<{ id: string; text: string } | null>(null);
  const seen = useRef<Map<string, number> | null>(null);

  // Live: refresh while the page is visible; a new tower is celebrated and announced.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload]);

  useEffect(() => {
    if (!data) return;
    const prev = seen.current;
    const next = new Map(data.castles.map((c) => [c.id, c.towers]));
    if (prev) {
      const grown = data.castles.find((c) => c.towers > (prev.get(c.id) ?? c.towers));
      if (grown) {
        setCelebrate({ id: grown.id, text: `${grown.name}: построена новая башня — идея реализована` });
        const t = window.setTimeout(() => setCelebrate(null), 6000);
        seen.current = next;
        return () => window.clearTimeout(t);
      }
    }
    seen.current = next;
  }, [data]);

  return (
    <div className="stack-lg">
      <PageHead
        title="Королевство"
        sub="Каждое подразделение — замок. Башня появляется, только когда идея реализована. Открытые обращения — послы на пути к совету."
      />
      <p className="sr-only" aria-live="polite">
        {celebrate?.text ?? ''}
      </p>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading label="Рисуем карту…" rows={3} /> : null}
      {data ? <Realm k={data} selected={selected} onSelect={setSelected} celebrate={celebrate} /> : null}
    </div>
  );
}

function useWide() {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWide((e?.contentRect.width ?? 1000) >= 620));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, wide };
}

function Realm({
  k,
  selected,
  onSelect,
  celebrate,
}: {
  k: KingdomData;
  selected: string | null;
  onSelect: (id: string | null) => void;
  celebrate: { id: string; text: string } | null;
}) {
  const { ref, wide } = useWide();
  const L = wide ? WIDE : TALL;
  const placed = useMemo(() => placeCastles(k.castles, L), [k.castles, L]);
  const byId = new Map(placed.map((p) => [p.castle.id, p]));
  const mine = k.envoys.filter((e) => e.mine);
  const current = selected ? byId.get(selected) : undefined;

  // Envoys that share a spot step aside along the road's normal.
  const crowd = new Map<string, number>();
  const figures = k.envoys.map((e) => {
    const st = envoyState(e);
    const home = e.departmentId ? byId.get(e.departmentId) : undefined;
    let p: Pt;
    let color = '#7a6a52';
    if (home) {
      const key = `${home.castle.id}:${st.t}`;
      const k2 = crowd.get(key) ?? 0;
      crowd.set(key, k2 + 1);
      const base = bezier(home.road.from, home.road.ctrl, home.road.to, st.t);
      const side = k2 === 0 ? 0 : (k2 % 2 ? 1 : -1) * Math.ceil(k2 / 2) * 17 * L.s;
      p = { x: base.x + home.road.normal.x * side, y: base.y + home.road.normal.y * side };
      color = home.color;
    } else {
      const k2 = crowd.get('camp') ?? 0;
      crowd.set('camp', k2 + 1);
      p = { x: L.camp.x + (44 + (k2 % 4) * 18) * L.s, y: L.camp.y + Math.floor(k2 / 4) * 24 * L.s };
    }
    return { e, st, p, color };
  });

  return (
    <>
      {mine.length ? (
        <section className="realm-mine" aria-label="Ваши послы">
          <span className="realm-mine-title">Ваши послы</span>
          {mine.map((e) => (
            <a key={e.number} className="realm-mine-chip" href={`#/items/${e.number}`}>
              <b>№{e.number}</b> {envoyState(e).label}
            </a>
          ))}
        </section>
      ) : null}

      <div className="realm" ref={ref}>
        <div className="realm-map">
          <svg viewBox={`0 0 ${L.w} ${L.h}`} role="img" aria-label={`Карта королевства: ${k.castles.length} замков, ${envoysWord(k.envoys.length)} в пути`}>
            <MapGround L={L} wide={wide} />
            {placed.map((p) => (
              <path
                key={`road-${p.castle.id}`}
                d={`M${p.road.from.x},${p.road.from.y} Q${p.road.ctrl.x},${p.road.ctrl.y} ${p.road.to.x},${p.road.to.y}`}
                className="realm-road"
              />
            ))}
            <Capital at={L.capital} s={wide ? L.s : 0.85} />
            {k.wildlands ? <Camp at={L.camp} count={k.wildlands} s={L.s} /> : null}
            {placed
              .slice()
              .sort((a, b) => a.pos.y - b.pos.y)
              .map((p) => (
                <CastleMark
                  key={p.castle.id}
                  c={p.castle}
                  at={p.pos}
                  s={L.s}
                  color={p.color}
                  selected={selected === p.castle.id}
                  celebrate={celebrate?.id === p.castle.id}
                  onSelect={() => onSelect(selected === p.castle.id ? null : p.castle.id)}
                />
              ))}
            {figures
              .slice()
              .sort((a, b) => a.p.y - b.p.y)
              .map(({ e, st, p, color }) => (
                <EnvoyMark key={e.number} e={e} at={p} s={L.s} color={color} label={st.label} home={!!st.home} />
              ))}
          </svg>
        </div>

        <aside className="realm-side panel" aria-live="polite">
          {current ? (
            <CastleDetails c={current.castle} color={current.color} envoys={k.envoys.filter((e) => e.departmentId === current.castle.id)} />
          ) : (
            <div className="stack">
              <h2 className="realm-h">Как читать карту</h2>
              <Legend />
              <p className="muted small">Нажмите на замок, чтобы увидеть его послов. Карта обновляется сама.</p>
            </div>
          )}
        </aside>
      </div>

      <section className="panel stack" aria-labelledby="realm-list">
        <h2 id="realm-list" className="section-title">
          Замки подразделений
        </h2>
        <ul className="realm-list">
          {placed.map((p) => (
            <li key={p.castle.id}>
              <button type="button" aria-pressed={selected === p.castle.id} onClick={() => onSelect(selected === p.castle.id ? null : p.castle.id)}>
                <span className="realm-swatch" style={{ background: p.color }} aria-hidden="true" />
                <span className="realm-list-name">{p.castle.name}</span>
                <span className="muted small">
                  {towersWord(p.castle.towers)}
                  {p.castle.building ? `, строится ${p.castle.building}` : ''}, {envoysWord(p.castle.envoys)} в пути
                  {p.castle.waiting ? `, ${p.castle.waiting} ждут у ворот` : ''}
                </span>
              </button>
            </li>
          ))}
          {k.wildlands ? (
            <li>
              <span className="realm-list-static">
                <span className="realm-swatch" style={{ background: '#7a6a52' }} aria-hidden="true" />
                <span className="realm-list-name">Вольные земли</span>
                <span className="muted small">{envoysWord(k.wildlands)} без подразделения</span>
              </span>
            </li>
          ) : null}
        </ul>
      </section>
    </>
  );
}

function CastleDetails({ c, color, envoys }: { c: Castle; color: string; envoys: Envoy[] }) {
  return (
    <div className="stack">
      <h2 className="realm-h">
        <span className="realm-swatch" style={{ background: color }} aria-hidden="true" /> {c.name}
      </h2>
      <dl className="realm-facts">
        <div>
          <dt>Башни</dt>
          <dd>{c.towers}</dd>
        </div>
        <div>
          <dt>Строится</dt>
          <dd>{c.building}</dd>
        </div>
        <div>
          <dt>Послов в пути</dt>
          <dd>{c.envoys}</dd>
        </div>
        <div>
          <dt>Вернулись с отказом</dt>
          <dd>{c.returned}</dd>
        </div>
      </dl>
      <p className="muted small">Одна башня — одна реализованная идея подразделения.</p>
      {envoys.length ? (
        <ul className="realm-envoys">
          {envoys.map((e) => (
            <li key={e.number}>
              <a href={`#/items/${e.number}`}>
                <span className="num">№{e.number}</span> {e.title}
              </a>
              <span className="row">
                <StatusChip status={e.status} />
                {e.overdueFirstResponse ? <span className="flag red">ждёт у ворот</span> : null}
                {e.stale ? <span className="flag">нет движения</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Сейчас послов в пути нет.</p>
      )}
    </div>
  );
}

function Legend() {
  const rows: { t: string; fig: JSX.Element }[] = [
    { t: 'Посол в пути к совету', fig: <EnvoyBody color={HERALDRY[1]!} /> },
    { t: 'Ждёт у ворот: срок ответа прошёл', fig: <EnvoyBody color={HERALDRY[1]!} pennant={RED} /> },
    { t: 'Ваш посол', fig: <EnvoyBody color={HERALDRY[1]!} mine /> },
    { t: 'Нет движения', fig: <EnvoyBody color={HERALDRY[1]!} stale /> },
  ];
  return (
    <ul className="realm-legend">
      {rows.map((r) => (
        <li key={r.t}>
          <svg viewBox="-14 -32 28 36" width="22" height="28" aria-hidden="true">
            {r.fig}
          </svg>
          {r.t}
        </li>
      ))}
      <li>
        <svg viewBox="-14 -24 28 28" width="22" height="22" aria-hidden="true">
          <rect x="-5" y="-16" width="10" height="16" fill="#e6dcc6" stroke={INK} strokeWidth="1.5" />
          <path d="M-8,-16 L0,-26 L8,-16 Z" fill={HERALDRY[0]} stroke={INK} strokeWidth="1.5" />
        </svg>
        Башня — реализованная идея
      </li>
      <li>
        <svg viewBox="-14 -24 28 28" width="22" height="22" aria-hidden="true">
          <Scaffold />
        </svg>
        Леса — решение принято, идёт внедрение
      </li>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function MapGround({ L, wide }: { L: Layout; wide: boolean }) {
  const trees = (wide
    ? [
        [0.36, 0.12], [0.39, 0.15], [0.33, 0.16], [0.7, 0.86], [0.73, 0.83], [0.76, 0.87], [0.06, 0.55], [0.09, 0.6], [0.94, 0.15], [0.91, 0.12], [0.5, 0.92], [0.53, 0.9],
      ]
    : [
        [0.12, 0.3], [0.16, 0.33], [0.84, 0.66], [0.88, 0.7], [0.5, 0.06], [0.54, 0.08], [0.14, 0.92], [0.18, 0.95], [0.86, 0.94],
      ]
  ).map(([x, y]) => ({ x: x! * L.w, y: y! * L.h }));
  const river = wide
    ? `M${L.w * 0.97},0 C${L.w * 0.86},${L.h * 0.25} ${L.w * 0.99},${L.h * 0.45} ${L.w * 0.9},${L.h * 0.62} S${L.w * 0.8},${L.h * 0.9} ${L.w * 0.86},${L.h}`
    : `M${L.w},${L.h * 0.18} C${L.w * 0.8},${L.h * 0.22} ${L.w * 0.95},${L.h * 0.34} ${L.w * 0.78},${L.h * 0.4}`;
  return (
    <g aria-hidden="true">
      <defs>
        <radialGradient id="realm-vignette" cx="50%" cy="50%" r="70%">
          <stop offset="60%" stopColor="#efe3c6" stopOpacity="0" />
          <stop offset="100%" stopColor="#b89a64" stopOpacity="0.45" />
        </radialGradient>
        <filter id="realm-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="7" />
          <feColorMatrix values="0 0 0 0 0.42  0 0 0 0 0.33  0 0 0 0 0.2  0 0 0 0.09 0" />
        </filter>
      </defs>
      <rect width={L.w} height={L.h} fill="#efe3c6" />
      <rect width={L.w} height={L.h} filter="url(#realm-grain)" />
      <path d={river} fill="none" stroke="#8fb0bd" strokeWidth="14" strokeLinecap="round" opacity="0.7" />
      <path d={river} fill="none" stroke="#c9dde2" strokeWidth="4" strokeLinecap="round" opacity="0.8" />
      {trees.map((t, i) => (
        <g key={i} transform={`translate(${t.x},${t.y})`}>
          <line x1="0" y1="0" x2="0" y2="6" stroke={INK_SOFT} strokeWidth="1.5" />
          <circle r="8" fill="#8aa56c" stroke="#566e44" strokeWidth="1.2" />
        </g>
      ))}
      <Compass at={wide ? { x: L.w - 70, y: L.h - 70 } : { x: L.w - 56, y: 60 }} />
      <rect width={L.w} height={L.h} fill="url(#realm-vignette)" />
      <rect x="8" y="8" width={L.w - 16} height={L.h - 16} fill="none" stroke={INK} strokeWidth="2" />
      <rect x="14" y="14" width={L.w - 28} height={L.h - 28} fill="none" stroke={INK} strokeWidth="0.8" />
    </g>
  );
}

function Compass({ at }: { at: Pt }) {
  return (
    <g transform={`translate(${at.x},${at.y})`} opacity="0.8">
      <circle r="22" fill="none" stroke={INK_SOFT} strokeWidth="1" />
      <path d="M0,-28 L5,0 L0,28 L-5,0 Z" fill={INK_SOFT} />
      <path d="M-28,0 L0,4 L28,0 L0,-4 Z" fill="#b8a27c" />
      <text y="-32" textAnchor="middle" className="realm-tiny">
        С
      </text>
    </g>
  );
}

function Capital({ at, s }: { at: Pt; s: number }) {
  return (
    <g transform={`translate(${at.x},${at.y}) scale(${s})`} aria-hidden="true">
      <ellipse cy="6" rx="96" ry="22" fill="#d2bf8f" stroke="#a8977a" strokeWidth="1.5" />
      {[-46, 46].map((x) => (
        <g key={x}>
          <rect x={x - 11} y={-62} width="22" height="62" fill="#ece3cf" stroke={INK} strokeWidth="1.5" />
          <path d={`M${x - 15},-62 L${x},-90 L${x + 15},-62 Z`} fill={GOLD} stroke={INK} strokeWidth="1.5" />
        </g>
      ))}
      <rect x="-60" y="-28" width="120" height="28" fill="#e6dcc6" stroke={INK} strokeWidth="1.5" />
      <rect x="-26" y="-84" width="52" height="84" fill="#ece3cf" stroke={INK} strokeWidth="1.5" />
      {[-26, -13, 0, 13].map((x) => (
        <rect key={x} x={x} y="-92" width="9" height="8" fill="#ece3cf" stroke={INK} strokeWidth="1.5" />
      ))}
      <path d="M-10,0 L-10,-16 A10,10 0 0 1 10,-16 L10,0 Z" fill="#6b5a43" />
      <line x1="0" y1="-92" x2="0" y2="-124" stroke={INK} strokeWidth="1.5" />
      <path className="realm-flag" d="M0,-124 L30,-117 L0,-110 Z" fill={GOLD} stroke={INK} strokeWidth="1" />
      <text y="40" textAnchor="middle" className="realm-label realm-label-lg">
        Совет
      </text>
      <text y="58" textAnchor="middle" className="realm-sub">
        здесь решают
      </text>
    </g>
  );
}

function Camp({ at, count, s }: { at: Pt; count: number; s: number }) {
  return (
    <g transform={`translate(${at.x},${at.y}) scale(${s})`} aria-hidden="true">
      {[0, 22].map((x) => (
        <path key={x} d={`M${x - 12},0 L${x},-20 L${x + 12},0 Z`} fill="#d9c49a" stroke={INK} strokeWidth="1.3" />
      ))}
      <text x="-12" y="22" className="realm-label">
        Вольные земли
      </text>
      <text x="-12" y="38" className="realm-sub">
        {count} без подразделения
      </text>
    </g>
  );
}

const SLOTS = [
  { x: -36, h: 40, back: false },
  { x: 36, h: 40, back: false },
  { x: -20, h: 66, back: true },
  { x: 20, h: 66, back: true },
  { x: -56, h: 30, back: false },
  { x: 56, h: 30, back: false },
  { x: -72, h: 22, back: false },
  { x: 72, h: 22, back: false },
];

function Tower({ x, h, color, fresh }: { x: number; h: number; color: string; fresh: boolean }) {
  return (
    <g className={fresh ? 'realm-rise' : undefined}>
      <rect x={x - 8} y={-h} width="16" height={h} fill="#e9dfca" stroke={INK} strokeWidth="1.5" />
      <rect x={x - 2} y={-h + 10} width="4" height="7" fill={INK_SOFT} />
      <path d={`M${x - 11},${-h} L${x},${-h - 20} L${x + 11},${-h} Z`} fill={color} stroke={INK} strokeWidth="1.5" />
    </g>
  );
}

function Scaffold({ x = 0 }: { x?: number }) {
  return (
    <g stroke="#8a6a3d" strokeWidth="1.6" fill="none">
      <line x1={x - 8} y1="0" x2={x - 8} y2="-22" />
      <line x1={x + 8} y1="0" x2={x + 8} y2="-22" />
      <line x1={x - 10} y1="-7" x2={x + 10} y2="-7" />
      <line x1={x - 10} y1="-15" x2={x + 10} y2="-15" />
      <line x1={x - 8} y1="0" x2={x + 8} y2="-15" />
    </g>
  );
}

function CastleMark({
  c,
  at,
  s,
  color,
  selected,
  celebrate,
  onSelect,
}: {
  c: Castle;
  at: Pt;
  s: number;
  color: string;
  selected: boolean;
  celebrate: boolean;
  onSelect: () => void;
}) {
  const shown = Math.min(c.towers, SLOTS.length);
  const slots = SLOTS.slice(0, shown).map((s, i) => ({ ...s, i }));
  const reach = shown ? Math.max(...slots.map((s) => Math.abs(s.x))) + 8 : 0;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };
  const name = `${c.name}: ${towersWord(c.towers)}, ${envoysWord(c.envoys)} в пути${c.building ? `, строится ${c.building}` : ''}`;
  return (
    <g
      transform={`translate(${at.x},${at.y}) scale(${s})`}
      className={`realm-castle${selected ? ' is-selected' : ''}${celebrate ? ' is-celebrating' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={name}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={onKey}
    >
      <title>{name}</title>
      <ellipse cy="5" rx={Math.max(48, reach + 18)} ry="15" fill="#d6c497" stroke="#a8977a" strokeWidth="1.2" />
      {selected ? <ellipse cy="5" rx={Math.max(58, reach + 28)} ry="24" fill="none" stroke={INK} strokeWidth="1.5" strokeDasharray="5 4" /> : null}
      {slots.filter((s) => s.back).map((s) => <Tower key={s.i} x={s.x} h={s.h} color={color} fresh={celebrate && s.i === shown - 1} />)}
      {shown ? <rect x={-reach} y="-16" width={reach * 2} height="16" fill="#e2d7bf" stroke={INK} strokeWidth="1.5" /> : null}
      <rect x="-15" y="-50" width="30" height="50" fill="#ece3cf" stroke={INK} strokeWidth="1.5" />
      {[-15, -6, 3, 12].map((x) => (
        <rect key={x} x={x} y="-56" width="6" height="6" fill="#ece3cf" stroke={INK} strokeWidth="1.2" />
      ))}
      <path d="M-6,0 L-6,-10 A6,6 0 0 1 6,-10 L6,0 Z" fill={INK_SOFT} />
      <line x1="0" y1="-56" x2="0" y2="-82" stroke={INK} strokeWidth="1.5" />
      <path className="realm-flag" d="M0,-82 L24,-76 L0,-70 Z" fill={color} stroke={INK} strokeWidth="1" />
      {slots.filter((s) => !s.back).map((s) => <Tower key={s.i} x={s.x} h={s.h} color={color} fresh={celebrate && s.i === shown - 1} />)}
      {c.towers > SLOTS.length ? (
        <text x={reach + 6} y="-30" className="realm-sub">
          +{c.towers - SLOTS.length}
        </text>
      ) : null}
      {c.building ? <Scaffold x={reach + 22} /> : null}
      {celebrate ? (
        <g className="realm-sparks" aria-hidden="true">
          {[-30, 0, 30].map((x, i) => (
            <circle key={x} cx={x} cy={-100 + (i % 2) * 10} r="3" fill={GOLD} />
          ))}
        </g>
      ) : null}
      <text y="32" textAnchor="middle" className="realm-label">
        {c.name}
      </text>
      <text y="48" textAnchor="middle" className="realm-sub">
        {towersWord(c.towers)}
      </text>
    </g>
  );
}

function EnvoyBody({ color, pennant, mine, stale }: { color: string; pennant?: string; mine?: boolean; stale?: boolean }) {
  return (
    <g>
      {mine ? <circle cy="-12" r="14" fill="#f3e2a6" fillOpacity="0.7" stroke={GOLD} strokeWidth="2" /> : null}
      <ellipse cy="1" rx="7" ry="2" fill="#5a4a33" opacity="0.25" />
      <path d="M-6,0 L0,-15 L6,0 Z" fill={color} stroke={INK} strokeWidth="1" />
      <circle cy="-18" r="4" fill="#f2dfc2" stroke={INK} strokeWidth="1" />
      <line x1="7" y1="1" x2="7" y2="-25" stroke={INK} strokeWidth="1.3" />
      <path d="M7,-25 L17,-22 L7,-19 Z" fill={pennant ?? color} stroke={INK} strokeWidth="0.8" />
      {stale ? (
        <text x="-14" y="-24" className="realm-tiny">
          z
        </text>
      ) : null}
    </g>
  );
}

function EnvoyMark({ e, at, s, color, label, home }: { e: Envoy; at: Pt; s: number; color: string; label: string; home: boolean }) {
  const text = `№${e.number} «${e.title}»: ${label}${e.mine ? ' (ваш посол)' : ''}`;
  return (
    <g className="realm-envoy" style={{ transform: `translate(${at.x}px, ${at.y}px) scale(${s})` }}>
      <a href={`#/items/${e.number}`} aria-label={text}>
        <title>{text}</title>
        <g className="realm-walk" transform={home ? 'scale(-1,1)' : undefined}>
          <EnvoyBody color={color} pennant={e.overdueFirstResponse || e.overdueResolution ? RED : undefined} mine={e.mine} stale={e.stale} />
        </g>
        {e.mine ? (
          <text y="-32" textAnchor="middle" className="realm-tag">
            №{e.number}
          </text>
        ) : null}
      </a>
    </g>
  );
}
