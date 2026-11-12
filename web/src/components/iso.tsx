import type { ReactNode } from 'react';

/**
 * Isometric drawing kit for the kingdom map: stone and timber boxes, pyramid
 * roofs, crenellations and banners. Coordinates are in "grid" units around the
 * castle's ground centre; z goes up. Everything is plain SVG so it scales,
 * prints and works without WebGL on slow computers.
 */
const COS = 0.866;
const SIN = 0.5;

export function P(x: number, y: number, z = 0, u = 1) {
  return { x: (x - y) * COS * u, y: (x + y) * SIN * u - z * u };
}
const pts = (list: { x: number; y: number }[]) => list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

export interface Shade {
  top: string;
  left: string;
  right: string;
}

export const STONE: Shade = { top: '#e4ded2', left: '#c3bba9', right: '#a39a88' };
export const STONE_DARK: Shade = { top: '#d3cbbb', left: '#b0a691', right: '#8f8573' };
export const TIMBER: Shade = { top: '#c49a6c', left: '#a67b50', right: '#87603b' };
export const PLINTH: Shade = { top: '#9db97c', left: '#8a7355', right: '#735e44' };
const EDGE = '#4a4034';

/** Lighter / darker variants of a heraldic colour for roof faces. */
export function shadeOf(hex: string): Shade {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number, k: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  const mk = (k: number) => {
    const r = ch((n >> 16) & 255, k);
    const g = ch((n >> 8) & 255, k);
    const b = ch(n & 255, k);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  };
  return { top: mk(1.15), left: mk(1.0), right: mk(0.78) };
}

/** A box from (x0,y0) of size w×d, from z0 up by h. Only the three visible faces are drawn. */
export function Box({ x0, y0, w, d, z0 = 0, h, s, u = 1, stroke = EDGE }: { x0: number; y0: number; w: number; d: number; z0?: number; h: number; s: Shade; u?: number; stroke?: string }) {
  const x1 = x0 + w;
  const y1 = y0 + d;
  const z1 = z0 + h;
  return (
    <g strokeWidth="0.8" stroke={stroke} strokeLinejoin="round">
      <polygon points={pts([P(x0, y1, z0, u), P(x1, y1, z0, u), P(x1, y1, z1, u), P(x0, y1, z1, u)])} fill={s.left} />
      <polygon points={pts([P(x1, y0, z0, u), P(x1, y1, z0, u), P(x1, y1, z1, u), P(x1, y0, z1, u)])} fill={s.right} />
      <polygon points={pts([P(x0, y0, z1, u), P(x1, y0, z1, u), P(x1, y1, z1, u), P(x0, y1, z1, u)])} fill={s.top} />
    </g>
  );
}

/** Pyramid roof over a w×d footprint at height z. */
export function Roof({ x0, y0, w, d, z, h, s, u = 1 }: { x0: number; y0: number; w: number; d: number; z: number; h: number; s: Shade; u?: number }) {
  const x1 = x0 + w;
  const y1 = y0 + d;
  const apex = P(x0 + w / 2, y0 + d / 2, z + h, u);
  return (
    <g strokeWidth="0.8" stroke={EDGE} strokeLinejoin="round">
      <polygon points={pts([P(x0, y1, z, u), P(x1, y1, z, u), apex])} fill={s.left} />
      <polygon points={pts([P(x1, y0, z, u), P(x1, y1, z, u), apex])} fill={s.right} />
    </g>
  );
}

/** Merlons along the two front edges of a box top. */
export function Crenels({ x0, y0, w, d, z, s, u = 1, step = 0.5 }: { x0: number; y0: number; w: number; d: number; z: number; s: Shade; u?: number; step?: number }) {
  const out: ReactNode[] = [];
  const m = step * 0.5;
  for (let x = x0; x + m <= x0 + w + 0.001; x += step) out.push(<Box key={`a${x}`} x0={x} y0={y0 + d - m} w={m} d={m} z0={z} h={m * 0.9} s={s} u={u} />);
  for (let y = y0; y + m <= y0 + d - m + 0.001; y += step) out.push(<Box key={`b${y}`} x0={x0 + w - m} y0={y} w={m} d={m} z0={z} h={m * 0.9} s={s} u={u} />);
  return <g>{out}</g>;
}

/** A square tower with crenels and an optional pointed roof. */
export function Tower({ x, y, size, h, roof, u = 1, s = STONE, className }: { x: number; y: number; size: number; h: number; roof?: string; u?: number; s?: Shade; className?: string }) {
  return (
    <g className={className}>
      <Box x0={x} y0={y} w={size} d={size} h={h} s={s} u={u} />
      {roof ? (
        <Roof x0={x - 0.15} y0={y - 0.15} w={size + 0.3} d={size + 0.3} z={h} h={size * 1.5} s={shadeOf(roof)} u={u} />
      ) : (
        <Crenels x0={x} y0={y} w={size} d={size} z={h} s={s} u={u} step={size / 2} />
      )}
    </g>
  );
}

/** A banner on a pole standing at grid point (x, y) from height z. */
export function Banner({ x, y, z, color, u = 1, len = 2.2 }: { x: number; y: number; z: number; color: string; u?: number; len?: number }) {
  const base = P(x, y, z, u);
  const top = P(x, y, z + len, u);
  return (
    <g>
      <line x1={base.x} y1={base.y} x2={top.x} y2={top.y} stroke={EDGE} strokeWidth="1.2" />
      <path className="realm-flag" d={`M${top.x},${top.y} l${u * 0.9},${u * 0.25} l${-u * 0.9},${u * 0.3} Z`} fill={color} stroke={EDGE} strokeWidth="0.7" />
    </g>
  );
}

/** A diamond ground plate under a castle. */
export function Plate({ r, u = 1, s = PLINTH, h = 0.35 }: { r: number; u?: number; s?: Shade; h?: number }) {
  return <Box x0={-r} y0={-r} w={r * 2} d={r * 2} z0={-h} h={h} s={s} u={u} stroke="#5d6b45" />;
}

export function Tree({ x, y, u = 1, k = 1 }: { x: number; y: number; u?: number; k?: number }) {
  const b = P(0, 0, 0, u);
  return (
    <g transform={`translate(${x},${y})`}>
      <ellipse cx={b.x} cy={b.y + 1} rx={u * 0.7 * k} ry={u * 0.35 * k} fill="#3f5a2e" opacity="0.25" />
      <rect x={-0.12 * u * k} y={-0.8 * u * k} width={0.24 * u * k} height={0.8 * u * k} fill="#6b4a2c" />
      <path d={`M0,${-3.2 * u * k} L${0.9 * u * k},${-0.6 * u * k} L${-0.9 * u * k},${-0.6 * u * k} Z`} fill="#4f7a3c" stroke="#35552a" strokeWidth="0.8" />
      <path d={`M0,${-3.2 * u * k} L${0.9 * u * k},${-0.6 * u * k} L0,${-0.6 * u * k} Z`} fill="#3f6630" />
    </g>
  );
}

/** Scaffolding beside a castle: a decision was taken and the work is under way. */
export function Scaffold({ x, y, u = 1 }: { x: number; y: number; u?: number }) {
  const a = P(x, y, 0, u);
  const t = P(x, y, 3, u);
  const w = 1.1 * u;
  return (
    <g stroke="#7a5532" strokeWidth="1.3" fill="none" aria-hidden="true">
      <line x1={a.x - w} y1={a.y} x2={t.x - w} y2={t.y} />
      <line x1={a.x + w} y1={a.y} x2={t.x + w} y2={t.y} />
      {[0.25, 0.5, 0.75].map((k) => (
        <line key={k} x1={a.x - w} y1={a.y + (t.y - a.y) * k} x2={a.x + w} y2={a.y + (t.y - a.y) * k} />
      ))}
      <line x1={a.x - w} y1={a.y} x2={a.x + w} y2={a.y + (t.y - a.y) * 0.5} />
    </g>
  );
}

/**
 * The castle of one department by level (1 Поселение … 5 Легендарная крепость).
 * Each level adds architecture; nothing is random, so the same level always
 * looks the same. `rising` marks the parts of the newest level for the
 * construction animation.
 */
export function IsoCastle({ level, color, u, rising = false }: { level: number; color: string; u: number; rising?: boolean }) {
  const rise = (l: number) => (rising && l === level ? 'iso-rise' : undefined);
  const plate = [2.6, 3.2, 3.8, 4.4, 5][level - 1]!;
  return (
    <g>
      {level >= 5 ? <ellipse cx="0" cy={u * 0.4} rx={u * 7.5} ry={u * 3.9} fill="url(#realm-glow)" /> : null}
      <Plate r={plate} u={u} />
      {level === 1 ? (
        <g className={rise(1)}>
          {/* palisade */}
          <Box x0={-2.2} y0={-2.2} w={4.4} d={0.3} h={0.9} s={TIMBER} u={u} />
          <Box x0={-2.2} y0={-2.2} w={0.3} d={4.4} h={0.9} s={TIMBER} u={u} />
          <Box x0={-0.6} y0={-0.9} w={1.6} d={1.4} h={1.1} s={TIMBER} u={u} />
          <Roof x0={-0.75} y0={-1.05} w={1.9} d={1.7} z={1.1} h={1.1} s={shadeOf('#8a6440')} u={u} />
          <Tower x={1.1} y={-1.8} size={0.7} h={2.6} roof={color} s={TIMBER} u={u} />
          <Box x0={-2.2} y0={1.9} w={4.4} d={0.3} h={0.9} s={TIMBER} u={u} />
          <Box x0={1.9} y0={-2.2} w={0.3} d={4.4} h={0.9} s={TIMBER} u={u} />
          <Banner x={1.45} y={-1.45} z={3.7} color={color} u={u} len={1.4} />
        </g>
      ) : (
        <g>
          {/* back walls first */}
          <Box x0={-plate + 0.5} y0={-plate + 0.5} w={(plate - 0.5) * 2} d={0.45} h={1.2} s={STONE_DARK} u={u} />
          <Box x0={-plate + 0.5} y0={-plate + 0.5} w={0.45} d={(plate - 0.5) * 2} h={1.2} s={STONE_DARK} u={u} />
          {level >= 4 ? (
            <g className={rise(4)}>
              <Tower x={-plate + 0.2} y={-plate + 0.2} size={1.2} h={3.8} roof={color} u={u} />
            </g>
          ) : null}
          {/* keep */}
          <g className={rise(2)}>
            <Box x0={-1.1} y0={-1.1} w={2.2} d={2.2} h={level >= 4 ? 4.2 : 3.2} s={STONE} u={u} />
            {level >= 4 ? (
              <Roof x0={-1.25} y0={-1.25} w={2.5} d={2.5} z={4.2} h={2.2} s={shadeOf(color)} u={u} />
            ) : (
              <Crenels x0={-1.1} y0={-1.1} w={2.2} d={2.2} z={3.2} s={STONE} u={u} step={0.55} />
            )}
          </g>
          {level >= 5 ? (
            <g className={rise(5)}>
              <Box x0={-0.35} y0={-0.35} w={0.7} d={0.7} z0={4.2} h={2.4} s={STONE} u={u} />
              <Roof x0={-0.45} y0={-0.45} w={0.9} d={0.9} z={6.6} h={2.4} s={shadeOf('#c99a2e')} u={u} />
            </g>
          ) : null}
          <Banner x={0} y={0} z={level >= 5 ? 9 : level >= 4 ? 6.4 : 3.6} color={level >= 5 ? '#c99a2e' : color} u={u} />
          {/* front walls with a gate */}
          <Box x0={-plate + 0.5} y0={plate - 0.95} w={(plate - 0.5) * 2} d={0.45} h={1.2} s={STONE} u={u} />
          <Box x0={plate - 0.95} y0={-plate + 0.5} w={0.45} d={(plate - 0.5) * 2} h={1.2} s={STONE} u={u} />
          <Crenels x0={-plate + 0.5} y0={plate - 0.95} w={(plate - 0.5) * 2} d={0.45} z={1.2} s={STONE} u={u} step={0.6} />
          <Gate x={plate - 0.95} u={u} />
          {level >= 3 ? (
            <g className={rise(3)}>
              <Tower x={-plate + 0.2} y={plate - 1.3} size={1.1} h={2.8} roof={level >= 4 ? color : undefined} u={u} />
              <Tower x={plate - 1.3} y={plate - 1.3} size={1.1} h={2.8} roof={level >= 4 ? color : undefined} u={u} />
              <Tower x={plate - 1.3} y={-plate + 0.2} size={1.1} h={2.8} roof={level >= 4 ? color : undefined} u={u} />
            </g>
          ) : null}
          {level >= 4 ? <Banner x={plate - 0.75} y={plate - 0.75} z={4.6} color={color} u={u} len={1.6} /> : null}
          {level >= 5 ? <Banner x={-plate + 0.75} y={plate - 0.75} z={4.6} color="#c99a2e" u={u} len={1.6} /> : null}
        </g>
      )}
    </g>
  );
}

function Gate({ x, u }: { x: number; u: number }) {
  const a = P(x + 0.45, -0.45, 0, u);
  const b = P(x + 0.45, 0.45, 0, u);
  const c = P(x + 0.45, 0.45, 0.8, u);
  const d = P(x + 0.45, -0.45, 0.8, u);
  return <polygon points={pts([a, b, c, d])} fill="#5a432c" stroke={EDGE} strokeWidth="0.6" />;
}

// ---------------------------------------------------------------------------
// The centre of the commonwealth (ADR-0034): the palace, the library, the archive
// ---------------------------------------------------------------------------
/** Light limestone of the three buildings of the centre, the dark slate of their roofs and their few accents. */
export const LIME: Shade = { top: '#f1ebdd', left: '#d9d0bb', right: '#b9ae96' };
export const LIME_DARK: Shade = { top: '#d6cdb8', left: '#b5aa92', right: '#958a74' };
export const SLATE_ROOF: Shade = { top: '#6b7790', left: '#57627a', right: '#3d4658' };
const OLD_GOLD = '#c99a2e';
const BRONZE = '#8a6436';
const BURGUNDY = '#6e2233';
const DEEP_GREEN = '#2c5a49';
const GLOW = '#f3cf7a';
const SHADOW = '#2c2418';

type Face = 'left' | 'right';
/** A point on a wall. A `left` wall is the plane y = at (`a` runs along x); a `right` wall is the plane x = at (`a` runs along y). */
const onFace = (face: Face, at: number, u: number) => (a: number, z: number) => (face === 'left' ? P(a, at, z, u) : P(at, a, z, u));

/** A lancet — a pointed window or door — on a wall, `w` wide and `h` tall from `z`. */
export function Lancet({ face, at, a, w, z, h, u = 1, fill = GLOW, className }: { face: Face; at: number; a: number; w: number; z: number; h: number; u?: number; fill?: string; className?: string }) {
  const f = onFace(face, at, u);
  const k = Math.max(0, h - w * 1.1);
  const m = (h - k) * 0.6;
  return (
    <polygon
      className={className}
      points={pts([f(a, z), f(a + w, z), f(a + w, z + k), f(a + w * 0.86, z + k + m), f(a + w / 2, z + h), f(a + w * 0.14, z + k + m), f(a, z + k)])}
      fill={fill}
      stroke={EDGE}
      strokeWidth="0.7"
      strokeLinejoin="round"
    />
  );
}
/** A round-headed door on a wall. */
export function Arch({ face, at, a, w, z, h, u = 1, fill = SHADOW, className }: { face: Face; at: number; a: number; w: number; z: number; h: number; u?: number; fill?: string; className?: string }) {
  const f = onFace(face, at, u);
  const r = w / 2;
  const top = [0, 1, 2, 3, 4, 5, 6].map((i) => f(a + r + r * Math.cos((i / 6) * Math.PI), z + h - r + r * Math.sin((i / 6) * Math.PI)));
  return <polygon className={className} points={pts([f(a, z), f(a + w, z), ...top])} fill={fill} stroke={EDGE} strokeWidth="0.7" strokeLinejoin="round" />;
}
/** A disc on a wall: a round window, a medallion, a seal. */
export function Disc({ face, at, a, z, r, u = 1, fill, stroke = EDGE, strokeWidth = 0.7, className }: { face: Face; at: number; a: number; z: number; r: number; u?: number; fill: string; stroke?: string; strokeWidth?: number; className?: string }) {
  const f = onFace(face, at, u);
  const ring = Array.from({ length: 18 }, (_, i) => f(a + r * Math.cos((i / 18) * Math.PI * 2), z + r * Math.sin((i / 18) * Math.PI * 2)));
  return <polygon className={className} points={pts(ring)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />;
}
/** A flat rectangle on a wall: a slit window, an iron band, a hanging cloth. */
export function Panel({ face, at, a, w, z, h, u = 1, fill, stroke = EDGE, className }: { face: Face; at: number; a: number; w: number; z: number; h: number; u?: number; fill: string; stroke?: string; className?: string }) {
  const f = onFace(face, at, u);
  return <polygon className={className} points={pts([f(a, z), f(a + w, z), f(a + w, z + h), f(a, z + h)])} fill={fill} stroke={stroke} strokeWidth="0.6" strokeLinejoin="round" />;
}
/**
 * A ridge roof over a w×d footprint at height z. `along` is the axis of the ridge. The slope that
 * faces the viewer takes the roof shade; the gable end that faces the viewer is a wall and takes `end`.
 */
export function Gable({ x0, y0, w, d, z, h, s, end, along, u = 1 }: { x0: number; y0: number; w: number; d: number; z: number; h: number; s: Shade; end: Shade; along: 'x' | 'y'; u?: number }) {
  const x1 = x0 + w;
  const y1 = y0 + d;
  const xm = x0 + w / 2;
  const ym = y0 + d / 2;
  return along === 'y' ? (
    <g strokeWidth="0.8" stroke={EDGE} strokeLinejoin="round">
      <polygon points={pts([P(x0, y0, z, u), P(x0, y1, z, u), P(xm, y1, z + h, u), P(xm, y0, z + h, u)])} fill={s.top} />
      <polygon points={pts([P(x1, y0, z, u), P(x1, y1, z, u), P(xm, y1, z + h, u), P(xm, y0, z + h, u)])} fill={s.right} />
      <polygon points={pts([P(x0, y1, z, u), P(x1, y1, z, u), P(xm, y1, z + h, u)])} fill={end.left} />
    </g>
  ) : (
    <g strokeWidth="0.8" stroke={EDGE} strokeLinejoin="round">
      <polygon points={pts([P(x0, y0, z, u), P(x1, y0, z, u), P(x1, ym, z + h, u), P(x0, ym, z + h, u)])} fill={s.top} />
      <polygon points={pts([P(x0, y1, z, u), P(x1, y1, z, u), P(x1, ym, z + h, u), P(x0, ym, z + h, u)])} fill={s.left} />
      <polygon points={pts([P(x1, y0, z, u), P(x1, y1, z, u), P(x1, ym, z + h, u)])} fill={end.right} />
    </g>
  );
}
/** A flight of `n` steps that goes down from (x0, y0) along +x or +y; `span` is its width. */
export function Steps({ x0, y0, span, z0 = 0, n, rise, run, dir, s, u = 1 }: { x0: number; y0: number; span: number; z0?: number; n: number; rise: number; run: number; dir: 'x' | 'y'; s: Shade; u?: number }) {
  return (
    <g>
      {Array.from({ length: n }, (_, i) =>
        dir === 'x' ? (
          <Box key={i} x0={x0 + i * run} y0={y0} w={run} d={span} z0={z0} h={(n - i) * rise} s={s} u={u} />
        ) : (
          <Box key={i} x0={x0} y0={y0 + i * run} w={span} d={run} z0={z0} h={(n - i) * rise} s={s} u={u} />
        ),
      )}
    </g>
  );
}
/** A gold ball on a short rod: the finial of a spire. */
function Finial({ x, y, z, u, r = 0.16 }: { x: number; y: number; z: number; u: number; r?: number }) {
  const a = P(x, y, z, u);
  return (
    <g>
      <line x1={a.x} y1={a.y} x2={a.x} y2={a.y - u * 0.45} stroke={EDGE} strokeWidth="1" />
      <circle cx={a.x} cy={a.y - u * 0.5} r={Math.max(1.2, u * r)} fill={OLD_GOLD} stroke={EDGE} strokeWidth="0.6" />
    </g>
  );
}
/** A square tower of the centre: limestone shaft, a cornice, lit windows, a slate spire with a gold finial. */
function Spired({ x, y, size, h, u, spire = 1.5, z0 = 0, windows = true }: { x: number; y: number; size: number; h: number; u: number; spire?: number; z0?: number; windows?: boolean }) {
  const win = size * 0.26;
  return (
    <g>
      <Box x0={x} y0={y} w={size} d={size} z0={z0} h={h} s={LIME} u={u} />
      <Box x0={x - 0.1} y0={y - 0.1} w={size + 0.2} d={size + 0.2} z0={z0 + h} h={0.16} s={LIME_DARK} u={u} />
      {windows ? (
        <g>
          <Lancet className="realm-window" face="left" at={y + size} a={x + (size - win) / 2} w={win} z={z0 + h * 0.58} h={win * 2.6} u={u} />
          <Lancet className="realm-window" face="right" at={x + size} a={y + (size - win) / 2} w={win} z={z0 + h * 0.58} h={win * 2.6} u={u} />
        </g>
      ) : null}
      <Roof x0={x - 0.14} y0={y - 0.14} w={size + 0.28} d={size + 0.28} z={z0 + h + 0.16} h={size * spire} s={SLATE_ROOF} u={u} />
      <Finial x={x + size / 2} y={y + size / 2} z={z0 + h + 0.16 + size * spire} u={u} />
    </g>
  );
}
/**
 * The seal of the commonwealth on a wall: a gold ring with one stud per civilization around one
 * field — the Round Table seen from above; no civilization stands above another.
 */
function Seal({ face, at, a, z, r, u, field = BURGUNDY }: { face: Face; at: number; a: number; z: number; r: number; u: number; field?: string }) {
  const f = onFace(face, at, u);
  return (
    <g>
      <Disc face={face} at={at} a={a} z={z} r={r} u={u} fill={field} stroke={OLD_GOLD} strokeWidth={Math.max(1.2, u * 0.1)} />
      {[0, 1, 2, 3, 4].map((i) => {
        const p = f(a + r * 0.55 * Math.sin((i / 5) * Math.PI * 2), z + r * 0.55 * Math.cos((i / 5) * Math.PI * 2));
        return <circle key={i} cx={p.x} cy={p.y} r={Math.max(0.7, u * 0.05)} fill={OLD_GOLD} />;
      })}
    </g>
  );
}

/**
 * «Дворец Большого Круглого стола» (ADR-0034): a palace-fortress in the middle of the map. The
 * donjon is the tallest thing on it, the great hall of the Council the most massive; a walled ward
 * with four corner towers of different heights, a gatehouse and a ceremonial flight of steps stands
 * on a stone terrace. Painter's order runs from the far corner to the near one.
 */
export function IsoCouncil({ u }: { u: number }) {
  const T = 0.5; // the terrace
  const bays = [0, 1, 2, 3, 4, 5, 6].map((i) => -2.72 + i * 0.78);
  return (
    <g className="realm-building realm-palace">
      <Plate r={5.6} u={u} s={{ top: '#cbc3ae', left: '#8a7355', right: '#735e44' }} />
      <Box x0={-4.9} y0={-4.9} w={9.8} d={9.8} h={T} s={LIME_DARK} u={u} />
      <Steps x0={4.9} y0={-1.3} span={2.6} n={2} rise={T / 3} run={0.34} dir="x" s={LIME} u={u} />
      <g transform={`translate(0,${(-T * u).toFixed(1)})`}>
        {/* the far walls and the far tower */}
        <Box x0={-4.3} y0={-4.3} w={8.6} d={0.5} h={1.5} s={LIME_DARK} u={u} />
        <Box x0={-4.3} y0={-4.3} w={0.5} d={8.6} h={1.5} s={LIME_DARK} u={u} />
        <Spired x={-4.75} y={-4.75} size={1.5} h={5.4} u={u} />
        <Banner x={-4} y={-4} z={8.4} color={BURGUNDY} u={u} len={1.5} />
        <Spired x={3.25} y={-4.75} size={1.5} h={4.5} u={u} />
        <Spired x={-4.75} y={3.25} size={1.5} h={3.8} u={u} />

        {/* the donjon: behind the ridge of the hall, at its far end, so the far tower is seen beside it */}
        <Box x0={-1.4} y0={-3.5} w={1.8} d={1.8} h={8.2} s={LIME} u={u} />
        <Box x0={-1.5} y0={-3.6} w={2} d={2} z0={6.1} h={0.18} s={LIME_DARK} u={u} />
        {[0.28, 1.02].map((o) => (
          <g key={o}>
            <Lancet className="realm-window" face="left" at={-1.7} a={-1.4 + o} w={0.5} z={6.5} h={1.4} u={u} />
            <Lancet className="realm-window" face="right" at={0.4} a={-3.5 + o} w={0.5} z={6.5} h={1.4} u={u} />
          </g>
        ))}
        <Box x0={-1.52} y0={-3.62} w={2.04} d={2.04} z0={8.2} h={0.2} s={LIME_DARK} u={u} />
        <Crenels x0={-1.52} y0={-3.62} w={2.04} d={2.04} z={8.4} s={LIME} u={u} step={0.51} />
        <Spired x={-1.1} y={-3.2} size={1.2} z0={8.4} h={1.2} u={u} spire={2.3} />
        <Banner x={-0.5} y={-2.6} z={12.9} color={OLD_GOLD} u={u} len={1.9} />

        {/* the great hall of the Council: buttresses and lancets on the long side, the show front under the gable */}
        <Box x0={-1.4} y0={-3} w={4} d={5.8} h={3} s={LIME} u={u} />
        {bays.map((y, i) =>
          i === 3 ? null : <Lancet key={y} className="realm-window" face="right" at={2.6} a={y + 0.16} w={0.42} z={0.9} h={1.6} u={u} />,
        )}
        {[...bays, 2.74].map((y) => (
          <Box key={`b${y}`} x0={2.6} y0={y - 0.07} w={0.17} d={0.14} h={2.55} s={LIME_DARK} u={u} />
        ))}
        <Lancet face="left" at={2.8} a={0.1} w={1} z={0} h={2.05} u={u} fill={BRONZE} />
        <Lancet className="realm-window" face="left" at={2.8} a={-1.02} w={0.46} z={0.85} h={1.55} u={u} />
        <Lancet className="realm-window" face="left" at={2.8} a={1.76} w={0.46} z={0.85} h={1.55} u={u} />
        <Gable x0={-1.56} y0={-3.16} w={4.32} d={6.12} z={3} h={2.25} s={SLATE_ROOF} end={LIME} along="y" u={u} />
        <Disc className="realm-window" face="left" at={2.96} a={0.6} z={3.72} r={0.46} u={u} fill={GLOW} stroke={OLD_GOLD} strokeWidth={Math.max(1, u * 0.07)} />
        <Finial x={0.6} y={2.96} z={5.25} u={u} r={0.12} />
        <Steps x0={-0.05} y0={2.8} span={1.3} n={2} rise={0.12} run={0.22} dir="y" s={LIME} u={u} />

        {/* the near walls, the gatehouse and the near tower */}
        <Box x0={-3.25} y0={3.8} w={7.05} d={0.5} h={1.5} s={LIME} u={u} />
        <Crenels x0={-3.25} y0={3.8} w={7.05} d={0.5} z={1.5} s={LIME} u={u} step={0.55} />
        <Box x0={3.8} y0={-3.25} w={0.5} d={7.05} h={1.5} s={LIME} u={u} />
        <Crenels x0={3.8} y0={-3.25} w={0.5} d={7.05} z={1.5} s={LIME} u={u} step={0.55} />
        <Spired x={3.5} y={-1.9} size={0.8} h={3.1} u={u} windows={false} spire={1.7} />
        <Box x0={3.55} y0={-1.15} w={1.05} d={2.3} h={2.7} s={LIME} u={u} />
        <Crenels x0={3.55} y0={-1.15} w={1.05} d={2.3} z={2.7} s={LIME} u={u} step={0.46} />
        <Lancet face="right" at={4.6} a={-0.52} w={1.04} z={0} h={1.75} u={u} fill={SHADOW} />
        <Lancet className="realm-gate-light" face="right" at={4.6} a={-0.36} w={0.72} z={0} h={1.4} u={u} fill={GLOW} />
        <Seal face="right" at={4.6} a={0} z={2.2} r={0.3} u={u} />
        <Spired x={3.5} y={1.1} size={0.8} h={3.1} u={u} windows={false} spire={1.7} />
        <Banner x={4.1} y={0} z={2.9} color={BURGUNDY} u={u} len={1.5} />
        <Spired x={3.25} y={3.25} size={1.5} h={2.5} u={u} spire={1.1} />
      </g>
    </g>
  );
}

/**
 * «Великая библиотека» (ADR-0017, ADR-0034): a temple of knowledge. A tall nave between two towers,
 * low wings of reading rooms, a wide flight of steps and three pointed portals — one per hall:
 * Летопись, Библиотека решений, Высший Архив — each under its own medallion.
 */
const HALL_MEDAL = [BRONZE, DEEP_GREEN, BURGUNDY];
export function IsoLibrary({ u = 10 }: { u?: number }) {
  const S = 0.4; // the stylobate
  return (
    <g className="realm-building realm-library">
      <Plate r={3.9} u={u} s={{ top: '#bccf9f', left: '#8a7355', right: '#735e44' }} />
      <Box x0={-3.4} y0={-2.7} w={6.8} d={5.4} h={S} s={LIME_DARK} u={u} />
      <Steps x0={-1.7} y0={2.7} span={3.4} n={2} rise={S / 3} run={0.32} dir="y" s={LIME} u={u} />
      <g transform={`translate(0,${(-S * u).toFixed(1)})`}>
        {/* the left wing and the left tower */}
        <Box x0={-3.2} y0={-1.9} w={1.7} d={3.1} h={2} s={LIME} u={u} />
        <Lancet className="realm-window" face="left" at={1.2} a={-3.02} w={0.34} z={0.5} h={1.2} u={u} />
        <Gable x0={-3.3} y0={-2} w={1.9} d={3.3} z={2} h={0.9} s={SLATE_ROOF} end={LIME} along="y" u={u} />
        <Spired x={-2.5} y={0.85} size={1} h={4.1} u={u} spire={1.6} />
        {/* the nave: its gable looks at the square */}
        <Box x0={-1.5} y0={-2.3} w={3} d={3.9} h={3.3} s={LIME} u={u} />
        <Gable x0={-1.62} y0={-2.42} w={3.24} d={4.14} z={3.3} h={2.1} s={SLATE_ROOF} end={LIME} along="y" u={u} />
        <Disc className="realm-window" face="left" at={1.72} a={0} z={4.02} r={0.44} u={u} fill={GLOW} stroke={OLD_GOLD} strokeWidth={Math.max(1, u * 0.08)} />
        <Finial x={0} y={1.72} z={5.4} u={u} r={0.13} />
        {[-1.02, 0, 1.02].map((x, i) => (
          <g key={x}>
            <Lancet className={`realm-library-door d${i}`} face="left" at={1.6} a={x - 0.36} w={0.72} z={0} h={1.75} u={u} fill={SHADOW} />
            <Disc face="left" at={1.6} a={x} z={2.25} r={0.19} u={u} fill={HALL_MEDAL[i]!} stroke={OLD_GOLD} strokeWidth={Math.max(0.8, u * 0.05)} />
          </g>
        ))}
        <Panel face="left" at={1.6} a={-1.5} w={3} z={2.62} h={0.14} u={u} fill={LIME_DARK.left} />
        {/* the right wing: tall windows of the reading rooms; then the right tower */}
        <Box x0={1.5} y0={-1.9} w={1.7} d={3.1} h={2} s={LIME} u={u} />
        {[-1.55, -0.6, 0.35].map((y) => (
          <Lancet key={y} className="realm-window" face="right" at={3.2} a={y} w={0.4} z={0.45} h={1.25} u={u} />
        ))}
        <Gable x0={1.4} y0={-2} w={1.9} d={3.3} z={2} h={0.9} s={SLATE_ROOF} end={LIME} along="y" u={u} />
        <Spired x={1.5} y={0.85} size={1} h={4.1} u={u} spire={1.6} />
        <Banner x={2} y={1.35} z={6.2} color={DEEP_GREEN} u={u} len={1.5} />
      </g>
    </g>
  );
}

/**
 * «Высший Архив» (ADR-0034): a treasury, not one more library. A stepped footing, blind walls
 * between dark corner piers, slits instead of windows, closed bronze doors with iron bands and the
 * seal of approved heritage above them. The drawing says nothing about any record: what is kept
 * here is decided only by the server workflow.
 */
export function IsoArchive({ u }: { u: number }) {
  const F = 0.55; // the footing
  const pier = (x: number, y: number) => (
    <g key={`${x}:${y}`}>
      <Box x0={x} y0={y} w={0.62} d={0.62} h={2.55} s={LIME_DARK} u={u} />
      <Box x0={x - 0.06} y0={y - 0.06} w={0.74} d={0.74} z0={2.55} h={0.12} s={LIME} u={u} />
    </g>
  );
  return (
    <g className="realm-building realm-archive">
      <Plate r={3} u={u} s={{ top: '#cfc8b6', left: '#8a7355', right: '#735e44' }} />
      <Box x0={-2.4} y0={-2.4} w={4.8} d={4.8} h={0.3} s={LIME_DARK} u={u} />
      <Box x0={-2.1} y0={-2.1} w={4.2} d={4.2} z0={0.3} h={0.25} s={LIME_DARK} u={u} />
      <Steps x0={-0.75} y0={2.1} span={1.5} n={3} rise={F / 4} run={0.24} dir="y" s={LIME} u={u} />
      <g transform={`translate(0,${(-F * u).toFixed(1)})`}>
        {pier(-1.9, -1.9)}
        {pier(1.28, -1.9)}
        {pier(-1.9, 1.28)}
        <Box x0={-1.6} y0={-1.6} w={3.2} d={3.2} h={2.4} s={LIME} u={u} />
        {[-0.95, -0.1, 0.75].map((y) => (
          <Panel key={y} className="realm-window" face="right" at={1.6} a={y} w={0.12} z={1.45} h={0.6} u={u} fill={GLOW} />
        ))}
        {/* the portal: closed doors */}
        <Arch face="left" at={1.6} a={-0.62} w={1.24} z={0} h={1.82} u={u} fill={LIME_DARK.left} />
        <Arch face="left" at={1.6} a={-0.45} w={0.9} z={0} h={1.6} u={u} fill={BRONZE} />
        {[0.42, 0.84, 1.2].map((z) => (
          <Panel key={z} face="left" at={1.6} a={-0.45} w={0.9} z={z} h={0.06} u={u} fill={SHADOW} stroke="none" />
        ))}
        <Panel face="left" at={1.6} a={-0.02} w={0.04} z={0} h={1.56} u={u} fill={SHADOW} stroke="none" />
        {pier(1.28, 1.28)}
        <Panel face="left" at={1.9} a={-1.78} w={0.36} z={0.75} h={1.55} u={u} fill={BURGUNDY} />
        <Panel face="left" at={1.9} a={1.41} w={0.36} z={0.75} h={1.55} u={u} fill={BURGUNDY} />
        {/* the cornice, the attic with the seal, the low slate roof */}
        <Box x0={-1.78} y0={-1.78} w={3.56} d={3.56} z0={2.4} h={0.22} s={LIME_DARK} u={u} />
        <Box x0={-1.25} y0={-1.25} w={2.5} d={2.5} z0={2.62} h={0.62} s={LIME} u={u} />
        <Seal face="left" at={1.25} a={0} z={2.93} r={0.24} u={u} />
        <Box x0={-1.35} y0={-1.35} w={2.7} d={2.7} z0={3.24} h={0.12} s={LIME_DARK} u={u} />
        <Roof x0={-1.35} y0={-1.35} w={2.7} d={2.7} z={3.36} h={1.05} s={SLATE_ROOF} u={u} />
        <Finial x={0} y={0} z={4.41} u={u} />
      </g>
    </g>
  );
}
