import { useEffect, useRef, useState } from 'react';
import { useLite } from '../lib/lite';
import type { Civ } from './civ';
import type { TownBuilding } from './town';

/**
 * The hero of «Цитадель отдела» (ADR-0026): the department's castle in 3D at its real level, and a
 * clearly labelled preview of the other levels. Without WebGL, with reduced motion or in the lite
 * mode nothing is rendered here — the drawn castle in the header below stays.
 *
 * With `town` it is the 3D town of the district (ADR-0029): every working section has a pin on its
 * building and the same link in the list below. The pins are plain links to the ordinary sections —
 * the town is navigation, it grants nothing. Without WebGL only the list of buildings is shown.
 */
export function Citadel3D({ civ, civName, level, levelNames, color, name, town }: { civ: Civ; civName: string; level: number; levelNames: string[]; color: string; name: string; town?: TownBuilding[] }) {
  const [lite] = useLite();
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<import('../world3d/kitview').KitView | null>(null);
  const [shown, setShown] = useState(level);
  const [state, setState] = useState<'loading' | 'ready' | 'off'>('loading');
  const pins = useRef(new Map<string, HTMLAnchorElement>());
  const [active, setActive] = useState<string | null>(null);
  const townKey = town ? town.map((b) => b.id).join(',') : '';
  useEffect(() => setShown(level), [level]);

  useEffect(() => {
    if (lite) {
      setState('off');
      return;
    }
    let dead = false;
    let ro: ResizeObserver | null = null;
    void Promise.all([import('../world3d/kitview'), import('../world3d/world')]).then(([kv, w]) => {
      if (dead || !canvas.current || !box.current) return;
      if (!w.webglSupported()) {
        setState('off');
        return;
      }
      try {
        const v = new kv.KitView(canvas.current);
        v.spin = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        view.current = v;
        ro = new ResizeObserver(() => box.current && v.resize(box.current.clientWidth, box.current.clientHeight));
        ro.observe(box.current);
        v.resize(box.current.clientWidth, box.current.clientHeight);
        v.onPins = placePins;
        if (town) v.pad = 1.24;
        v.set(civ, level, color);
        setState('ready');
      } catch {
        setState('off');
      }
    });
    return () => {
      dead = true;
      ro?.disconnect();
      view.current?.dispose();
      view.current = null;
    };
    // The viewer is created once per page; the castle is swapped by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lite]);

  useEffect(() => {
    if (state === 'ready') view.current?.set(civ, shown, color);
  }, [civ, shown, color, state]);

  useEffect(() => {
    if (state === 'ready') view.current?.setPins(townKey ? townKey.split(',') : []);
  }, [townKey, state, civ, shown]);

  // Pins follow their buildings without re-rendering React: the viewer reports screen positions after each frame.
  // Every name stays readable: a name that would cover another name or mark is lifted above it on a thin stem.
  const placePins = (list: { id: string; x: number; y: number; depth: number; shown: boolean; own: boolean }[]) => {
    const stage = box.current;
    const W = stage?.clientWidth ?? 0;
    const MARK = 18; // the mark under the name
    const H = 28; // the name plate
    const shown = list.filter((p) => p.shown);
    for (const p of list) {
      const el = pins.current.get(p.id);
      if (el) el.dataset.own = p.own ? 'yes' : 'no';
      if (el && !p.shown) el.style.visibility = 'hidden';
    }
    // Marks are obstacles for every name but their own.
    const marks = shown.map((p) => ({ id: p.id, l: p.x - 10, r: p.x + 10, t: p.y - MARK, b: p.y }));
    const names: { l: number; r: number; t: number; b: number }[] = [];
    const hits = (a: { l: number; r: number; t: number; b: number }, o: { l: number; r: number; t: number; b: number }) => a.l < o.r + 4 && a.r > o.l - 4 && a.t < o.b + 3 && a.b > o.t - 3;
    // From the bottom of the picture upwards: the lower names keep their place, the upper ones rise.
    for (const p of [...shown].sort((a, b) => b.y - a.y)) {
      const el = pins.current.get(p.id);
      if (!el) continue;
      const w = Number(el.dataset.w) || 150;
      // A plate may stand over its stem or hang to either side of it (like a flag), and it stays inside the stage.
      const clamp = (d: number) => (W ? Math.min(W - 6 - (p.x + w / 2), Math.max(6 - (p.x - w / 2), d)) : d);
      const side = Math.max(0, w / 2 - 14);
      const offsets = [...new Set([clamp(0), clamp(side), clamp(-side)])];
      const at = (d: number, up: number) => ({ l: p.x - w / 2 + d, r: p.x + w / 2 + d, b: p.y - MARK - up, t: p.y - MARK - up - H });
      const blocker = (q: { l: number; r: number; t: number; b: number }) => names.find((n) => hits(q, n)) ?? marks.find((m) => m.id !== p.id && hits(q, m));
      let lift = 0;
      let dx = offsets[0]!;
      let plate = at(dx, 0);
      for (let i = 0; i < 24; i++) {
        // At this height: the first free place wins; otherwise rise just enough to clear the lowest obstacle.
        let next = Infinity;
        let free: number | null = null;
        for (const d of offsets) {
          const o = blocker(at(d, lift));
          if (!o) {
            free = d;
            break;
          }
          next = Math.min(next, p.y - MARK - (o.t - 5));
        }
        if (free !== null) {
          dx = free;
          plate = at(dx, lift);
          break;
        }
        lift = Math.max(lift + 1, next);
        plate = at(dx, lift);
      }
      const fits = plate.t > 4;
      el.style.visibility = 'visible';
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
      el.style.zIndex = String(Math.round((1 - p.depth) * 10000));
      el.dataset.compact = fits ? 'no' : 'yes';
      el.style.setProperty('--lift', `${fits ? Math.round(lift) : 0}px`);
      el.style.setProperty('--dx', `${Math.round(dx)}px`);
      if (fits) names.push(plate);
    }
  };

  const hover = (id: string | null) => {
    setActive(id);
    if (id) view.current?.look(id);
  };
  const shortcuts = town ? (
    <nav className="town3d-list" aria-label={`Все здания города «${name}»`}>
      {town.map((b) => (
        <a key={b.id} href={b.href} data-on={active === b.id ? 'yes' : 'no'} onFocus={() => hover(b.id)} onBlur={() => hover(null)} onMouseEnter={() => hover(b.id)} onMouseLeave={() => hover(null)}>
          <strong>{b.name}</strong>
          <small>{b.detail}</small>
        </a>
      ))}
    </nav>
  ) : null;
  if (state === 'off')
    return town ? (
      <section className="citadel3d" data-town="yes" aria-label={`Город отдела «${name}»`}>
        <p className="citadel3d-cap town3d-off" role="status">
          <b>3D здесь недоступно</b> — нет поддержки WebGL или включён облегчённый режим. Все здания города — в списке.
        </p>
        {shortcuts}
      </section>
    ) : null;
  const preview = shown !== level;
  return (
    <section className="citadel3d" data-town={town ? 'yes' : 'no'} aria-label={town ? `Город отдела «${name}» в 3D` : `Цитадель отдела «${name}» в 3D`}>
      <div className="citadel3d-stage" ref={box}>
        <canvas ref={canvas} aria-hidden="true" />
        {state === 'loading' ? <p className="citadel3d-wait">{town ? 'Строим город…' : 'Строим цитадель…'}</p> : null}
        {town && state === 'ready' ? (
          <div className="town3d-pins">
            {town.map((b) => (
              <a
                key={b.id}
                className="town3d-pin"
                href={b.href}
                data-on={active === b.id ? 'yes' : 'no'}
                aria-label={`${b.name}: ${b.detail}`}
                title={`${b.name} — ${b.detail}`}
                // Keyboard users have the same links in the list below, in a stable order.
                tabIndex={-1}
                ref={(el) => {
                  if (el) {
                    pins.current.set(b.id, el);
                    // Measured once, while the name is still shown.
                    if (!el.dataset.w) el.dataset.w = String((el.firstElementChild as HTMLElement | null)?.offsetWidth || 150);
                  } else pins.current.delete(b.id);
                }}
                onMouseEnter={() => setActive(b.id)}
                onMouseLeave={() => setActive(null)}
              >
                <span className="town3d-pin-name">{b.name}</span>
                <span className="town3d-pin-stem" aria-hidden="true" />
                <span className="town3d-pin-mark" aria-hidden="true" />
              </a>
            ))}
          </div>
        ) : null}
      </div>
      <div className="citadel3d-bar">
        <p className="citadel3d-cap" role="status">
          {preview ? (
            <>
              <b>Предпросмотр уровня {shown}</b> — «{levelNames[shown - 1] ?? ''}». Сейчас у отдела уровень {level}: замок вырастет только после подтверждённых внедрений.
            </>
          ) : (
            <>
              <b>{civName}</b> · уровень {level} — «{levelNames[level - 1] ?? ''}». {town ? 'Тяните, чтобы осмотреть город; здание открывает рабочий раздел.' : 'Тяните, чтобы осмотреть цитадель.'}
            </>
          )}
        </p>
        <div className="citadel3d-levels" role="group" aria-label="Как выглядит цитадель на каждом уровне">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" aria-pressed={shown === n} aria-label={`Уровень ${n}${n === level ? ' — текущий' : ' — предпросмотр'}`} data-now={n === level ? 'yes' : 'no'} onClick={() => setShown(n)}>
              {n}
            </button>
          ))}
        </div>
      </div>
      {shortcuts}
    </section>
  );
}
