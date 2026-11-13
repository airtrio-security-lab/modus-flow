/**
 * The ambient life of the 3D city (ADR-0044): what moves when nothing happens — clouds and their
 * shadows, shafts of sunlight, flocks of birds, smoke over the envoys' camp. Pure numbers: no
 * three.js and no DOM, so `test/platform/world3d.test.ts` checks the rules below directly.
 *
 * This is weather, not data. Nothing here reads the server's answer and nothing here means anything:
 * a cloud over a district says nothing about the department, a flock is not a count. The response
 * layer (`feel.ts`) stays the only motion that answers a real change.
 *
 * Rules:
 * - every position is a function of time alone: the same `t` gives the same picture, there is no
 *   `Math.random` and no state that drifts;
 * - at t = 0 the layer is at rest — that is the picture shown when motion is switched off;
 * - the motion is slow: the eye notices that the city lives, the hand is never distracted.
 */
export const AMBIENT = {
  /** Side of the square of sky that repeats: clouds and their shadows wrap inside it, metres. */
  tile: 1800,
  /** Wind, metres a second: slow enough that a shadow crosses a district in about half a minute. */
  wind: { x: 4.6, z: 1.9 },
  /** Height of the cloud deck above sea level. */
  cloudY: 235,
  /** Clouds stay away from the edge of the tile by this much: there they shrink to nothing, so the wrap is never seen. */
  cloudMargin: 150,
  /** How much a cloud darkens the ground under it (0 = none, 1 = black). */
  shade: 0.34,
  /** Shafts of light: one per cloud with an even index, at most this many. */
  shafts: 5,
  /** Birds never fly lower than this above sea level: over every roof of every district. */
  birdFloor: 128,
} as const;

/** A number in [0, 1) that depends only on `i` and `salt`. */
export function hash(i: number, salt: number): number {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
const wrap = (v: number, size: number) => ((v % size) + size) % size;
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------
export interface Lump {
  dx: number;
  dy: number;
  dz: number;
  /** Radius of the lump. */
  s: number;
}
export interface Cloud {
  /** Place in the tile at t = 0, in [0, tile). */
  x: number;
  z: number;
  /** Radius of the whole cloud, metres. */
  r: number;
  lumps: Lump[];
}
/**
 * The cloud field: a jittered 3 × 3 grid, so clouds neither bunch up nor line up. `n` ≤ 9. The same
 * list is painted into the shadow texture, so a shadow always lies under its own cloud.
 */
export function cloudField(n: number): Cloud[] {
  const cell = AMBIENT.tile / 3;
  const out: Cloud[] = [];
  for (let i = 0; i < Math.min(9, n); i++) {
    // Cells are taken in an order that spreads a short list over the whole tile.
    const c = (i * 4) % 9;
    const r = 58 + hash(i, 3) * 46;
    const lumps: Lump[] = [];
    const k = 5 + Math.floor(hash(i, 4) * 3);
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2 + hash(i * 17 + j, 5) * 0.9;
      const d = j === 0 ? 0 : r * (0.34 + hash(i * 17 + j, 6) * 0.36);
      lumps.push({ dx: Math.cos(a) * d * 1.25, dy: (hash(i * 17 + j, 7) - 0.35) * r * 0.16, dz: Math.sin(a) * d * 0.8, s: r * (j === 0 ? 0.56 : 0.3 + hash(i * 17 + j, 8) * 0.2) });
    }
    out.push({ x: ((c % 3) + 0.2 + hash(i, 1) * 0.6) * cell, z: (Math.floor(c / 3) + 0.2 + hash(i, 2) * 0.6) * cell, r, lumps });
  }
  return out;
}
export interface CloudPlace {
  x: number;
  z: number;
  /** 0…1: a cloud shrinks to nothing near the edge of the tile, where it wraps. */
  size: number;
}
/** Where a cloud is at time `t`: world coordinates around the origin, wrapped inside the tile. Writes into `out`. */
export function cloudAt(c: Cloud, t: number, out: CloudPlace): CloudPlace {
  const T = AMBIENT.tile;
  const x = wrap(c.x + AMBIENT.wind.x * t, T);
  const z = wrap(c.z + AMBIENT.wind.z * t, T);
  const edge = Math.min(x, T - x, z, T - z);
  out.x = x - T / 2;
  out.z = z - T / 2;
  out.size = smooth(0, AMBIENT.cloudMargin, edge);
  return out;
}
/**
 * How far the shadow texture is shifted at time `t` (kept inside one tile, so the number stays small
 * however long the map is open). `sun` points from the ground to the sun; `groundY` is the level
 * the shadow is aimed at.
 */
export function shadowShift(t: number, sun: { x: number; y: number; z: number }, groundY: number, out: { x: number; z: number }) {
  const T = AMBIENT.tile;
  const k = (AMBIENT.cloudY - groundY) / sun.y;
  out.x = wrap(AMBIENT.wind.x * t - sun.x * k - T / 2, T);
  out.z = wrap(AMBIENT.wind.z * t - sun.z * k - T / 2, T);
  return out;
}

// ---------------------------------------------------------------------------
// Birds
// ---------------------------------------------------------------------------
export interface Flock {
  /** Centre and half-axes of the loop the flock flies. */
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  y: number;
  /** Radians a second; the sign is the direction round the loop. */
  speed: number;
  phase: number;
  n: number;
}
/**
 * Flocks for a city whose ring of districts has radius `ring`: wide slow loops over the island, the
 * gorge and the plateaus — never one point to stare at. `count` flocks, at most four.
 */
export function flocks(ring: number, count: number): Flock[] {
  const all: Flock[] = [
    { cx: 0, cz: 0, rx: ring * 0.86, rz: ring * 0.62, y: AMBIENT.birdFloor + 22, speed: 0.045, phase: 0.6, n: 7 },
    { cx: -ring * 0.3, cz: ring * 0.2, rx: ring * 0.5, rz: ring * 0.74, y: AMBIENT.birdFloor + 6, speed: -0.06, phase: 2.4, n: 5 },
    { cx: ring * 0.35, cz: -ring * 0.25, rx: ring * 0.42, rz: ring * 0.34, y: AMBIENT.birdFloor + 40, speed: 0.075, phase: 4.3, n: 5 },
    { cx: 0, cz: ring * 0.1, rx: ring * 1.18, rz: ring * 0.98, y: AMBIENT.birdFloor + 58, speed: -0.03, phase: 1.1, n: 6 },
  ];
  return all.slice(0, Math.max(0, Math.min(all.length, count)));
}
export interface Bird {
  x: number;
  y: number;
  z: number;
  /** Direction of flight, radians round the vertical axis (0 = +z). */
  heading: number;
  /** Wing angle, radians: positive — wings up. */
  flap: number;
}
/** Metres between neighbours of a wedge. */
const GAP = 7;
/**
 * Bird `k` of a flock at time `t`. Bird 0 leads; the others follow the same loop a little behind and
 * to one side — a wedge that bends with the turn. Wings beat in bursts and glide in between; every
 * bird has its own rhythm. Writes into `out`.
 */
export function birdAt(f: Flock, k: number, t: number, out: Bird): Bird {
  const row = Math.ceil(k / 2);
  const side = k === 0 ? 0 : k % 2 ? 1 : -1;
  const dir = Math.sign(f.speed) || 1;
  // Followers are behind the leader along the loop.
  const mean = (f.rx + f.rz) / 2;
  const a = f.phase + f.speed * t - (dir * row * GAP) / mean;
  const px = f.cx + Math.cos(a) * f.rx;
  const pz = f.cz + Math.sin(a) * f.rz;
  // The tangent of the loop is the direction of flight.
  const tx = -Math.sin(a) * f.rx * dir;
  const tz = Math.cos(a) * f.rz * dir;
  const len = Math.hypot(tx, tz) || 1;
  const lateral = side * row * GAP * 0.72;
  out.x = px + (tz / len) * lateral;
  out.z = pz - (tx / len) * lateral;
  out.y = f.y + Math.sin(t * 0.21 + f.phase + k * 0.9) * 3.2;
  out.heading = Math.atan2(tx, tz);
  const own = hash(k, f.phase);
  const burst = smooth(-0.25, 0.35, Math.sin(t * (0.42 + own * 0.2) + own * 6.28));
  out.flap = Math.sin(t * (7.2 + own * 1.6) + own * 6.28) * (0.16 + 0.5 * burst) + 0.12;
  return out;
}

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------
export interface Puff {
  dx: number;
  y: number;
  dz: number;
  /** Radius of the puff; 0 where it is born and where it dissolves. */
  s: number;
}
/** Puff `k` of `n` over a fire at time `t`: rises, drifts with the wind, grows and dissolves. Writes into `out`. */
export function puffAt(k: number, n: number, t: number, out: Puff): Puff {
  const life = wrap(t * 0.085 + k / n, 1);
  out.y = 1.2 + life * 17;
  out.dx = AMBIENT.wind.x * life * 1.5 + Math.sin(t * 0.7 + k * 2.1) * 0.35 * life;
  out.dz = AMBIENT.wind.z * life * 1.5 + Math.cos(t * 0.6 + k * 1.3) * 0.35 * life;
  out.s = (0.5 + life * 1.9) * smooth(0, 0.12, life) * (1 - smooth(0.7, 1, life));
  return out;
}
/** The fire of the camp: brightness around 1, never a flash. */
export const flicker = (t: number) => 1 + Math.sin(t * 9.1) * 0.09 + Math.sin(t * 23.7 + 1.3) * 0.05;

// ---------------------------------------------------------------------------
// Details of a living city (ADR-0045): glints on the water, mist in the gorge, what the wind carries
// through each district, the spray of the fountain. Decoration like the rest of this file: a function
// of time alone, meaning nothing.
// ---------------------------------------------------------------------------
export interface Spot {
  x: number;
  y: number;
  z: number;
  /** Size now; 0 = not seen at this moment. */
  s: number;
  /** Turn round the vertical axis, radians. */
  turn: number;
}
/**
 * Glint `i` of `n` on the river that runs round the island at radius `r`: a spark of sun on a wave —
 * it flares for a moment and is gone, each at its own time.
 */
export function glintAt(i: number, n: number, r: number, width: number, t: number, out: Spot): Spot {
  const a = (i / n) * Math.PI * 2 + hash(i, 11) * 0.5;
  const d = r + (hash(i, 12) - 0.5) * width;
  out.x = Math.sin(a) * d;
  out.z = Math.cos(a) * d;
  out.y = 0;
  const beat = Math.sin(t * (0.9 + hash(i, 13) * 0.9) + hash(i, 14) * 6.28);
  out.s = beat > 0 ? beat ** 8 * (0.7 + hash(i, 15) * 0.9) : 0;
  out.turn = hash(i, 16) * 3.14;
  return out;
}
/** Bank of mist `i` of `n` in the gorge of radius `r`: lies low and creeps round the island, slower than a man walks. */
export function mistAt(i: number, n: number, r: number, t: number, out: Spot): Spot {
  const a = (i / n) * Math.PI * 2 + hash(i, 21) * 0.6 + t * 0.0035 * (i % 2 ? 1 : -0.6);
  out.x = Math.sin(a) * r;
  out.z = Math.cos(a) * r;
  out.y = 2.5 + hash(i, 22) * 3 + Math.sin(t * 0.11 + i) * 0.5;
  out.s = 0.75 + hash(i, 23) * 0.5 + Math.sin(t * 0.07 + i * 1.7) * 0.08;
  out.turn = -a;
  return out;
}
/** What the wind carries through a district: petals fall, leaves fall and spin, dust runs low over the ground. */
export type Mote = 'petal' | 'leaf' | 'dust';
/** How far from the middle of a district its motes are seen, metres. */
export const MOTE_REACH = 36;
/** Mote `i` of a district, relative to its middle, at time `t`. */
export function moteAt(kind: Mote, i: number, t: number, out: Spot): Spot {
  const px = (hash(i, 31) - 0.5) * 2 * MOTE_REACH;
  const pz = (hash(i, 32) - 0.5) * 2 * MOTE_REACH;
  if (kind === 'dust') {
    // Dust runs with the wind and comes back from the other side; it is small where it turns round.
    const run = ((t * 0.06 * (0.6 + hash(i, 33)) + hash(i, 34)) % 1 + 1) % 1;
    out.x = (run - 0.5) * 2 * MOTE_REACH;
    out.z = pz + Math.sin(t * 0.5 + i) * 1.2;
    out.y = 0.6 + hash(i, 35) * 2.2 + Math.sin(t * 0.8 + i * 2.3) * 0.3;
    out.s = Math.sin(run * Math.PI) * (0.6 + hash(i, 36) * 0.6);
    out.turn = t * 0.4 + i;
    return out;
  }
  const fall = ((t * (kind === 'petal' ? 0.05 : 0.065) * (0.7 + hash(i, 33) * 0.6) + hash(i, 34)) % 1 + 1) % 1;
  const top = kind === 'petal' ? 13 : 17;
  out.x = px + Math.sin(t * 0.7 + i * 1.9) * 1.6 + AMBIENT.wind.x * fall * 0.8;
  out.z = pz + Math.cos(t * 0.6 + i * 1.3) * 1.6 + AMBIENT.wind.z * fall * 0.8;
  out.y = 0.4 + (1 - fall) * top;
  // Born small at the top, gone small at the ground.
  out.s = Math.sin(fall * Math.PI) ** 0.5 * (0.7 + hash(i, 36) * 0.5);
  out.turn = t * (kind === 'petal' ? 1.1 : 1.9) + i * 2.1;
  return out;
}
/** Drop `i` of `n` of the fountain, relative to its spout: up, out and down into the bowl. */
export function dropAt(i: number, n: number, t: number, out: Spot): Spot {
  const life = ((t * 0.55 + i / n) % 1 + 1) % 1;
  const a = i * 2.39996;
  const reach = 1.2 + hash(i, 41) * 2.4;
  out.x = Math.sin(a) * reach * life;
  out.z = Math.cos(a) * reach * life;
  out.y = 3.6 * 4 * life * (1 - life) - life * 4.6;
  out.s = (1 - life * 0.55) * (0.7 + hash(i, 42) * 0.6);
  out.turn = 0;
  return out;
}
