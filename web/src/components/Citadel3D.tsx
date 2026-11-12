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
        if (town) v.pad = 1.16;
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
  const placePins = (list: { id: string; x: number; y: number; depth: number; shown: boolean }[]) => {
    const boxes: { l: number; r: number; t: number; b: number }[] = [];
    // The citadel keeps its name first, then the nearer buildings.
    for (const p of [...list].sort((a, b) => Number(b.id === 'growth') - Number(a.id === 'growth') || a.depth - b.depth)) {
      const el = pins.current.get(p.id);
      if (!el) continue;
      el.style.visibility = p.shown ? 'visible' : 'hidden';
      if (!p.shown) continue;
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
      el.style.zIndex = String(Math.round((1 - p.depth) * 10000));
      // A name that would cover a nearer pin folds into its mark; the list below always has every name.
      const w = Number(el.dataset.w) || 150;
      const box = { l: p.x - w / 2 + 6, r: p.x + w / 2 - 6, t: p.y - 44, b: p.y - 2 };
      const hit = boxes.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t);
      el.dataset.compact = hit ? 'yes' : 'no';
      boxes.push(hit ? { l: p.x - 22, r: p.x + 22, t: p.y - 46, b: p.y } : box);
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
                    if (!el.dataset.w) el.dataset.w = String(el.offsetWidth || 150);
                  } else pins.current.delete(b.id);
                }}
                onMouseEnter={() => setActive(b.id)}
                onMouseLeave={() => setActive(null)}
              >
                <span className="town3d-pin-name">{b.name}</span>
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
