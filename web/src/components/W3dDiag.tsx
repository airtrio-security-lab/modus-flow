import { useEffect, useRef, useState, type RefObject } from 'react';
import type { World } from '../world3d/world';
import { BUDGET, read, type Measured } from '../world3d/budget';

/**
 * Diagnostics of the 3D city on THIS device (ADR-0030): frame time, draw calls, triangles, resolution
 * and the graphics adapter, read against the budget. Not part of the product screen: it opens only
 * with `#/kingdom?diag=1` (or `modus.w3d.diag = 1` on the device) and exists to answer one question
 * before a demo or a pilot — which quality tier this laptop or phone really holds.
 */
const FLAG = 'modus.w3d.diag';
const QUALITY = 'modus.w3d.quality';
const MEASURE_MS = 8000;
type Diag = ReturnType<World['diagnostics']>;

export function diagWanted() {
  try {
    return /[?&]diag=1\b/.test(location.hash) || localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

const thousands = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)} тыс.` : String(n));
const ms = (n: number) => (n ? `${n.toFixed(1)} мс` : '—');

export function W3dDiag({ world }: { world: RefObject<World | null> }) {
  const [d, setD] = useState<Diag | null>(null);
  const [open, setOpen] = useState(true);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fixed, setFixed] = useState<Diag | null>(null);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const timer = useRef(0);
  const pinned = (() => {
    try {
      return localStorage.getItem(QUALITY);
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    const tick = () => {
      const w = world.current;
      if (w) setD(w.diagnostics());
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(timer.current);
    };
  }, [world]);

  if (gone || !d) return null;
  const shown = fixed ?? d;
  const m: Measured = { quality: shown.quality, calls: shown.calls, triangles: shown.triangles, medianMs: shown.medianMs, p90Ms: shown.p90Ms, gpu: shown.gpu };
  const r = read(m);
  const b = BUDGET[shown.quality];

  /** One fixed scene for every device: the whole city from the overview, frames counted from zero. */
  const measure = () => {
    const w = world.current;
    if (!w || busy) return;
    setBusy(true);
    setFixed(null);
    setCopied(null);
    void w.flyTo(w.overview(), 0);
    w.frames.length = 0;
    timer.current = window.setTimeout(() => {
      setFixed(world.current?.diagnostics() ?? null);
      setBusy(false);
    }, MEASURE_MS);
  };
  const report = () =>
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        scene: fixed ? `overview, ${MEASURE_MS / 1000} s` : 'current view, last frames',
        ...shown,
        medianMs: Math.round(shown.medianMs * 10) / 10,
        p90Ms: Math.round(shown.p90Ms * 10) / 10,
        fps: r.fps,
        budget: b,
        level: r.level,
        notes: r.notes,
        userAgent: navigator.userAgent,
      },
      null,
      2,
    );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  };
  const pin = (q: 'low' | 'medium' | 'high' | null) => {
    try {
      if (q) localStorage.setItem(QUALITY, q);
      else localStorage.removeItem(QUALITY);
      // The picture is rebuilt for another tier: the page starts again, the panel stays.
      localStorage.setItem(FLAG, '1');
    } catch {
      /* storage unavailable: nothing to pin */
    }
    location.reload();
  };
  const close = () => {
    try {
      localStorage.removeItem(FLAG);
    } catch {
      /* ignore */
    }
    setGone(true);
  };

  if (!open)
    return (
      <button type="button" className="w3d-diag-chip" data-world-ui="" data-level={r.level} onClick={() => setOpen(true)} aria-label="Открыть диагностику 3D">
        {r.fps ? `${r.fps} к/с` : 'замер'}
      </button>
    );
  return (
    <section className="w3d-diag" data-world-ui="" data-world-scroll="" aria-label="Диагностика 3D на этом устройстве">
      <header>
        <b>Диагностика 3D</b>
        <small>служебная панель, в показ не входит</small>
        <button type="button" onClick={() => setOpen(false)} aria-label="Свернуть диагностику">
          –
        </button>
      </header>
      <p className="w3d-diag-verdict" data-level={busy ? 'none' : r.level} role="status">
        {busy ? `Идёт замер: ${MEASURE_MS / 1000} секунд, не трогайте город…` : r.notes[0]}
      </p>
      {!busy && r.notes.length > 1 ? (
        <ul className="w3d-diag-notes">
          {r.notes.slice(1).map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <dl>
        <div>
          <dt>Кадр, медиана</dt>
          <dd>
            {ms(shown.medianMs)}
            {r.fps ? ` · ${r.fps} к/с` : ''}
          </dd>
        </div>
        <div>
          <dt>Кадр, 90-й процентиль</dt>
          <dd>{ms(shown.p90Ms)}</dd>
        </div>
        <div data-over={r.overCalls ? 'yes' : 'no'}>
          <dt>Вызовы отрисовки</dt>
          <dd>
            {shown.calls} из {b.calls}
          </dd>
        </div>
        <div data-over={r.overTriangles ? 'yes' : 'no'}>
          <dt>Треугольники</dt>
          <dd>
            {thousands(shown.triangles)} из {thousands(b.triangles)}
          </dd>
        </div>
        <div>
          <dt>Разрешение</dt>
          <dd>
            {shown.width}×{shown.height} · плотность {shown.dpr} из {Math.round(shown.deviceDpr * 100) / 100}
          </dd>
        </div>
        <div>
          <dt>В сцене</dt>
          <dd>
            районов {shown.districts}, гонцов {shown.envoys}
          </dd>
        </div>
        <div>
          <dt>Движение</dt>
          <dd>{shown.live ? 'включено' : 'выключено: кадр рисуется по изменению'}</dd>
        </div>
        <div className="w3d-diag-wide">
          <dt>Графический адаптер</dt>
          <dd>{shown.gpu || 'браузер не сообщает'}</dd>
        </div>
      </dl>
      <div className="w3d-diag-row" role="group" aria-label="Уровень качества на этом устройстве">
        {(['low', 'medium', 'high'] as const).map((q) => (
          <button key={q} type="button" aria-pressed={pinned === q} onClick={() => pin(q)}>
            {q === 'low' ? 'низкий' : q === 'medium' ? 'средний' : 'высокий'}
          </button>
        ))}
        <button type="button" aria-pressed={!pinned} onClick={() => pin(null)}>
          авто
        </button>
      </div>
      <p className="w3d-diag-hint">
        Сейчас: {shown.quality === 'low' ? 'низкий' : shown.quality === 'medium' ? 'средний' : 'высокий'}
        {pinned ? ', закреплён на этом устройстве' : ', выбран автоматически'}. Смена уровня перезагружает страницу.
      </p>
      <div className="w3d-diag-row">
        <button type="button" className="w3d-diag-main" onClick={measure} disabled={busy}>
          {fixed ? 'Замерить заново' : `Замер ${MEASURE_MS / 1000} с`}
        </button>
        <button type="button" onClick={() => void copy()} disabled={busy}>
          Скопировать отчёт
        </button>
        <button type="button" onClick={close}>
          Убрать панель
        </button>
      </div>
      {copied === 'yes' ? <p className="w3d-diag-hint" role="status">Отчёт скопирован — вставьте его в заметку о замере.</p> : null}
      {copied === 'no' ? (
        <textarea className="w3d-diag-report" readOnly rows={6} value={report()} aria-label="Отчёт о замере: выделите и скопируйте" onFocus={(e) => e.currentTarget.select()} />
      ) : null}
    </section>
  );
}
