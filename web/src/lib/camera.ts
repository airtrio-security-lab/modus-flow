import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent } from 'react';

/**
 * Camera over the SVG city (ADR-0019): the view is a rectangle of the world that becomes the
 * SVG viewBox. Wheel and buttons zoom, mouse and finger drag pan, two fingers pinch, arrows and
 * +/− work from the keyboard. The view never leaves the world, so the city cannot get lost.
 * Flights are short and skipped entirely in light graphics or with reduced motion.
 */
export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}
const MAX_ZOOM = 3.5;
const KEY = 'modus.camera';

export function useCamera(W: number, H: number, opts: { instant: boolean }) {
  const full: View = { x: 0, y: 0, w: W, h: H };
  const [view, setViewRaw] = useState<View>(() => restore(W, H) ?? full);
  const viewRef = useRef(view);
  const anim = useRef<number | null>(null);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ moved: boolean; start: { x: number; y: number }; view: View; dist?: number } | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const [el, setEl] = useState<SVGSVGElement | null>(null);
  const suppressClick = useRef(false);

  const setView = useCallback(
    (v: View) => {
      const c = clamp(v, W, H);
      viewRef.current = c;
      setViewRaw(c);
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ ...c, W, H }));
      } catch {
        /* ignore */
      }
    },
    [W, H],
  );
  // A new world size (desktop ↔ phone layout): the view saved for that size, or the whole city.
  useEffect(() => {
    const v = viewRef.current;
    if (v.w > W || v.h > H || Math.abs(v.w / v.h - W / H) > 0.01) setView(restore(W, H) ?? full);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [W, H]);
  useEffect(() => () => {
    if (anim.current) cancelAnimationFrame(anim.current);
  }, []);

  const zoomAt = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      const v = viewRef.current;
      const w = Math.max(W / MAX_ZOOM, Math.min(W, v.w / factor));
      const h = (w * H) / W;
      const p = at ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
      setView({ x: p.x - ((p.x - v.x) * w) / v.w, y: p.y - ((p.y - v.y) * h) / v.h, w, h });
    },
    [W, H, setView],
  );

  /** Fly to a world point at a zoom (1 = whole city). Resolves when the camera arrives. */
  const flyTo = useCallback(
    (p: { x: number; y: number } | null, zoom = 2.4, ms = 520) =>
      new Promise<void>((resolve) => {
        const w = p ? W / Math.min(MAX_ZOOM, zoom) : W;
        const h = (w * H) / W;
        const to = clamp(p ? { x: p.x - w / 2, y: p.y - h / 2, w, h } : full, W, H);
        if (anim.current) cancelAnimationFrame(anim.current);
        if (opts.instant) {
          setView(to);
          resolve();
          return;
        }
        const from = viewRef.current;
        const t0 = performance.now();
        const step = (t: number) => {
          const k = Math.min(1, (t - t0) / ms);
          const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          setView({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e, h: from.h + (to.h - from.h) * e });
          if (k < 1) anim.current = requestAnimationFrame(step);
          else {
            anim.current = null;
            resolve();
          }
        };
        anim.current = requestAnimationFrame(step);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [W, H, opts.instant, setView],
  );

  const toWorld = (clientX: number, clientY: number) => {
    const r = svg.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (!r || !r.width) return { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    return { x: v.x + ((clientX - r.left) / r.width) * v.w, y: v.y + ((clientY - r.top) / r.height) * v.h };
  };

  // The wheel needs a non-passive listener to keep the page from scrolling while it zooms.
  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // At the whole-city view, scrolling down scrolls the page past the map.
      if (viewRef.current.w >= W && e.deltaY > 0) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, toWorld(e.clientX, e.clientY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, W, zoomAt]);

  const handlers = {
    ref: (node: SVGSVGElement | null) => {
      svg.current = node;
      setEl(node);
    },
    onPointerDown: (e: RPointerEvent<SVGSVGElement>) => {
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const v = viewRef.current;
      if (ptrs.current.size === 2) {
        const [a, b] = [...ptrs.current.values()];
        drag.current = { moved: true, start: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, view: v, dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
      } else drag.current = { moved: false, start: { x: e.clientX, y: e.clientY }, view: v };
    },
    onPointerMove: (e: RPointerEvent<SVGSVGElement>) => {
      if (!drag.current || !ptrs.current.has(e.pointerId)) return;
      ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const r = svg.current?.getBoundingClientRect();
      if (!r || !r.width) return;
      const d = drag.current;
      if (ptrs.current.size === 2 && d.dist) {
        const [a, b] = [...ptrs.current.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
        const w = Math.max(W / MAX_ZOOM, Math.min(W, (d.view.w * d.dist) / dist));
        const h = (w * H) / W;
        const anchor = { x: d.view.x + ((d.start.x - r.left) / r.width) * d.view.w, y: d.view.y + ((d.start.y - r.top) / r.height) * d.view.h };
        setView({ x: anchor.x - ((mid.x - r.left) / r.width) * w, y: anchor.y - ((mid.y - r.top) / r.height) * h, w, h });
        return;
      }
      const dx = e.clientX - d.start.x;
      const dy = e.clientY - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) < 6) return;
      if (!d.moved) {
        d.moved = true;
        try {
          svg.current?.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      setView({ ...d.view, x: d.view.x - (dx / r.width) * d.view.w, y: d.view.y - (dy / r.height) * d.view.h });
    },
    onPointerUp: (e: RPointerEvent<SVGSVGElement>) => {
      ptrs.current.delete(e.pointerId);
      if (drag.current?.moved) suppressClick.current = true;
      if (ptrs.current.size === 0) drag.current = null;
    },
    onPointerCancel: (e: RPointerEvent<SVGSVGElement>) => {
      ptrs.current.delete(e.pointerId);
      drag.current = null;
    },
    // A drag must not also click the castle under the pointer.
    onClickCapture: (e: RMouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };

  const onKey = (e: RKeyboardEvent) => {
    const v = viewRef.current;
    const step = { x: v.w * 0.12, y: v.h * 0.12 };
    const k = e.key;
    if (k === '+' || k === '=') zoomAt(1.25);
    else if (k === '-' || k === '_') zoomAt(1 / 1.25);
    else if (k === '0') setView(full);
    else if (k === 'ArrowLeft') setView({ ...v, x: v.x - step.x });
    else if (k === 'ArrowRight') setView({ ...v, x: v.x + step.x });
    else if (k === 'ArrowUp') setView({ ...v, y: v.y - step.y });
    else if (k === 'ArrowDown') setView({ ...v, y: v.y + step.y });
    else return;
    e.preventDefault();
  };

  return { view, zoom: W / view.w, flyTo, zoomAt, reset: () => setView(full), handlers, onKey };
}

/** The view saved in this tab for a world of this size, if any. */
function restore(W: number, H: number): View | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as (View & { W: number; H: number }) | null;
    if (saved && saved.W === W && saved.H === H) return clamp(saved, W, H);
  } catch {
    /* storage may be unavailable */
  }
  return null;
}

function clamp(v: View, W: number, H: number): View {
  const w = Math.max(W / MAX_ZOOM, Math.min(W, v.w));
  const h = (w * H) / W;
  return { x: Math.max(0, Math.min(W - w, v.x)), y: Math.max(0, Math.min(H - h, v.y)), w, h };
}
