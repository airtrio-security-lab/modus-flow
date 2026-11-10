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

/** The council hall in the middle of the map. */
export function IsoCouncil({ u }: { u: number }) {
  const gold = '#c99a2e';
  return (
    <g>
      <Plate r={4.6} u={u} s={{ top: '#c9c1ad', left: '#8a7355', right: '#735e44' }} />
      <Box x0={-3.6} y0={-3.6} w={7.2} d={0.5} h={1.4} s={STONE_DARK} u={u} />
      <Box x0={-3.6} y0={-3.6} w={0.5} d={7.2} h={1.4} s={STONE_DARK} u={u} />
      <Tower x={-3.9} y={-3.9} size={1.3} h={4} roof={gold} u={u} />
      <Box x0={-1.8} y0={-1.8} w={3.6} d={3.6} h={3.4} s={STONE} u={u} />
      <Roof x0={-2} y0={-2} w={4} d={4} z={3.4} h={2.6} s={shadeOf(gold)} u={u} />
      <Banner x={0} y={0} z={6} color={gold} u={u} len={2.4} />
      <Box x0={-3.6} y0={3.1} w={7.2} d={0.5} h={1.4} s={STONE} u={u} />
      <Box x0={3.1} y0={-3.6} w={0.5} d={7.2} h={1.4} s={STONE} u={u} />
      <Gate x={3.1} u={u} />
      <Tower x={-3.9} y={2.6} size={1.3} h={4} roof={gold} u={u} />
      <Tower x={2.6} y={2.6} size={1.3} h={4} roof={gold} u={u} />
      <Tower x={2.6} y={-3.9} size={1.3} h={4} roof={gold} u={u} />
    </g>
  );
}
