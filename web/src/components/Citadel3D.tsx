import { useEffect, useRef, useState } from 'react';
import { useLite } from '../lib/lite';
import type { Civ } from './civ';

/**
 * The hero of «Цитадель отдела» (ADR-0026): the department's castle in 3D at its real level, and a
 * clearly labelled preview of the other levels. Without WebGL, with reduced motion or in the lite
 * mode nothing is rendered here — the drawn castle in the header below stays.
 */
export function Citadel3D({ civ, civName, level, levelNames, color, name }: { civ: Civ; civName: string; level: number; levelNames: string[]; color: string; name: string }) {
  const [lite] = useLite();
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<import('../world3d/kitview').KitView | null>(null);
  const [shown, setShown] = useState(level);
  const [state, setState] = useState<'loading' | 'ready' | 'off'>('loading');
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

  if (state === 'off') return null;
  const preview = shown !== level;
  return (
    <section className="citadel3d" aria-label={`Цитадель отдела «${name}» в 3D`}>
      <div className="citadel3d-stage" ref={box}>
        <canvas ref={canvas} aria-hidden="true" />
        {state === 'loading' ? <p className="citadel3d-wait">Строим цитадель…</p> : null}
      </div>
      <div className="citadel3d-bar">
        <p className="citadel3d-cap" role="status">
          {preview ? (
            <>
              <b>Предпросмотр уровня {shown}</b> — «{levelNames[shown - 1] ?? ''}». Сейчас у отдела уровень {level}: замок вырастет только после подтверждённых внедрений.
            </>
          ) : (
            <>
              <b>{civName}</b> · уровень {level} — «{levelNames[level - 1] ?? ''}». Тяните, чтобы осмотреть цитадель.
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
    </section>
  );
}
