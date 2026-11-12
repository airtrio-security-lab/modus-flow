import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { LiteToggle, useLite } from '../lib/lite';
import { useTitles } from '../components/Titles';
import { useLoad, useSession } from '../lib/session';
import type { Castle, CastleDetail, Envoy, Kingdom as KingdomData } from '../lib/types';
import { ErrorBox, Loading, PageHead, StatusChip } from '../components/ui';
import { HowItWorks } from '../components/HowItWorks';
import { IsoCastle, IsoCouncil, IsoLibrary, P, Scaffold, Tree } from '../components/iso';
import { CIV_HEIGHT, CivCastle, CouncilHall, DistrictHouses, IsoArchive, IsoPlaza, civName, civOf, hallName } from '../components/civ';
import { useCamera } from '../lib/camera';

// three.js is loaded only when the 3D city is opened.
const City3D = lazy(() => import('./City3D').then((m) => ({ default: m.City3D })));

/**
 * «Королевство» — the same items as a living strategy map (owner decisions
 * 2026-11-11, ADR-0011, ADR-0012). Each department is an isometric castle whose
 * level (1 Поселение … 5 Легендарная крепость) comes from XP that the database
 * awards only for confirmed events. Open items are envoys on the road to the
 * council, standing where the item really is. Nothing here changes data, and
 * nothing grows at random: a castle is rebuilt only after the backend says so.
 */

export const HERALDRY = ['#a2412f', '#2f4f7a', '#9a6d12', '#4d7448', '#73466a', '#2b6f6a', '#8a5a2b', '#55606e'];
const RED = '#b3261e';
const POLL_MS = 15000;

type Pt = { x: number; y: number };
/**
 * `u` is the size of one isometric grid unit; `font` keeps plate labels readable at the map's real size.
 * The centre of the city: the Council palace with the Round Table, the Great Library, the Higher
 * Archive and the achievements plaza; the districts of the departments stand around it.
 */
type Layout = { w: number; h: number; capital: Pt; rx: number; ry: number; camp: Pt; library: Pt; archive: Pt; plaza: Pt; s: number; u: number; font: number; start: number };
const WIDE: Layout = { w: 1400, h: 1100, capital: { x: 700, y: 540 }, rx: 545, ry: 320, camp: { x: 70, y: 40 }, library: { x: 440, y: 650 }, archive: { x: 960, y: 650 }, plaza: { x: 700, y: 795 }, s: 1.7, u: 15, font: 24, start: -72 };
const TALL: Layout = { w: 480, h: 1500, capital: { x: 240, y: 660 }, rx: 150, ry: 390, camp: { x: 70, y: 30 }, library: { x: 120, y: 1250 }, archive: { x: 360, y: 1250 }, plaza: { x: 240, y: 1350 }, s: 1.05, u: 7, font: 18, start: NaN };
/** Phones: two columns around the council instead of a tight ring, so labels never collide (up to 8 castles). */
const TALL_SLOTS: Pt[] = [
  { x: 120, y: 270 }, { x: 360, y: 270 }, { x: 120, y: 470 }, { x: 360, y: 470 },
  { x: 120, y: 880 }, { x: 360, y: 880 }, { x: 120, y: 1080 }, { x: 360, y: 1080 },
];
const reducedMotion = () => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
};

/** Where an envoy stands on its road (0 = home castle, 1 = council gates) and what it means. */
export function envoyState(e: Envoy): { t: number; label: string; home?: boolean } {
  if (e.status === 'in_progress') return { t: 0.16, label: 'вернулся с решением — идёт внедрение', home: true };
  if (e.status === 'needs_info') return { t: 0.35, label: 'вернулся за уточнением к автору', home: true };
  if (e.overdueFirstResponse) return { t: 0.9, label: 'ждёт у ворот: срок первого ответа прошёл' };
  if (e.status === 'unrouted') return { t: 0.2, label: 'ищет, кому вручить обращение' };
  if (e.status === 'in_verification') return { t: 0.7, label: 'на пилоте: проверка на практике' };
  if (e.status === 'decision') return { t: 0.97, label: 'у Совета: ждёт решения ответственного' };
  if (e.responded) return { t: 0.82, label: 'на рассмотрении в Совете' };
  return { t: 0.55, label: 'в пути к Совету' };
}

const envoysWord = (n: number) => `${n} ${plural(n, 'обращение', 'обращения', 'обращений')}`;
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

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
    const slot = L === TALL && n <= TALL_SLOTS.length ? TALL_SLOTS[i] : undefined;
    const pos = slot ?? { x: L.capital.x + L.rx * Math.cos(a), y: L.capital.y + L.ry * Math.sin(a) };
    const dx = L.capital.x - pos.x;
    const dy = L.capital.y - pos.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const normal = { x: -uy, y: ux };
    const from = { x: pos.x + ux * 60 * L.s, y: pos.y + uy * 48 * L.s };
    const to = { x: L.capital.x - ux * 95 * L.s, y: L.capital.y - uy * 52 * L.s };
    const bend = (i % 2 ? 1 : -1) * len * 0.14;
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
  const [enter] = useState(enterTarget);
  const [mode, setModeRaw] = useState<Mode>(initialMode);
  const [notice, setNotice] = useState<string | null>(null);
  const setMode = (m: Mode) => {
    setModeRaw(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };
  /** 3D could not start on this device: show the schematic city, keep the person's stored choice untouched. */
  const unavailable = useCallback((why: string) => {
    setNotice(why);
    setModeRaw('city');
  }, []);

  // Live: refresh while the page is visible.
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

  // Without the map there is nothing to fly over: go straight in.
  useEffect(() => {
    if (enter && mode === 'work') location.hash = enter;
  }, [enter, mode]);

  // A level-up is shown only when the backend reports a higher level than before.
  useEffect(() => {
    if (!data) return;
    const prev = seen.current;
    seen.current = new Map(data.castles.map((c) => [c.id, c.level]));
    if (!prev) return;
    const grown = data.castles.find((c) => c.level > (prev.get(c.id) ?? c.level));
    if (!grown) return;
    setCelebrate({ id: grown.id, text: `${grown.name}: новый уровень — ${grown.levelName}` });
    setSelected(grown.id);
    const t = window.setTimeout(() => setCelebrate(null), 7000);
    return () => window.clearTimeout(t);
  }, [data]);

  if (mode === '3d' && data && !enter)
    return (
      <Suspense fallback={<Loading label="Строим город…" rows={3} />}>
        <City3D k={data} onMode={setMode} onUnavailable={unavailable} />
        <div className="realm-toast-slot w3d-toast" aria-live="polite">
          {celebrate ? (
            <div className="realm-toast" role="status">
              <b>Улучшение замка.</b> {celebrate.text}
            </div>
          ) : null}
        </div>
      </Suspense>
    );
  const flat = mode === 'work' ? 'work' : 'city';
  return (
    <div className="stack-lg">
      <PageHead title={s.realmName} sub="Город подразделений: каждое выбрало свою цивилизацию. Замок растёт только после подтверждённого внедрения идеи.">
        <div className="segmented" role="group" aria-label="Вид">
          <button type="button" aria-pressed={false} onClick={() => setMode('3d')}>
            3D-город
          </button>
          <button type="button" aria-pressed={flat === 'city'} onClick={() => setMode('city')}>
            Схема
          </button>
          <button type="button" aria-pressed={flat === 'work'} onClick={() => setMode('work')}>
            Рабочее пространство
          </button>
        </div>
        {flat === 'city' ? <LiteToggle /> : null}
      </PageHead>
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {flat === 'city' ? <HowItWorks /> : null}
      <div className="realm-toast-slot" aria-live="polite">
        {celebrate ? (
          <div className="realm-toast" role="status">
            <b>Улучшение замка.</b> {celebrate.text}
          </div>
        ) : null}
      </div>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading label="Рисуем карту…" rows={3} /> : null}
      {data && flat === 'city' ? <Realm k={data} selected={selected} onSelect={setSelected} celebrate={celebrate} enterCouncil={enter} /> : null}
      {data && flat === 'work' ? <WorkView k={data} /> : null}
    </div>
  );
}

type Mode = '3d' | 'city' | 'work';
/**
 * The 3D city is the default where it can run; the schematic map is the default when the system asks
 * for reduced motion or the device looks weak, and the fallback when WebGL is missing. The person's
 * own choice is kept on the device.
 */
function initialMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === '3d' || v === 'city' || v === 'work') return v;
    // Before the 3D city existed the choice was «map or table» under another key. «Table» is still a
    // choice; «map» was simply the only map, so it must not hide the 3D city from that person.
    if (localStorage.getItem(LEGACY_MODE_KEY) === 'work') return 'work';
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'city';
    return localStorage.getItem('modus.lite') === '1' ? 'city' : '3d';
  } catch {
    return 'city';
  }
}
const MODE_KEY = 'modus.kingdom.view';
const LEGACY_MODE_KEY = 'modus.kingdom.mode';
/** Where «Войти в Совет» leads after the flight: only the council and meeting pages. */
function enterTarget(): string | null {
  const t = new URLSearchParams(location.hash.split('?')[1] ?? '').get('enter');
  return t && /^\/(council|meetings)(\/[0-9a-f-]{1,36})?$/.test(t) ? t : null;
}

/** «Рабочее пространство»: the same departments as a plain table, without the map or animations. */
function WorkView({ k }: { k: KingdomData }) {
  return (
    <section className="panel stack" aria-labelledby="work-h">
      <h2 id="work-h" className="section-title">
        Подразделения
      </h2>
      <div className="table-wrap">
        <table className="rating work-table">
          <thead>
            <tr>
              <th scope="col">Подразделение</th>
              <th scope="col">Уровень</th>
              <th scope="col">XP</th>
              <th scope="col">В работе</th>
              <th scope="col">Ждут ответа</th>
              <th scope="col">Внедряется</th>
              <th scope="col">Внедрено</th>
              <th scope="col">Стиль района</th>
            </tr>
          </thead>
          <tbody>
            {k.castles.map((c) => (
              <tr key={c.id}>
                <th scope="row">
                  <a href={`#/castles/${c.id}`}>{c.name}</a>
                </th>
                <td>
                  {c.level} · {c.levelName}
                </td>
                <td>{c.xp}</td>
                <td>{c.envoys}</td>
                <td>{c.waiting}</td>
                <td>{c.building}</td>
                <td>{c.towers}</td>
                <td>{civName(c.civilization)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {k.wildlands ? (
        <p className="muted small">
          Без подразделения: {envoysWord(k.wildlands)} ждут распределения — <a href="#/all">все обращения</a>.
        </p>
      ) : null}
    </section>
  );
}

function useWide() {
  const ref = useRef<HTMLDivElement>(null);
  // First guess from the window, so a phone starts with its own layout (and its saved camera).
  const [wide, setWide] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= 700));
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
  enterCouncil = null,
}: {
  k: KingdomData;
  selected: string | null;
  onSelect: (id: string | null) => void;
  celebrate: { id: string; text: string } | null;
  /** «Войти в Совет»: fly to the palace, then open this page. */
  enterCouncil?: string | null;
}) {
  const { ref, wide } = useWide();
  const [lite] = useLite();
  const realm = useSession().realmName;
  const L = wide ? WIDE : TALL;
  const cam = useCamera(L.w, L.h, { instant: lite || reducedMotion() });
  const { flyTo } = cam;
  const placed = useMemo(() => placeCastles(k.castles, L), [k.castles, L]);
  const mine = k.envoys.filter((e) => e.mine);
  const current = selected ? placed.find((p) => p.castle.id === selected) : undefined;
  const achievements = k.castles.reduce((n, c) => n + (c.achievements ?? 0), 0);
  const cu = L.u * (wide ? 1 : 0.9);
  const lu = L.u * (wide ? 0.9 : 0.75);

  /** Click on a building: the camera flies to it, then its screen opens. Ctrl/⌘-click opens it as a plain link. */
  const enter = useCallback(
    (href: string, at: Pt, zoom: number) => (e: { preventDefault: () => void; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; button?: number }) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || (e.button ?? 0) !== 0) return;
      e.preventDefault();
      void flyTo(at, zoom).then(() => {
        location.hash = href;
      });
    },
    [flyTo],
  );

  // The cinematic entry to a council: a small council flies to its hall, the Great Round Table to the palace;
  // a hand-over flies from the district's castle to the palace. «Пропустить» goes at once.
  const [entering, setEntering] = useState(!!enterCouncil);
  const cinema = useMemo(() => {
    const p = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const hall = placed.find((x) => x.castle.id === p.get('hall'));
    const from = placed.find((x) => x.castle.id === p.get('from'));
    if (hall) {
      const plate = [2.6, 3.2, 3.8, 4.4, 5][hall.castle.level - 1]!;
      const off = P(-plate - 2.6, 0.6, 0, L.u);
      return { to: { x: hall.pos.x + off.x, y: hall.pos.y + off.y }, start: null, text: `Входим: ${hallName(hall.castle.civilization)} — малый совет «${hall.castle.name}»…` };
    }
    if (from) return { to: L.capital, start: from.pos, text: `Вопрос «${from.castle.name}» передаётся к Большому Круглому столу…` };
    return { to: L.capital, start: null, text: 'Входим к Большому Круглому столу…' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, L]);
  useEffect(() => {
    if (!enterCouncil) return;
    let gone = false;
    const goIn = () => {
      if (gone) return;
      gone = true;
      location.hash = enterCouncil;
    };
    void (async () => {
      if (cinema.start) await flyTo(cinema.start, 2.6, 600);
      await flyTo(cinema.to, 3.2, 1100);
      window.setTimeout(goIn, lite ? 0 : 350);
    })();
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterCouncil]);

  // The scene does not depend on the camera: moving the camera only changes the viewBox.
  const scene = useMemo(() => {
    const byId = new Map(placed.map((p) => [p.castle.id, p]));
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
        p = { x: L.camp.x + (52 + (k2 % 4) * 18) * L.s, y: L.camp.y + 12 + Math.floor(k2 / 4) * 24 * L.s };
      }
      return { e, st, p, color };
    });
    // Painter's order: farther (higher on screen) first.
    const drawables = [
      ...placed.map((p) => ({
        y: p.pos.y,
        node: (
          <CastleMark
            key={`c-${p.castle.id}`}
            c={p.castle}
            at={p.pos}
            L={L}
            above={p.pos.y < L.capital.y}
            color={p.color}
            selected={selected === p.castle.id}
            celebrate={celebrate?.id === p.castle.id}
            onEnter={enter(`#/castles/${p.castle.id}`, p.pos, 2.6)}
          />
        ),
      })),
      ...placed.map((p) => {
        const plate = [2.6, 3.2, 3.8, 4.4, 5][p.castle.level - 1]!;
        const off = P(-plate - 2.6, 0.6, 0, L.u);
        const at = { x: p.pos.x + off.x, y: p.pos.y + off.y };
        return {
          y: at.y,
          node: <HallMark key={`h-${p.castle.id}`} c={p.castle} at={at} L={L} color={p.color} onEnter={enter(`#/castles/${p.castle.id}/council`, at, 3)} />,
        };
      }),
      ...figures.map((f) => ({ y: f.p.y, node: <EnvoyMark key={`e-${f.e.number}`} e={f.e} at={f.p} s={L.s} color={f.color} label={f.st.label} home={!!f.st.home} /> })),
    ].sort((a, b) => a.y - b.y);
    return (
      <>
        <MapGround L={L} wide={wide} lite={lite} realm={realm} />
        {placed.map((p) => (
          <g key={`road-${p.castle.id}`} aria-hidden="true">
            <path d={`M${p.road.from.x},${p.road.from.y} Q${p.road.ctrl.x},${p.road.ctrl.y} ${p.road.to.x},${p.road.to.y}`} className="realm-road-bed" />
            <path d={`M${p.road.from.x},${p.road.from.y} Q${p.road.ctrl.x},${p.road.ctrl.y} ${p.road.to.x},${p.road.to.y}`} className="realm-road" />
          </g>
        ))}
        <CityPaths L={L} />
        <a href="#/council" className="realm-place" aria-label="Дворец Большого Круглого стола — совет всего Содружества: обращения у Совета" onClick={enter('#/council', L.capital, 2.4)}>
          <g transform={`translate(${L.capital.x},${L.capital.y})`}>
            <IsoCouncil u={cu} />
            <LabelPlate y={4.9 * cu + 12} title="Большой Круглый стол" sub="совет всего Содружества" font={L.font} strong />
          </g>
        </a>
        {k.wildlands ? <Camp at={L.camp} count={k.wildlands} font={L.font} /> : null}
        <a href="#/library" className="realm-place realm-library-link" aria-label="Великая библиотека: Летопись, Библиотека решений и Высший Архив" onClick={enter('#/library', L.library, 2.6)}>
          <g transform={`translate(${L.library.x},${L.library.y})`}>
            <IsoLibrary u={lu} />
            <LabelPlate y={3.4 * lu + 8} title="Великая библиотека" sub="решения, итоги и уроки" font={L.font * 0.9} />
          </g>
        </a>
        <a href="#/library?hall=archive" className="realm-place" aria-label="Высший Архив: наследие, утверждённое Советом" onClick={enter('#/library?hall=archive', L.archive, 2.6)}>
          <g transform={`translate(${L.archive.x},${L.archive.y})`}>
            <IsoArchive u={lu} />
            <LabelPlate y={2.5 * lu + 10} title="Высший Архив" sub="наследие Содружества" font={L.font * 0.9} />
          </g>
        </a>
        <a href="#/rating" className="realm-place" aria-label={`Площадь достижений: ${achievements} ${plural(achievements, 'достижение', 'достижения', 'достижений')} замков; рейтинг подразделений`} onClick={enter('#/rating', L.plaza, 2.4)}>
          <g transform={`translate(${L.plaza.x},${L.plaza.y})`}>
            <IsoPlaza u={lu * 0.85} count={achievements} />
            <LabelPlate y={2.7 * lu + 4} title="Площадь достижений" sub={`${achievements} ${plural(achievements, 'достижение', 'достижения', 'достижений')} · рейтинг`} font={L.font * 0.85} />
          </g>
        </a>
        {lite ? null : <Residents placed={placed} L={L} />}
        {drawables.map((d) => d.node)}
      </>
    );
  }, [k, placed, L, wide, lite, selected, celebrate, enter, achievements, cu, lu]);

  const zoomed = cam.zoom > 1.01;
  return (
    <>
      {mine.length ? (
        <section className="realm-mine" aria-label="Мои обращения на карте">
          <span className="realm-mine-title">Мои обращения на карте</span>
          {mine.map((e) => (
            <a key={e.number} className="realm-mine-chip" href={`#/items/${e.number}`}>
              <b>Обращение №{e.number}</b> {envoyState(e).label}
            </a>
          ))}
        </section>
      ) : null}

      <div className={`realm${lite ? ' is-lite' : ''}`} ref={ref}>
        <div
          className={`realm-map${zoomed ? ' is-zoomed' : ''}${cam.zoom > 1.8 ? ' is-close' : ''}`}
          tabIndex={0}
          role="group"
          aria-label="Карта города. Стрелки — перемещение, плюс и минус — масштаб, ноль — весь город"
          onKeyDown={cam.onKey}
        >
          <svg
            {...cam.handlers}
            viewBox={`${cam.view.x} ${cam.view.y} ${cam.view.w} ${cam.view.h}`}
            style={{ touchAction: zoomed ? 'none' : 'pan-y' }}
            role="img"
            aria-label={`Город Содружества «${realm}»: ${k.castles.length} замков подразделений, ${envoysWord(k.envoys.length)} в работе`}
          >
            {scene}
          </svg>
          {entering && enterCouncil ? (
            <div className="realm-cinema" role="status">
              <span>{cinema.text}</span>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  setEntering(false);
                  location.hash = enterCouncil;
                }}
              >
                Пропустить
              </button>
            </div>
          ) : null}
          <div className="realm-cam" role="toolbar" aria-label="Камера">
            <button type="button" className="realm-cam-btn" onClick={() => cam.zoomAt(1.4)} aria-label="Приблизить" disabled={cam.zoom >= 3.49}>
              +
            </button>
            <button type="button" className="realm-cam-btn" onClick={() => cam.zoomAt(1 / 1.4)} aria-label="Отдалить" disabled={!zoomed}>
              −
            </button>
            <button type="button" className="realm-cam-btn wide" onClick={() => void flyTo(null)} disabled={!zoomed}>
              Весь город
            </button>
            <button type="button" className="realm-cam-btn wide" onClick={() => void flyTo(L.capital, 2.4)}>
              К Совету
            </button>
            <button type="button" className="realm-cam-btn wide" onClick={() => void flyTo(L.library, 2.6)}>
              К Библиотеке
            </button>
          </div>
        </div>

        <aside className="realm-side panel" aria-live="polite">
          {current ? (
            <CastleDetails c={current.castle} color={current.color} envoys={k.envoys.filter((e) => e.departmentId === current.castle.id)} />
          ) : (
            <div className="stack">
              <h2 className="realm-h">Как читать карту</h2>
              <Legend levels={k.levels.names} />
              <p className="muted small">Нажмите на замок, чтобы войти в район подразделения. В списке ниже — краткая сводка без перехода. Карта обновляется сама.</p>
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
                  Уровень {p.castle.level} · {p.castle.levelName} · {p.castle.xp} XP · {civName(p.castle.civilization)}
                </span>
                <span className="muted small">
                  Внедрено: {p.castle.towers}
                  {p.castle.building ? `, внедряется: ${p.castle.building}` : ''}, в работе: {p.castle.envoys}
                  {p.castle.waiting ? `, ждут ответа: ${p.castle.waiting}` : ''}
                </span>
              </button>
            </li>
          ))}
          {k.wildlands ? (
            <li>
              <span className="realm-list-static">
                <span className="realm-swatch" style={{ background: '#7a6a52' }} aria-hidden="true" />
                <span className="realm-list-name">Без подразделения</span>
                <span className="muted small">{envoysWord(k.wildlands)} ждут распределения</span>
              </span>
            </li>
          ) : null}
        </ul>
      </section>
    </>
  );
}

/**
 * Residents: one walking figure per five people of the department (by its recorded headcount), at
 * most four per district and 24 in the city; none in light graphics. They show size, nothing else.
 */
const MAX_RESIDENTS = 24;
function Residents({ placed, L }: { placed: { castle: Castle; pos: Pt; color: string }[]; L: Layout }) {
  let left = MAX_RESIDENTS;
  return (
    <g aria-hidden="true" className="realm-residents">
      {placed.flatMap((p) => {
        const n = Math.min(4, left, Math.max(1, Math.ceil((p.castle.headcount ?? 5) / 5)));
        left -= n;
        const plate = [2.6, 3.2, 3.8, 4.4, 5][p.castle.level - 1]!;
        return Array.from({ length: n }, (_, i) => {
          const side = i % 2 ? 1 : -1;
          const x = p.pos.x + side * (plate * 0.9 + 1.4 + i * 0.5) * L.u;
          const y = p.pos.y + (plate * 0.55 + 1 + (i % 3) * 0.6) * L.u;
          return (
            <g key={`${p.castle.id}-${i}`} transform={`translate(${x},${y}) scale(${L.s * 0.55})`}>
              <g className="realm-stroll" style={{ animationDelay: `${-i * 1.7}s` }}>
                <ellipse cy="1" rx="5" ry="1.8" fill="#2d3a22" opacity="0.25" />
                <path d="M-4,0 L0,-11 L4,0 Z" fill={p.color} stroke="#2d2a24" strokeWidth="0.8" />
                <circle cy="-13.5" r="3" fill="#f2dfc2" stroke="#2d2a24" strokeWidth="0.8" />
              </g>
            </g>
          );
        });
      })}
    </g>
  );
}

/** Paved paths of the city centre between the palace, the library, the archive and the plaza. */
function CityPaths({ L }: { L: Layout }) {
  const c = L.capital;
  const d = [L.library, L.archive, L.plaza].map((p) => `M${c.x},${c.y} L${p.x},${p.y}`).join(' ');
  return (
    <g aria-hidden="true">
      <path d={d} className="realm-path-bed" />
      <path d={d} className="realm-path" />
    </g>
  );
}

function XpBar({ xp, floor, next, nextName, progress }: { xp: number; floor: number; next: number | null; nextName: string | null; progress: number }) {
  const label = next === null ? `${xp} XP — высший уровень` : `${xp} из ${next} XP до уровня «${nextName}»`;
  return (
    <div className="xpbar">
      <div className="xpbar-track" role="progressbar" aria-label="Опыт до следующего уровня" aria-valuemin={floor} aria-valuemax={next ?? xp} aria-valuenow={xp} aria-valuetext={label}>
        <span style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <span className="small">{label}</span>
    </div>
  );
}

function CastleDetails({ c, color, envoys }: { c: Castle; color: string; envoys: Envoy[] }) {
  const s = useSession();
  const { data, error, reload } = useLoad(() => api<CastleDetail>(`/orgs/${s.org}/castles/${c.id}`), [s.org, c.id, c.xp]);
  return (
    <div className="stack">
      <h2 className="realm-h">
        <span className="realm-swatch" style={{ background: color }} aria-hidden="true" /> {c.name}
      </h2>
      <p className="level-badge">
        Уровень {c.level} · {c.levelName}
      </p>
      <p className="muted small">Стиль района: {civName(c.civilization)}</p>
      <a className="btn primary" href={`#/castles/${c.id}`}>
        Войти в замок
      </a>
      <XpBar xp={c.xp} floor={c.levelFloor} next={c.nextLevelXp} nextName={c.nextLevelName} progress={c.progress} />
      <dl className="realm-facts">
        <div>
          <dt>Внедрено</dt>
          <dd>{c.towers}</dd>
        </div>
        <div>
          <dt>Эффект, XP</dt>
          <dd>{c.effectXp}</dd>
        </div>
        <div>
          <dt>В работе</dt>
          <dd>{c.envoys}</dd>
        </div>
        <div>
          <dt>XP на 10 сотрудников</dt>
          <dd>{c.headcount ? Math.round((c.xp / c.headcount) * 100) / 10 : '—'}</dd>
        </div>
      </dl>
      <p className="muted small">Опыт начисляется только за подтверждённое внедрение (+100) и подтверждённый эффект (до +50).</p>

      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {data ? (
        <>
          <h3 className="realm-sub-h">Достижения</h3>
          <ul className="achievements">
            {data.achievements.map((a) => (
              <li key={a.key} data-earned={a.earnedAt ? 'yes' : 'no'}>
                <b>{a.title}</b>
                <span className="small muted">{a.earnedAt ? `получено ${shortDate(a.earnedAt)}` : 'ещё нет'}</span>
              </li>
            ))}
          </ul>
          <h3 className="realm-sub-h">История опыта</h3>
          {data.history.length ? (
            <ol className="xp-history">
              {data.history.slice(0, 8).map((h, i) => (
                <li key={`${h.number}-${h.kind}-${i}`}>
                  <span className="xp-plus">+{h.xp} XP</span>
                  <span>
                    <a href={`#/items/${h.number}`}>Обращение №{h.number}</a> {h.title}
                    <span className="small muted">
                      {' '}
                      — {h.kind === 'implementation' ? 'внедрение' : 'подтверждённый эффект'}, автор {h.credited}, {shortDate(h.at)}
                    </span>
                    {h.levelUp ? <span className="level-up-note">Новый уровень: {h.levelUp.name}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">Опыта пока нет: ни одно внедрение подразделения ещё не подтверждено.</p>
          )}
        </>
      ) : null}

      <CastlePeople castle={c} />

      <h3 className="realm-sub-h">Обращения в работе</h3>
      {envoys.length ? (
        <ul className="realm-envoys">
          {envoys.map((e) => (
            <li key={e.number}>
              <a href={`#/items/${e.number}`}>
                <span className="num">Обращение №{e.number}</span> {e.title}
              </a>
              <span className="row">
                <StatusChip status={e.status} />
                {e.overdueFirstResponse ? <span className="flag red">срок ответа прошёл</span> : null}
                {e.stale ? <span className="flag">нет движения</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Сейчас обращений в работе нет.</p>
      )}
    </div>
  );
}

function Legend({ levels }: { levels: string[] }) {
  const rows: { t: string; fig: JSX.Element }[] = [
    { t: 'Обращение в пути к Совету', fig: <EnvoyBody color={HERALDRY[1]!} /> },
    { t: 'Срок первого ответа прошёл', fig: <EnvoyBody color={HERALDRY[1]!} pennant={RED} /> },
    { t: 'Ваше обращение', fig: <EnvoyBody color={HERALDRY[1]!} mine /> },
  ];
  return (
    <div className="stack">
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
          <svg viewBox="-14 -26 28 30" width="22" height="24" aria-hidden="true">
            <Scaffold x={0} y={0} u={3.4} />
          </svg>
          Леса: решение принято, идёт внедрение
        </li>
      </ul>
      <ol className="level-legend">
        {levels.map((n, i) => (
          <li key={n}>
            <svg viewBox="-40 -48 80 60" width="44" height="34" aria-hidden="true">
              <IsoCastle level={i + 1} color={HERALDRY[0]!} u={3.4} />
            </svg>
            <span>
              <b>{i + 1}</b> {n}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function MapGround({ L, wide, lite, realm }: { L: Layout; wide: boolean; lite: boolean; realm: string }) {
  const cw = Math.min(L.w - 40, Math.max(wide ? 212 : 176, realm.length * 10 + 40));
  const trees = (
    wide
      ? [
          [0.33, 0.1], [0.37, 0.12], [0.3, 0.14], [0.68, 0.9], [0.72, 0.88], [0.06, 0.52], [0.09, 0.57], [0.95, 0.12], [0.92, 0.09], [0.47, 0.95], [0.53, 0.94], [0.15, 0.92],
        ]
      : [
          [0.1, 0.27], [0.15, 0.3], [0.88, 0.64], [0.9, 0.68], [0.5, 0.05], [0.55, 0.07], [0.12, 0.93], [0.17, 0.95], [0.86, 0.95],
        ]
  ).map(([x, y]) => ({ x: x! * L.w, y: y! * L.h }));
  const river = wide
    ? `M${L.w * 0.98},0 C${L.w * 0.86},${L.h * 0.25} ${L.w * 0.99},${L.h * 0.45} ${L.w * 0.9},${L.h * 0.62} S${L.w * 0.8},${L.h * 0.9} ${L.w * 0.86},${L.h}`
    : `M${L.w},${L.h * 0.16} C${L.w * 0.8},${L.h * 0.2} ${L.w * 0.95},${L.h * 0.32} ${L.w * 0.78},${L.h * 0.38}`;
  const tile = 46;
  return (
    <g aria-hidden="true">
      <defs>
        <linearGradient id="realm-meadow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b9cc98" />
          <stop offset="100%" stopColor="#9db97c" />
        </linearGradient>
        <pattern id="realm-tiles" width={tile * 2 * 0.866} height={tile} patternUnits="userSpaceOnUse">
          <path d={`M0,${tile / 2} L${tile * 0.866},0 L${tile * 2 * 0.866},${tile / 2} L${tile * 0.866},${tile} Z`} fill="none" stroke="#8aa86c" strokeWidth="0.8" opacity="0.55" />
        </pattern>
        <radialGradient id="realm-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f3d27a" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#f3d27a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="realm-vignette" cx="50%" cy="50%" r="72%">
          <stop offset="65%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#2d3a22" stopOpacity="0.28" />
        </radialGradient>
      </defs>
      <rect width={L.w} height={L.h} fill="url(#realm-meadow)" />
      {lite ? null : <rect width={L.w} height={L.h} fill="url(#realm-tiles)" />}
      <path d={river} fill="none" stroke="#6f9db0" strokeWidth="16" strokeLinecap="round" opacity="0.8" />
      {lite ? null : <path d={river} fill="none" stroke="#bfdbe4" strokeWidth="4" strokeLinecap="round" opacity="0.9" />}
      {(lite ? trees.slice(0, 5) : trees).map((t, i) => (
        <Tree key={i} x={t.x} y={t.y} u={wide ? 7 : 5.6} k={i % 3 === 0 ? 1.15 : 1} />
      ))}
      {/* Decorative parchment cartouche: the only parchment on the map. */}
      <g transform={`translate(${L.w - cw - 24}, ${L.h - (wide ? 76 : 70)})`}>
        <rect width={cw} height="50" rx="8" fill="#f1e6cc" stroke="#9c8661" strokeWidth="1.5" />
        <text x={cw / 2} y="31" textAnchor="middle" className="realm-cartouche">
          {realm}
        </text>
      </g>
      {lite ? null : <rect width={L.w} height={L.h} fill="url(#realm-vignette)" />}
    </g>
  );
}

/** A solid plate under every label: text never sits on the busy map. */
function LabelPlate({ y, title, sub, font, strong = false }: { y: number; title: string; sub?: string; font: number; strong?: boolean }) {
  const chars = Math.max(title.length * (strong ? 1.1 : 1), (sub?.length ?? 0) * 0.82);
  const w = chars * font * 0.56 + 26;
  const h = sub ? font * 2.45 + 10 : font * 1.4 + 10;
  return (
    <g>
      <rect x={-w / 2} y={y} width={w} height={h} rx="8" className={strong ? 'realm-plate strong' : 'realm-plate'} />
      <text x="0" y={y + font + 5} textAnchor="middle" className="realm-plate-title" style={{ fontSize: strong ? font * 1.15 : font }}>
        {title}
      </text>
      {sub ? (
        <text x="0" y={y + font * 2.15 + 6} textAnchor="middle" className="realm-plate-sub" style={{ fontSize: font * 0.82 }}>
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Camp({ at, count, font }: { at: Pt; count: number; font: number }) {
  return (
    <g transform={`translate(${at.x},${at.y})`} aria-hidden="true">
      {[0, 22].map((x) => (
        <path key={x} d={`M${x + 8},20 L${x + 20},0 L${x + 32},20 Z`} fill="#e3d2a8" stroke="#4a4034" strokeWidth="1.2" />
      ))}
      <g transform="translate(46, 28)">
        <LabelPlate y={0} title="Без подразделения" sub={`${count} ждут распределения`} font={font * 0.9} />
      </g>
    </g>
  );
}

function CastleMark({
  c,
  at,
  L,
  above,
  color,
  selected,
  celebrate,
  onEnter,
}: {
  c: Castle;
  at: Pt;
  L: Layout;
  /** Labels sit on the side away from the council, so roads and envoys never cross them. */
  above: boolean;
  color: string;
  selected: boolean;
  celebrate: boolean;
  /** Fly to the castle and open the district screen. */
  onEnter: (e: { preventDefault: () => void; ctrlKey?: boolean; metaKey?: boolean; button?: number }) => void;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') onEnter(e);
  };
  const civ = civOf(c.civilization);
  const plate = [2.6, 3.2, 3.8, 4.4, 5][c.level - 1]!;
  const bottom = P(plate, plate, 0, L.u).y;
  const height = CIV_HEIGHT[civ][c.level - 1]!;
  const name = `Войти в замок «${c.name}»: ${civName(civ)}, уровень ${c.level}, ${c.levelName}, ${c.xp} XP; в работе ${envoysWord(c.envoys)}`;
  return (
    <g
      transform={`translate(${at.x},${at.y})`}
      className={`realm-castle${selected ? ' is-selected' : ''}${celebrate ? ' is-celebrating' : ''}`}
      role="link"
      tabIndex={0}
      aria-label={name}
      data-castle={c.id}
      onClick={(e) => onEnter(e)}
      onKeyDown={onKey}
    >
      <title>{name}</title>
      <ellipse cy={-height * L.u * 0.3} rx={plate * 2 * 0.866 * L.u + 8} ry={height * L.u * 0.75 + plate * L.u} fill="transparent" />
      {selected ? <ellipse cy={L.u * 0.2} rx={plate * 2 * 0.866 * L.u + 14} ry={plate * L.u + 10} className="realm-ring" /> : null}
      <DistrictHouses civ={civ} level={c.level} u={L.u} color={color} />
      <CivCastle civ={civ} level={c.level} color={color} u={L.u} rising={celebrate} />
      {c.building ? <Scaffold x={plate + 1.4} y={-0.5} u={L.u} /> : null}
      {celebrate ? (
        <g className="realm-dust" aria-hidden="true">
          {[-26, -8, 12, 28].map((x, i) => (
            <circle key={x} cx={x} cy={bottom - 6 - (i % 2) * 6} r="6" fill="#efe6d2" />
          ))}
          <text y={-height * L.u - 8} textAnchor="middle" className="realm-xp-float">
            Новый уровень
          </text>
        </g>
      ) : null}
      <LabelPlate y={above ? -height * L.u - L.font * 2.45 - 18 : bottom + 10} title={c.name} sub={`Ур. ${c.level} · ${c.levelName}`} font={L.font} />
    </g>
  );
}

/** The small council place of a district (Зал даймё, Ханская юрта, Зал рыцарей, Совет нойонов): opens its real meetings. */
function HallMark({ c, at, L, color, onEnter }: { c: Castle; at: Pt; L: Layout; color: string; onEnter: (e: { preventDefault: () => void; ctrlKey?: boolean; metaKey?: boolean; button?: number }) => void }) {
  const hall = hallName(c.civilization);
  const label = `${hall} — малый совет подразделения «${c.name}»: заседания и обращения`;
  return (
    <g
      transform={`translate(${at.x},${at.y})`}
      className="realm-hall"
      role="link"
      tabIndex={0}
      aria-label={label}
      data-hall={c.id}
      onClick={(e) => onEnter(e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onEnter(e);
      }}
    >
      <title>{label}</title>
      <ellipse cy={-L.u * 0.6} rx={L.u * 3.2} ry={L.u * 2.4} fill="transparent" />
      <CouncilHall civ={c.civilization} u={L.u * 0.85} color={color} />
      <LabelPlate y={P(1.7, 1.7, 0, L.u * 0.85).y + 6} title={hall} font={L.font * 0.62} />
    </g>
  );
}

function EnvoyBody({ color, pennant, mine }: { color: string; pennant?: string; mine?: boolean }) {
  return (
    <g>
      {mine ? <circle cy="-12" r="14" fill="#fff4cf" fillOpacity="0.85" stroke="#b8860b" strokeWidth="2" /> : null}
      <ellipse cy="1" rx="7" ry="2.4" fill="#2d3a22" opacity="0.3" />
      <path d="M-6,0 L0,-15 L6,0 Z" fill={color} stroke="#2d2a24" strokeWidth="1" />
      <circle cy="-18" r="4" fill="#f2dfc2" stroke="#2d2a24" strokeWidth="1" />
      <line x1="7" y1="1" x2="7" y2="-25" stroke="#2d2a24" strokeWidth="1.3" />
      <path d="M7,-25 L17,-22 L7,-19 Z" fill={pennant ?? color} stroke="#2d2a24" strokeWidth="0.8" />
    </g>
  );
}

function EnvoyMark({ e, at, s, color, label, home }: { e: Envoy; at: Pt; s: number; color: string; label: string; home: boolean }) {
  const text = `Обращение №${e.number} «${e.title}»: ${label}${e.mine ? ' (ваше)' : ''}`;
  return (
    <g className="realm-envoy" style={{ transform: `translate(${at.x}px, ${at.y}px) scale(${s})` }}>
      <a href={`#/items/${e.number}`} aria-label={text}>
        <title>{text}</title>
        <g className="realm-walk" transform={home ? 'scale(-1,1)' : undefined}>
          <EnvoyBody color={color} pennant={e.overdueFirstResponse || e.overdueResolution ? RED : undefined} mine={e.mine} />
        </g>
        {e.mine ? (
          <g>
            <rect x="-22" y="-50" width="44" height="18" rx="5" className="realm-plate" />
            <text y="-36" textAnchor="middle" className="realm-tag">
              №{e.number}
            </text>
          </g>
        ) : null}
      </a>
    </g>
  );
}

/** People of the castle with their real job and game title; leads can call the castle's small council. */
function CastlePeople({ castle }: { castle: Castle }) {
  const s = useSession();
  const titles = useTitles();
  const people = (s.directory?.members ?? []).filter((m) => m.access === 'member' && m.department === castle.name);
  return (
    <>
      <h3 className="realm-sub-h">Участники замка: {people.length}</h3>
      {people.length ? (
        <ul className="castle-people">
          {people.map((m) => {
            const t = titles.get(m.membershipId);
            return (
              <li key={m.membershipId}>
                <b>{m.name}</b>
                <span className="small muted">{m.jobTitle ?? ''}</span>
                {t ? <span className={`title-chip rank-${t.rank}`}>{t.title}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted small">В справочнике нет сотрудников этого подразделения.</p>
      )}
      {(s.isLead || s.isAdmin) && people.length ? (
        <a className="btn small" href={`#/meetings/new?department=${castle.id}&title=${encodeURIComponent(`Малый совет: ${castle.name}`)}`}>
          Созвать малый совет с записью
        </a>
      ) : null}
    </>
  );
}
