import type { ReactNode } from 'react';
import { Banner, Box, IsoCastle, P, Plate, Roof, STONE, STONE_DARK, TIMBER, shadeOf, type Shade } from './iso';

/**
 * Architectural styles of the districts (ADR-0019, ADR-0020, ADR-0021): Камелот, Японский сёгунат,
 * Казахское ханство, Монгольская держава. Original drawings made of the same isometric primitives —
 * no borrowed game art. Every style has the same five levels and the same number of buildings; a
 * level always looks the same; nothing is random. The style is chosen by the department and says
 * nothing about the people who work there. Names and titles come from the server registry
 * (platform/domain/civilizations.ts); the copy below is only for drawing labels.
 */
export type Civ = 'camelot' | 'japan' | 'mongolia' | 'kazakh' | 'russia';
export const CIVS: { id: Civ; name: string; motto: string; hall: string }[] = [
  { id: 'camelot', name: 'Камелот', motto: 'Рыцарская цивилизация: замок, башни и стены, рыцарский двор, оружейная и мастерские', hall: 'Зал рыцарей' },
  { id: 'japan', name: 'Японский сёгунат', motto: 'Замок, сады и мосты, многоярусные крыши', hall: 'Зал даймё' },
  { id: 'kazakh', name: 'Казахское ханство', motto: 'Большая ханская юрта, ставка и поселение, орнаменты', hall: 'Ханская юрта' },
  { id: 'russia', name: 'Русское царство', motto: 'Москва XVI–XVII веков: Кремль, соборы, боярские палаты и торг', hall: 'Боярская дума' },
  { id: 'mongolia', name: 'Монгольская держава', motto: 'Ставка правителя, юрты, туги и степные сооружения', hall: 'Совет нойонов' },
];
export const civOf = (id: string | null | undefined): Civ => (CIVS.some((c) => c.id === id) ? (id as Civ) : 'camelot');
export const civName = (id: string) => CIVS.find((c) => c.id === civOf(id))!.name;
export const hallName = (id: string | null | undefined) => CIVS.find((c) => c.id === civOf(id))!.hall;
const EDGE = '#4a4034';
const GOLD = '#c99a2e';
const PLATE = [2.6, 3.2, 3.8, 4.4, 5];
/** Height of each style's drawing above the ground per level, in grid units — labels sit above it. */
export const CIV_HEIGHT: Record<Civ, number[]> = {
  camelot: [5, 5.6, 5.6, 8.4, 11],
  japan: [3.6, 4.6, 5.8, 7, 8.6],
  mongolia: [3, 3.2, 3.6, 4.4, 5.6],
  kazakh: [3, 3.2, 4, 5.4, 7],
  russia: [5.2, 5.7, 6.5, 7.6, 9.2],
};

const WHITE: Shade = { top: '#f6f3ea', left: '#ece6d8', right: '#d7cfbd' };
const CLAY: Shade = { top: '#ead6ad', left: '#d9c29a', right: '#bda37a' };
const INK = '#3d4452';

/** A felt yurt standing on grid point (x, y): walls, a low cone roof, a crown ring and an optional ornament band. */
export function Yurt({ x, y, r, h = 0.9, u, felt = '#f3eee2', band, roof = '#e6dcc6', crown = GOLD }: { x: number; y: number; r: number; h?: number; u: number; felt?: string; band?: string; roof?: string; crown?: string }) {
  const c = P(x, y, 0, u);
  const rx = r * u * 1.22;
  const ry = r * u * 0.61;
  const top = c.y - h * u;
  const apex = top - r * u * 0.62;
  const b0 = top + h * u * 0.3;
  const b1 = top + h * u * 0.52;
  return (
    <g stroke={EDGE} strokeWidth="0.8" strokeLinejoin="round">
      <ellipse cx={c.x} cy={c.y + 1} rx={rx + 2} ry={ry + 1} fill="#2d3a22" opacity="0.2" stroke="none" />
      <path d={`M${c.x - rx},${top} L${c.x - rx},${c.y} A${rx},${ry} 0 0 0 ${c.x + rx},${c.y} L${c.x + rx},${top} A${rx},${ry} 0 0 1 ${c.x - rx},${top} Z`} fill={felt} />
      {band ? <path d={`M${c.x - rx},${b0} A${rx},${ry} 0 0 0 ${c.x + rx},${b0} L${c.x + rx},${b1} A${rx},${ry} 0 0 1 ${c.x - rx},${b1} Z`} fill={band} /> : null}
      <path d={`M${c.x - rx * 0.16},${c.y + ry * 0.98} L${c.x - rx * 0.16},${c.y + ry * 0.98 - h * u * 0.62} L${c.x + rx * 0.16},${c.y + ry * 0.98 - h * u * 0.62} L${c.x + rx * 0.16},${c.y + ry * 0.98} Z`} fill="#a2412f" />
      <path d={`M${c.x - rx - 1.2},${top} A${rx + 1.2},${ry + 0.6} 0 0 0 ${c.x + rx + 1.2},${top} L${c.x},${apex} Z`} fill={roof} />
      <ellipse cx={c.x} cy={apex + 1.2} rx={rx * 0.2} ry={ry * 0.2} fill={crown} />
    </g>
  );
}

/** A dome on a drum: grid point (x, y) at height z, radius r. */
export function Dome({ x, y, z, r, u, color = '#3f8f9a', tip = GOLD }: { x: number; y: number; z: number; r: number; u: number; color?: string; tip?: string }) {
  const c = P(x, y, z, u);
  const rx = r * u * 1.22;
  const ry = r * u * 0.61;
  const s = shadeOf(color);
  return (
    <g stroke={EDGE} strokeWidth="0.8">
      <path d={`M${c.x - rx},${c.y} A${rx},${rx * 1.05} 0 0 1 ${c.x + rx},${c.y} A${rx},${ry} 0 0 1 ${c.x - rx},${c.y} Z`} fill={s.left} />
      <path d={`M${c.x},${c.y - rx * 1.05} A${rx},${rx * 1.05} 0 0 1 ${c.x + rx},${c.y} A${rx},${ry} 0 0 1 ${c.x},${c.y + ry}`} fill={s.right} opacity="0.55" stroke="none" />
      <line x1={c.x} y1={c.y - rx * 1.05} x2={c.x} y2={c.y - rx * 1.05 - u * 0.9} />
      <circle cx={c.x} cy={c.y - rx * 1.05 - u * 0.9} r={u * 0.18} fill={tip} />
    </g>
  );
}

/** A Japanese storey: white walls and a dark roof with wide eaves. */
function Tier({ c, w, z, h, u, roof = INK, gold = false }: { c: number; w: number; z: number; h: number; u: number; roof?: string; gold?: boolean }) {
  return (
    <g>
      <Box x0={c - w / 2} y0={c - w / 2} w={w} d={w} z0={z} h={h} s={WHITE} u={u} />
      <Roof x0={c - w / 2 - 0.45} y0={c - w / 2 - 0.45} w={w + 0.9} d={w + 0.9} z={z + h} h={0.85} s={shadeOf(gold ? GOLD : roof)} u={u} />
    </g>
  );
}

/** A small corner turret (yagura). */
function Yagura({ x, y, u }: { x: number; y: number; u: number }) {
  return (
    <g>
      <Box x0={x} y0={y} w={0.9} d={0.9} h={0.7} s={STONE} u={u} />
      <Box x0={x + 0.1} y0={y + 0.1} w={0.7} d={0.7} z0={0.7} h={0.8} s={WHITE} u={u} />
      <Roof x0={x - 0.15} y0={y - 0.15} w={1.2} d={1.2} z={1.5} h={0.7} s={shadeOf(INK)} u={u} />
    </g>
  );
}

function JapaneseCastle({ level, color, u }: { level: number; color: string; u: number }) {
  const plate = PLATE[level - 1]!;
  const tiers = [1, 2, 3, 4, 5][level - 1]!;
  const widths = level === 1 ? [1.9] : [2.6, 2.1, 1.7, 1.35, 1.05];
  const parts: ReactNode[] = [];
  let z = level >= 2 ? 0.9 : 0;
  for (let i = 0; i < tiers; i++) {
    const h = i === 0 ? 1.2 : 0.95;
    parts.push(<Tier key={i} c={0} w={widths[i]!} z={z} h={h} u={u} gold={level >= 5 && i === tiers - 1} />);
    z += h + 0.55;
  }
  return (
    <g>
      {level >= 5 ? <ellipse cx="0" cy={u * 0.4} rx={u * 7.5} ry={u * 3.9} fill="url(#realm-glow)" /> : null}
      <Plate r={plate} u={u} />
      {/* back garden wall */}
      {level >= 3 ? (
        <g>
          <Box x0={-plate + 0.5} y0={-plate + 0.5} w={(plate - 0.5) * 2} d={0.35} h={0.9} s={WHITE} u={u} />
          <Box x0={-plate + 0.5} y0={-plate + 0.5} w={0.35} d={(plate - 0.5) * 2} h={0.9} s={WHITE} u={u} />
        </g>
      ) : null}
      {level >= 4 ? <Yagura x={-plate + 0.4} y={-plate + 0.4} u={u} /> : null}
      {level >= 2 ? <Box x0={-1.7} y0={-1.7} w={3.4} d={3.4} h={0.9} s={STONE_DARK} u={u} /> : null}
      {parts}
      {level >= 3 ? <Yagura x={plate - 1.4} y={plate - 1.4} u={u} /> : null}
      {level >= 4 ? <Yagura x={plate - 1.4} y={-plate + 0.4} u={u} /> : null}
      {level >= 3 ? (
        <g>
          <Box x0={-plate + 0.5} y0={plate - 0.85} w={(plate - 0.5) * 2 - 1.5} d={0.35} h={0.9} s={WHITE} u={u} />
          <Box x0={plate - 0.85} y0={-plate + 0.5} w={0.35} d={(plate - 0.5) * 2 - 1.5} h={0.9} s={WHITE} u={u} />
        </g>
      ) : (
        // Level 1–2: a bamboo fence and a small pond.
        <g>
          <Box x0={-plate + 0.4} y0={plate - 0.6} w={(plate - 0.4) * 2} d={0.2} h={0.6} s={TIMBER} u={u} />
          <ellipse cx={P(1.7, -1.7, 0, u).x} cy={P(1.7, -1.7, 0, u).y} rx={u * 0.9} ry={u * 0.45} fill="#7fb0c4" stroke={EDGE} strokeWidth="0.6" />
        </g>
      )}
      {/* A nobori banner at the gate. */}
      <Banner x={plate - 0.5} y={plate - 0.5} z={0} color={color} u={u} len={2.4} />
      {level >= 5 ? (
        // A garden pond with an arched bridge in front of the gate.
        <g>
          <ellipse cx={P(plate + 1.1, plate + 1.1, 0, u).x} cy={P(plate + 1.1, plate + 1.1, 0, u).y} rx={u * 1.7} ry={u * 0.8} fill="#7fb0c4" stroke={EDGE} strokeWidth="0.6" />
          <path d={`M${P(plate + 1.1, plate + 1.1, 0, u).x - u * 1.5},${P(plate + 1.1, plate + 1.1, 0, u).y} Q${P(plate + 1.1, plate + 1.1, 0, u).x},${P(plate + 1.1, plate + 1.1, 0, u).y - u * 1.3} ${P(plate + 1.1, plate + 1.1, 0, u).x + u * 1.5},${P(plate + 1.1, plate + 1.1, 0, u).y}`} fill="none" stroke="#a2412f" strokeWidth={u * 0.28} strokeLinecap="round" />
        </g>
      ) : null}
    </g>
  );
}

/** Tug: a pole with a horsehair tassel standard. */
function Tug({ x, y, u, color = '#2d2a24' }: { x: number; y: number; u: number; color?: string }) {
  const b = P(x, y, 0, u);
  const t = P(x, y, 3.2, u);
  return (
    <g>
      <line x1={b.x} y1={b.y} x2={t.x} y2={t.y} stroke={EDGE} strokeWidth="1.3" />
      <path d={`M${t.x - u * 0.35},${t.y + u * 0.3} Q${t.x},${t.y + u * 1.6} ${t.x + u * 0.35},${t.y + u * 0.3} Z`} fill={color} stroke={EDGE} strokeWidth="0.6" />
      <circle cx={t.x} cy={t.y} r={u * 0.18} fill={GOLD} />
    </g>
  );
}

function Palisade({ r, u }: { r: number; u: number }) {
  return (
    <g>
      <Box x0={-r} y0={-r} w={r * 2} d={0.25} h={0.8} s={TIMBER} u={u} />
      <Box x0={-r} y0={-r} w={0.25} d={r * 2} h={0.8} s={TIMBER} u={u} />
    </g>
  );
}
function PalisadeFront({ r, u }: { r: number; u: number }) {
  return (
    <g>
      <Box x0={-r} y0={r - 0.25} w={r * 2 - 1.2} d={0.25} h={0.8} s={TIMBER} u={u} />
      <Box x0={r - 0.25} y0={-r} w={0.25} d={r * 2 - 1.2} h={0.8} s={TIMBER} u={u} />
    </g>
  );
}

function MongolCamp({ level, color, u }: { level: number; color: string; u: number }) {
  const plate = PLATE[level - 1]!;
  const ring: [number, number][] = [[-1.6, -1.4], [1.5, -1.6], [-1.7, 1.5], [1.6, 1.4]];
  const small = level >= 4 ? ring : level === 3 ? ring.slice(0, 2) : level === 2 ? ring.slice(0, 1) : [];
  return (
    <g>
      {level >= 5 ? <ellipse cx="0" cy={u * 0.4} rx={u * 7.5} ry={u * 3.9} fill="url(#realm-glow)" /> : null}
      <Plate r={plate} u={u} s={{ top: '#c9cf9b', left: '#8a7355', right: '#735e44' }} />
      {level >= 3 ? <Palisade r={plate - 0.4} u={u} /> : null}
      {small.filter(([, y]) => y < 0).map(([x, y]) => <Yurt key={`${x}${y}`} x={x} y={y} r={0.75} u={u} band={level >= 4 ? color : undefined} />)}
      <Yurt x={0} y={0} r={level >= 5 ? 1.7 : level >= 4 ? 1.35 : 1.05} h={level >= 5 ? 1.4 : 1.05} u={u} band={level >= 2 ? color : undefined} crown={level >= 5 ? GOLD : '#8a6440'} roof={level >= 5 ? '#efe6cf' : undefined} />
      {small.filter(([, y]) => y >= 0).map(([x, y]) => <Yurt key={`${x}${y}`} x={x} y={y} r={0.75} u={u} band={level >= 4 ? color : undefined} />)}
      <Tug x={plate - 0.8} y={-0.6} u={u} color={level >= 5 ? '#f4efe2' : '#2d2a24'} />
      {level >= 4 ? <Tug x={-0.6} y={plate - 0.8} u={u} /> : null}
      {level >= 3 ? <PalisadeFront r={plate - 0.4} u={u} /> : <Box x0={-plate + 0.5} y0={plate - 0.6} w={1.6} d={0.2} h={0.5} s={TIMBER} u={u} />}
      {level >= 5 ? <Banner x={0} y={0} z={3.6} color={GOLD} u={u} /> : null}
    </g>
  );
}

function KazakhOrda({ level, color, u }: { level: number; color: string; u: number }) {
  const plate = PLATE[level - 1]!;
  const band = '#a2412f';
  return (
    <g>
      {level >= 5 ? <ellipse cx="0" cy={u * 0.4} rx={u * 7.5} ry={u * 3.9} fill="url(#realm-glow)" /> : null}
      <Plate r={plate} u={u} s={{ top: '#d6c99c', left: '#8a7355', right: '#735e44' }} />
      {/* Caravanserai walls from level 3. */}
      {level >= 3 ? (
        <g>
          <Box x0={-plate + 0.4} y0={-plate + 0.4} w={(plate - 0.4) * 2} d={0.45} h={1.1} s={CLAY} u={u} />
          <Box x0={-plate + 0.4} y0={-plate + 0.4} w={0.45} d={(plate - 0.4) * 2} h={1.1} s={CLAY} u={u} />
        </g>
      ) : null}
      {level >= 4 ? (
        <g>
          <Box x0={-2.4} y0={-2.4} w={2} d={2} h={1.6} s={CLAY} u={u} />
          <Box x0={-2.1} y0={-2.1} w={1.4} d={1.4} z0={1.6} h={0.5} s={CLAY} u={u} />
          <Dome x={-1.4} y={-1.4} z={2.1} r={0.75} u={u} color={level >= 5 ? '#2f6f8a' : '#3f8f9a'} />
        </g>
      ) : null}
      {level >= 5 ? (
        <g>
          {[[plate - 1.1, -plate + 0.5], [-plate + 0.5, plate - 1.1]].map(([x, y]) => (
            <g key={`${x}${y}`}>
              <Box x0={x!} y0={y!} w={0.6} d={0.6} h={3.2} s={CLAY} u={u} />
              <Dome x={x! + 0.3} y={y! + 0.3} z={3.2} r={0.38} u={u} />
            </g>
          ))}
        </g>
      ) : null}
      {level >= 2 ? <Box x0={1} y0={-2} w={1.3} d={1.1} h={0.9} s={CLAY} u={u} /> : null}
      <Yurt x={level >= 4 ? 0.9 : 0} y={level >= 4 ? 0.9 : 0} r={level >= 5 ? 1.4 : 1.05} h={level >= 5 ? 1.25 : 1} u={u} band={band} roof="#efe4cc" crown={GOLD} />
      {level >= 2 ? <Yurt x={-1.6} y={1.4} r={0.7} u={u} band={color} /> : null}
      <Banner x={plate - 0.9} y={0.4} z={0} color={color} u={u} len={2.6} />
      {level >= 3 ? (
        <g>
          <Box x0={-plate + 0.4} y0={plate - 0.85} w={(plate - 0.4) * 2 - 1.6} d={0.45} h={1.1} s={CLAY} u={u} />
          <Box x0={plate - 0.85} y0={-plate + 0.4} w={0.45} d={(plate - 0.4) * 2 - 1.6} h={1.1} s={CLAY} u={u} />
        </g>
      ) : null}
    </g>
  );
}

/** Red-brick Kremlin with white-stone cathedral and gilded domes. Grows with real level. */
function RussianKremlin({ level, color, u }: { level: number; color: string; u: number }) {
  const plate = PLATE[level - 1]!;
  const brick: Shade = { top: '#d66c53', left: '#aa4333', right: '#843228' };
  const green = shadeOf('#3e5949');
  const turret = (x: number, y: number, h: number) => (
    <g key={x + '-' + y}>
      <Box x0={x} y0={y} w={0.65} d={0.65} h={h} s={brick} u={u} />
      <Roof x0={x - 0.12} y0={y - 0.12} w={0.89} d={0.89} z={h} h={0.9} s={green} u={u} />
      <Banner x={x + 0.34} y={y + 0.32} z={h + 0.9} color={color} u={u} len={0.9} />
    </g>
  );
  return (
    <g>
      <Plate r={plate} u={u} s={{ top: '#cbb992', left: '#8c7654', right: '#746242' }} />
      <Box x0={-plate + 0.45} y0={plate - 0.85} w={plate * 2 - 0.9} d={0.45} h={1.5} s={brick} u={u} />
      <Box x0={plate - 0.85} y0={-plate + 0.45} w={0.45} d={plate * 2 - 0.9} h={1.5} s={brick} u={u} />
      {turret(plate - 1.15, plate - 1.15, level >= 4 ? 4.6 : 3.0)}
      {level >= 2 ? turret(-plate + 0.5, plate - 1.15, 2.2) : null}
      {level >= 3 ? turret(plate - 1.15, -plate + 0.5, 2.8) : null}
      {level >= 5 ? turret(-plate + 0.5, -plate + 0.5, 3.5) : null}
      <Box x0={-1.2} y0={-1} w={2.5} d={2.2} h={level >= 4 ? 2.6 : 1.8} s={WHITE} u={u} />
      <Dome x={0.1} y={0.0} z={level >= 4 ? 2.6 : 1.8} r={0.75} color="#daa331" u={u} />
      {level >= 3 ? <Dome x={-0.7} y={-0.3} z={level >= 4 ? 2.6 : 1.8} r={0.35} color="#e5bd4c" u={u} /> : null}
      {level >= 4 ? <Dome x={0.8} y={0.6} z={2.6} r={0.38} color="#e5bd4c" u={u} /> : null}
      {level >= 5 ? <g><Box x0={-2.5} y0={-2.6} w={1.25} d={1.6} h={2.7} s={WHITE} u={u} /><Roof x0={-2.65} y0={-2.75} w={1.55} d={1.9} z={2.7} h={0.9} s={green} u={u} /></g> : null}
    </g>
  );
}

/** The main building of a district in its style. `rising` replays the construction for a new level. */
export function CivCastle({ civ, level, color, u, rising = false }: { civ: string; level: number; color: string; u: number; rising?: boolean }) {
  const lv = Math.min(5, Math.max(1, level));
  if (civ === 'russia') return <g className={rising ? 'iso-rise' : undefined}><RussianKremlin level={lv} color={color} u={u} /></g>;
  if (civ === 'japan') return <g className={rising ? 'iso-rise' : undefined}><JapaneseCastle level={lv} color={color} u={u} /></g>;
  if (civ === 'mongolia') return <g className={rising ? 'iso-rise' : undefined}><MongolCamp level={lv} color={color} u={u} /></g>;
  if (civ === 'kazakh') return <g className={rising ? 'iso-rise' : undefined}><KazakhOrda level={lv} color={color} u={u} /></g>;
  return <IsoCastle level={lv} color={color} u={u} rising={rising} />;
}

/** Houses of the district around the main building: one more with each level (0 at level 1). */
export function DistrictHouses({ civ, level, u, color }: { civ: string; level: number; u: number; color: string }) {
  const plate = PLATE[Math.min(5, Math.max(1, level)) - 1]!;
  const spots: [number, number][] = [[plate + 1.6, -1.8], [-1.8, plate + 1.6], [plate + 1.9, 1.6], [1.6, plate + 1.9]];
  return (
    <g aria-hidden="true">
      {spots.slice(0, Math.max(0, level - 1)).map(([x, y], i) => (
        <g key={`${x}${y}`}>
          {civ === 'mongolia' || civ === 'kazakh' ? (
            <Yurt x={x} y={y} r={0.6} h={0.7} u={u} band={civ === 'kazakh' ? '#a2412f' : undefined} />
          ) : civ === 'russia' ? (
            <g>
              <Box x0={x - 0.65} y0={y - 0.55} w={1.3} d={1.1} h={1.2} s={WHITE} u={u} />
              <Roof x0={x - 0.75} y0={y - 0.65} w={1.5} d={1.3} z={1.2} h={0.7} s={shadeOf('#4d6550')} u={u} />
              {i === 3 ? <Dome x={x} y={y} z={1.9} r={0.38} color="#d9a532" u={u} /> : null}
            </g>
          ) : civ === 'japan' ? (
            <g>
              <Box x0={x - 0.6} y0={y - 0.5} w={1.2} d={1} h={0.8} s={WHITE} u={u} />
              <Roof x0={x - 0.85} y0={y - 0.75} w={1.7} d={1.5} z={0.8} h={0.6} s={shadeOf(INK)} u={u} />
            </g>
          ) : i === 1 ? (
            // Camelot's armory: stone, a forge chimney and a shield over the door.
            <g>
              <Box x0={x - 0.65} y0={y - 0.55} w={1.3} d={1.1} h={0.95} s={STONE} u={u} />
              <Roof x0={x - 0.75} y0={y - 0.65} w={1.5} d={1.3} z={0.95} h={0.6} s={shadeOf('#55606e')} u={u} />
              <Box x0={x + 0.25} y0={y - 0.45} w={0.3} d={0.3} z0={0.95} h={0.9} s={STONE_DARK} u={u} />
              <path d={`M${P(x + 0.65, y, 0.75, u).x - u * 0.22},${P(x + 0.65, y, 0.75, u).y - u * 0.2} h${u * 0.44} v${u * 0.25} q0,${u * 0.25} ${-u * 0.22},${u * 0.35} q${-u * 0.22},${-u * 0.1} ${-u * 0.22},${-u * 0.35} Z`} fill={color} stroke={EDGE} strokeWidth="0.6" />
            </g>
          ) : i === 2 ? (
            // A workshop with an open awning.
            <g>
              <Box x0={x - 0.6} y0={y - 0.5} w={1.2} d={1} h={0.8} s={TIMBER} u={u} />
              <Roof x0={x - 0.7} y0={y - 0.6} w={1.4} d={1.2} z={0.8} h={0.75} s={shadeOf('#8a5a2b')} u={u} />
              <Box x0={x + 0.6} y0={y - 0.5} w={0.5} d={1} z0={0.55} h={0.08} s={shadeOf(color)} u={u} />
            </g>
          ) : (
            <g>
              <Box x0={x - 0.6} y0={y - 0.5} w={1.2} d={1} h={0.8} s={TIMBER} u={u} />
              <Roof x0={x - 0.7} y0={y - 0.6} w={1.4} d={1.2} z={0.8} h={0.75} s={shadeOf(color)} u={u} />
            </g>
          )}
        </g>
      ))}
    </g>
  );
}

/** The Higher Archive: a vaulted treasury of approved knowledge, next to the Great Library. */
export function IsoArchive({ u }: { u: number }) {
  return (
    <g className="realm-archive">
      <Plate r={2.4} u={u} s={{ top: '#d5cfc0', left: '#8a7355', right: '#735e44' }} />
      <Box x0={-1.6} y0={-1.6} w={3.2} d={3.2} h={2.1} s={{ top: '#e9e2d0', left: '#cfc5ad', right: '#ada288' }} u={u} />
      <Dome x={0} y={0} z={2.1} r={1.3} u={u} color="#2f4a7a" />
      <Box x0={1.2} y0={-0.5} w={0.45} d={1} h={1.3} s={{ top: '#5a432c', left: '#5a432c', right: '#46331f' }} u={u} />
    </g>
  );
}

/** The achievements plaza: one pedestal per achievement the castles really earned (up to 12 drawn). */
export function IsoPlaza({ u, count }: { u: number; count: number }) {
  const shown = Math.min(count, 12);
  return (
    <g>
      <Box x0={-2.6} y0={-2.6} w={5.2} d={5.2} z0={-0.15} h={0.15} s={{ top: '#d9d1bd', left: '#b8ad94', right: '#9c917a' }} u={u} />
      <Box x0={-0.35} y0={-0.35} w={0.7} d={0.7} h={2.6} s={STONE} u={u} />
      <Roof x0={-0.4} y0={-0.4} w={0.8} d={0.8} z={2.6} h={0.8} s={shadeOf(GOLD)} u={u} />
      {Array.from({ length: shown }, (_, i) => {
        const a = (i / Math.max(shown, 1)) * Math.PI * 2;
        const x = Math.cos(a) * 1.9;
        const y = Math.sin(a) * 1.9;
        return <Box key={i} x0={x - 0.18} y0={y - 0.18} w={0.36} d={0.36} h={0.6} s={{ top: GOLD, left: '#b0861f', right: '#8f6c17' }} u={u} />;
      })}
    </g>
  );
}

/**
 * The place of a department's small council, in the style of its district: Зал даймё, Ханская юрта,
 * Зал рыцарей, Совет нойонов. Drawn at the grid origin; the same size for every style.
 */
export function CouncilHall({ civ, u, color }: { civ: string; u: number; color: string }) {
  const c = civOf(civ);
  if (c === 'russia')
    return (
      <g>
        <Plate r={1.7} u={u} s={{ top: '#dec5a5', left: '#9b775a', right: '#87664b' }} />
        <Box x0={-1.3} y0={-0.9} w={2.6} d={1.8} h={1.4} s={WHITE} u={u} />
        <Roof x0={-1.45} y0={-1.05} w={2.9} d={2.1} z={1.4} h={0.95} s={shadeOf('#4e694f')} u={u} />
        <Dome x={0} y={0} z={2.35} r={0.35} color="#d9a532" u={u} />
        <Banner x={1.25} y={0.95} z={0} color={color} u={u} len={2.3} />
      </g>
    );
  if (c === 'japan')
    return (
      <g>
        <Plate r={1.7} u={u} s={{ top: '#cfd7b0', left: '#8a7355', right: '#735e44' }} />
        <Box x0={-1.3} y0={-1} w={2.6} d={2} h={0.35} s={STONE_DARK} u={u} />
        <Box x0={-1.15} y0={-0.85} w={2.3} d={1.7} z0={0.35} h={0.9} s={WHITE} u={u} />
        <Roof x0={-1.55} y0={-1.25} w={3.1} d={2.5} z={1.25} h={1.05} s={shadeOf(INK)} u={u} />
        {/* A stone lantern by the entrance. */}
        <Box x0={1.35} y0={1.05} w={0.3} d={0.3} h={0.75} s={STONE} u={u} />
        <Box x0={1.3} y0={1} w={0.4} d={0.4} z0={0.75} h={0.12} s={STONE} u={u} />
        <Banner x={-1.2} y={1.1} z={0} color={color} u={u} len={1.9} />
      </g>
    );
  if (c === 'kazakh')
    return (
      <g>
        <Plate r={1.7} u={u} s={{ top: '#d6c99c', left: '#8a7355', right: '#735e44' }} />
        <Yurt x={0} y={0} r={1.25} h={1.15} u={u} band="#a2412f" roof="#f2e8d0" crown={GOLD} />
        <Banner x={1.25} y={-1.2} z={0} color={color} u={u} len={2.2} />
        <Banner x={-1.2} y={1.25} z={0} color="#2f6f8a" u={u} len={2.2} />
      </g>
    );
  if (c === 'mongolia')
    return (
      <g>
        <Plate r={1.7} u={u} s={{ top: '#c9cf9b', left: '#8a7355', right: '#735e44' }} />
        <Yurt x={0} y={0} r={1.25} h={1} u={u} band="#2f4f7a" felt="#f6f2e6" crown="#8a6440" />
        <Tug x={1.3} y={-1} u={u} color="#f4efe2" />
        <Tug x={-1} y={1.3} u={u} />
      </g>
    );
  return (
    <g>
      <Plate r={1.7} u={u} />
      <Box x0={-1.3} y0={-0.8} w={2.6} d={1.6} h={1.35} s={STONE} u={u} />
      <Roof x0={-1.4} y0={-0.9} w={2.8} d={1.8} z={1.35} h={1.05} s={shadeOf('#55606e')} u={u} />
      <Box x0={0.95} y0={-0.35} w={0.38} d={0.7} h={0.9} s={{ top: '#5a432c', left: '#5a432c', right: '#46331f' }} u={u} />
      <Banner x={1.2} y={0.85} z={0} color={color} u={u} len={2.2} />
    </g>
  );
}
