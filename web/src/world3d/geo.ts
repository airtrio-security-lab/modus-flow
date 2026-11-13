import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MatKey } from './tex';

/**
 * Geometry kit of the 3D commonwealth (ADR-0026). Buildings are assembled from architectural parts
 * — battered plinths, coursed walls with merlons, round towers with corbels and conical roofs,
 * swept hip roofs, arched gates, yurts — and merged per material, so a whole district is a handful
 * of draw calls. All UVs are in metres (see tex.ts).
 */
const UNSHADED = /^(window|gold|fire|pond|dark|ban:|leaf|trunk)/;
export class Builder {
  private parts = new Map<string, THREE.BufferGeometry[]>();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  private tints: number[] = [1];
  private n = 0;
  /** Height of the ground under the buildings: walls are darker and damper near it. */
  ground = 0;
  /** Named places of a kit (the origin of a structure), for the building pins of the 3D town. */
  marks = new Map<string, THREE.Vector3>();

  /** Remember where a named building stands: the given point in the current local frame. The first mark of a name wins. */
  mark(id: string, x = 0, y = 0, z = 0) {
    if (!this.marks.has(id)) this.marks.set(id, new THREE.Vector3(x, y, z).applyMatrix4(this.stack[this.stack.length - 1]!));
    return this;
  }

  /** Run `fn` with a local transform (translate, then rotate around Y, then uniform scale). */
  at(x: number, y: number, z: number, rotY: number, fn: () => void, scale = 1) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(scale, scale, scale));
    this.stack.push(this.stack[this.stack.length - 1]!.clone().multiply(m));
    // Every structure is laid from its own batch of stone or timber: a slightly different tone.
    this.n++;
    const h = Math.sin(this.n * 127.1) * 43758.5453;
    this.tints.push(0.88 + (h - Math.floor(h)) * 0.2);
    fn();
    this.stack.pop();
    this.tints.pop();
  }
  add(mat: MatKey | string, g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rotY = 0) {
    const geo = g.index ? g.toNonIndexed() : g;
    const local = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY), new THREE.Vector3(1, 1, 1));
    geo.applyMatrix4(this.stack[this.stack.length - 1]!.clone().multiply(local));
    const keepColor = mat.startsWith('leaf');
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name) && !(keepColor && name === 'color')) geo.deleteAttribute(name);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    if (!geo.attributes.color) {
      const col = new Float32Array(pos.count * 3).fill(1);
      if (!UNSHADED.test(mat)) {
        const tint = this.tints[this.tints.length - 1]!;
        for (let i = 0; i < pos.count; i++) {
          const t = Math.min(1, Math.max(0, (pos.getY(i) - this.ground) / 4.5));
          const v = tint * (0.7 + 0.3 * t * (2 - t));
          col[i * 3] = v;
          col[i * 3 + 1] = v * (0.985 + 0.015 * t);
          col[i * 3 + 2] = v * (0.95 + 0.05 * t);
        }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const list = this.parts.get(mat) ?? [];
    list.push(geo);
    this.parts.set(mat, list);
    return this;
  }
  /** Merge everything into one mesh per material. `extra` supplies materials not in the shared library (banners). */
  build(mats: Record<string, THREE.Material>, opts: { shadows?: boolean } = {}) {
    const group = new THREE.Group();
    for (const [key, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mats[key] ?? mats.stone);
      mesh.castShadow = opts.shadows !== false && key !== 'window';
      mesh.receiveShadow = true;
      mesh.name = key;
      group.add(mesh);
    }
    this.parts.clear();
    return group;
  }
}

// ---------------------------------------------------------------------------
// Primitives with metre UVs
// ---------------------------------------------------------------------------
export function box(w: number, h: number, d: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) uv.setXY(f * 4 + i, uv.getX(f * 4 + i) * dims[f]![0], uv.getY(f * 4 + i) * dims[f]![1]);
  g.translate(0, h / 2, 0);
  return g;
}
/** A cylinder or frustum standing on y = 0. */
export function cyl(rTop: number, rBot: number, h: number, seg = 20, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const circ = Math.PI * 2 * Math.max(rTop, rBot);
  const sideCount = (seg + 1) * 2;
  for (let i = 0; i < uv.count; i++) {
    if (i < sideCount) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
    else uv.setXY(i, pos.getX(i), pos.getZ(i));
  }
  g.translate(0, h / 2, 0);
  return g;
}
export function cone(r: number, h: number, seg = 20) {
  const g = new THREE.ConeGeometry(r, h, seg, 1, true);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const slant = Math.hypot(r, h);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * slant);
  g.translate(0, h / 2, 0);
  return g;
}
/** A surface of revolution from a profile [radius, height][] (domes, yurt roofs, onion finials). */
export function lathe(profile: [number, number][], seg = 24) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.001), y)), seg);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const maxR = Math.max(...profile.map((p) => p[0]));
  let len = 0;
  for (let i = 1; i < profile.length; i++) len += Math.hypot(profile[i]![0] - profile[i - 1]![0], profile[i]![1] - profile[i - 1]![1]);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * maxR, uv.getY(i) * len);
  return g;
}
function planarUV(g: THREE.BufferGeometry) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ay > ax && ay > az) {
      uv[i * 2] = pos.getX(i);
      uv[i * 2 + 1] = pos.getZ(i);
    } else if (ax > az) {
      uv[i * 2] = pos.getZ(i);
      uv[i * 2 + 1] = pos.getY(i);
    } else {
      uv[i * 2] = pos.getX(i);
      uv[i * 2 + 1] = pos.getY(i);
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
function fromTris(tris: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
  g.computeVertexNormals();
  return planarUV(g);
}

/** A gable roof (two slopes and two gable ends) over a w × d rectangle; the ridge runs along X. */
export function gable(w: number, d: number, h: number, over = 0.4) {
  const x = w / 2 + over;
  const z = d / 2 + over;
  const q = (a: number[], b: number[], c: number[], e: number[]) => [...a, ...b, ...c, ...a, ...c, ...e];
  return fromTris([
    ...q([-x, 0, z], [x, 0, z], [x, h, 0], [-x, h, 0]),
    ...q([x, 0, -z], [-x, 0, -z], [-x, h, 0], [x, h, 0]),
    ...[-x, 0, -z, -x, 0, z, -x, h, 0],
    ...[x, 0, z, x, 0, -z, x, h, 0],
  ]);
}

/**
 * A swept hip roof (Japan, Mongol halls): concave slopes and lifted corners. The eave is a rectangle
 * (w + 2·over) × (d + 2·over); the ridge is a line `ridge` long along X at height h.
 */
export function sweptRoof(w: number, d: number, h: number, over: number, lift: number, ridge = Math.max(0, w - d) * 0.9, n = 7) {
  const ex = w / 2 + over;
  const ez = d / 2 + over;
  const tris: number[] = [];
  // Parametrise the eave perimeter; each perimeter point rises to the nearest ridge point.
  const P = 4 * n;
  const eave = (k: number): [number, number, number] => {
    const side = Math.floor(k / n) % 4;
    const t = (k % n) / n;
    const corner = Math.abs(t - 0.5) * 2;
    const y = lift * corner * corner;
    if (side === 0) return [-ex + t * 2 * ex, y, ez];
    if (side === 1) return [ex, y, ez - t * 2 * ez];
    if (side === 2) return [ex - t * 2 * ex, y, -ez];
    return [-ex, y, -ez + t * 2 * ez];
  };
  const top = (p: [number, number, number]): [number, number, number] => [Math.max(-ridge / 2, Math.min(ridge / 2, p[0])), h, 0];
  const rows = 5;
  const pt = (k: number, v: number): number[] => {
    const e = eave(k % P);
    const r = top(e);
    const s = Math.pow(v, 1.7);
    return [e[0] + (r[0] - e[0]) * v, e[1] * (1 - v) * (1 - v) + h * s, e[2] + (r[2] - e[2]) * v];
  };
  for (let k = 0; k < P; k++)
    for (let j = 0; j < rows; j++) {
      const a = pt(k, j / rows);
      const b = pt(k + 1, j / rows);
      const c = pt(k + 1, (j + 1) / rows);
      const e = pt(k, (j + 1) / rows);
      tris.push(...a, ...b, ...c, ...a, ...c, ...e);
    }
  const g = fromTris(tris);
  return g;
}

/** A wall panel with an arched opening, extruded to `depth` (gatehouses, portals, arcades). */
export function archWall(w: number, h: number, depth: number, openW: number, openH: number, pointed = false) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(-openW / 2, 0);
  const spring = openH - openW / 2;
  s.lineTo(-openW / 2, spring);
  if (pointed) {
    s.quadraticCurveTo(-openW / 2, openH * 0.96, 0, openH + openW * 0.18);
    s.quadraticCurveTo(openW / 2, openH * 0.96, openW / 2, spring);
  } else s.absarc(0, spring, openW / 2, Math.PI, 0, true);
  s.lineTo(openW / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h);
  s.lineTo(-w / 2, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 10 });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  // An extrusion is already non-indexed; asking again only prints a warning for every arch of the city.
  return planarUV(g.index ? g.toNonIndexed() : g);
}

// ---------------------------------------------------------------------------
// Architectural parts
// ---------------------------------------------------------------------------
/** Merlons along a straight parapet of length `len` (centred on X). */
export function merlons(b: Builder, mat: MatKey, len: number, y: number, z: number, thick = 0.5, size = 0.9, gap = 0.8, h = 0.9) {
  const n = Math.max(1, Math.floor((len + gap) / (size + gap)));
  const step = len / n;
  for (let i = 0; i < n; i++) b.add(mat, box(step - gap, h, thick), -len / 2 + step * (i + 0.5), y, z);
}

/** A curtain wall between two points with a walkway, parapet and merlons on the outer side. */
export function curtain(b: Builder, mat: MatKey, ax: number, az: number, bx: number, bz: number, h: number, thick = 2.2, crenel = true) {
  const len = Math.hypot(bx - ax, bz - az);
  const rot = -Math.atan2(bz - az, bx - ax);
  b.at((ax + bx) / 2, 0, (az + bz) / 2, rot, () => {
    b.add(mat, box(len, h, thick));
    b.add(mat, box(len, 0.35, thick + 0.5), 0, h, 0);
    if (crenel) {
      b.add(mat, box(len, 0.7, 0.45), 0, h + 0.35, thick / 2);
      merlons(b, mat, len, h + 1.05, thick / 2);
      b.add(mat, box(len, 0.5, 0.35), 0, h + 0.35, -thick / 2);
    }
  });
}

/** A round tower: battered base, shaft, corbelled crown with merlons, conical roof or open platform. */
export function roundTower(b: Builder, wall: MatKey, r: number, h: number, roof: MatKey | null, o: { windows?: boolean; roofH?: number; finial?: boolean } = {}) {
  b.add(wall, cyl(r, r * 1.22, h * 0.16, 20));
  b.add(wall, cyl(r, r, h * 0.84, 20, true), 0, h * 0.16, 0);
  b.add(wall, cyl(r * 1.16, r, 0.7, 20), 0, h - 0.5, 0);
  b.add(wall, cyl(r * 1.16, r * 1.16, 0.9, 20), 0, h + 0.2, 0);
  const n = Math.max(6, Math.round((Math.PI * 2 * r * 1.16) / 1.7));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    b.add(wall, box(0.85, 0.85, 0.5), Math.cos(a) * r * 1.13, h + 1.1, Math.sin(a) * r * 1.13, -a + Math.PI / 2);
  }
  if (o.windows !== false)
    for (let k = 0; k < 2; k++)
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + k * 0.6 + 0.3;
        b.add('window', box(0.34, 1.3, 0.12), Math.cos(a) * (r + 0.02), h * (0.42 + k * 0.28), Math.sin(a) * (r + 0.02), -a + Math.PI / 2);
      }
  if (roof) {
    const rh = o.roofH ?? r * 2.1;
    b.add(roof, cone(r * 1.28, rh, 20), 0, h + 0.9, 0);
    if (o.finial !== false) {
      b.add('gold', cyl(0.07, 0.07, 1.6, 6), 0, h + 0.9 + rh - 0.2, 0);
      b.add('gold', new THREE.SphereGeometry(0.24, 8, 6), 0, h + 0.9 + rh + 1.4, 0);
    }
  }
}

/** A square tower / keep with corner buttresses, string courses and merlons. */
export function squareTower(b: Builder, wall: MatKey, w: number, d: number, h: number, o: { windows?: number; crenel?: boolean } = {}) {
  b.add(wall, box(w + 1, h * 0.12, d + 1));
  b.add(wall, box(w, h, d));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(wall, box(1.1, h * 0.94, 1.1), (sx * w) / 2, 0, (sz * d) / 2);
  b.add(wall, box(w + 0.5, 0.35, d + 0.5), 0, h * 0.55, 0);
  b.add(wall, box(w + 1, 0.6, d + 1), 0, h, 0);
  if (o.crenel !== false) {
    for (const s of [-1, 1]) {
      b.at(0, 0, (s * (d + 1)) / 2 - s * 0.25, 0, () => merlons(b, wall, w + 1, h + 0.6, 0));
      b.at((s * (w + 1)) / 2 - s * 0.25, 0, 0, Math.PI / 2, () => merlons(b, wall, d + 1, h + 0.6, 0));
    }
  }
  const rows = o.windows ?? 3;
  for (let k = 0; k < rows; k++) {
    const y = h * (0.28 + (k * 0.6) / Math.max(1, rows));
    for (const s of [-1, 1]) {
      for (const t of [-0.25, 0.25]) {
        b.add('window', box(0.5, 1.5, 0.12), t * w, y, (s * d) / 2 + s * 0.02);
        b.add('window', box(0.12, 1.5, 0.5), (s * w) / 2 + s * 0.02, y, t * d);
      }
    }
  }
}

/** A hall: walls, gable roof, buttresses, tall windows, a door on +Z. */
export function hall(b: Builder, wall: MatKey, roof: MatKey, w: number, d: number, h: number, roofH: number, o: { door?: boolean; chimney?: boolean } = {}) {
  b.add(wall, box(w + 0.4, 0.5, d + 0.4));
  b.add(wall, box(w, h, d));
  b.add(roof, gable(w, d, roofH, 0.5), 0, h, 0);
  // Gable infill triangles are part of the roof geometry; add ridge beam.
  b.add('wood', box(w + 1.2, 0.25, 0.25), 0, h + roofH - 0.1, 0);
  const n = Math.max(2, Math.round(w / 4));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (w / n) * (i + 0.5);
    for (const s of [-1, 1]) {
      b.add('window', box(0.7, h * 0.45, 0.12), x, h * 0.32, (s * d) / 2 + s * 0.02);
      if (i < n - 1) b.add(wall, box(0.5, h * 0.85, 0.6), x + w / n / 2, 0, (s * d) / 2 + s * 0.25);
    }
  }
  if (o.door !== false) b.add('wood', box(1.6, 2.4, 0.2), w / 2 + 0.02, 0, 0, Math.PI / 2);
  if (o.chimney) b.add(wall, box(0.9, roofH + 1.2, 0.9), -w / 4, h, d / 4);
}

/** A cloth banner on a pole; `mat` is the district's banner material. */
export function banner(b: Builder, mat: string, h = 7, w = 1.5, len = 3.6) {
  b.add('iron', cyl(0.07, 0.09, h, 6));
  b.add('iron', box(w + 0.3, 0.08, 0.08), 0, h - 0.3, 0);
  const g = new THREE.PlaneGeometry(w, len, 2, 6);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin((pos.getY(i) / len) * 4) * 0.12);
  g.computeVertexNormals();
  b.add(mat, g, 0, h - 0.35 - len / 2, 0.06);
}

/** A wall-hung banner (no pole). */
export function hanging(b: Builder, mat: string, w = 1.6, len = 4.2) {
  const g = new THREE.PlaneGeometry(w, len, 1, 4);
  b.add(mat, g, 0, -len / 2, 0);
}

/**
 * A yurt. Kazakh «киіз үй»: taller dome, ornament band, carved double door, shanyrak crown.
 * Mongol «гэр»: lower and wider, straight shallow roof, ropes, orange door, red toono ring.
 */
export function yurt(b: Builder, r: number, style: 'kazakh' | 'mongolia', o: { grand?: boolean } = {}) {
  const kz = style === 'kazakh';
  const wallH = r * (kz ? 0.62 : 0.5);
  const roofH = r * (kz ? 0.72 : 0.42);
  b.add('felt', cyl(r, r, wallH, 28, true));
  b.add(kz ? 'bandKz' : 'bandMn', cyl(r + 0.03, r + 0.03, wallH * 0.3, 28, true), 0, wallH * (kz ? 0.62 : 0.66), 0);
  if (!kz) for (const y of [0.25, 0.48]) b.add('woodLight', cyl(r + 0.05, r + 0.05, 0.07, 28, true), 0, wallH * y, 0);
  const crown = r * (kz ? 0.2 : 0.24);
  const profile: [number, number][] = kz
    ? [[r + 0.25, wallH - 0.1], [r * 0.86, wallH + roofH * 0.36], [r * 0.58, wallH + roofH * 0.72], [crown, wallH + roofH]]
    : [[r + 0.3, wallH - 0.05], [r * 0.6, wallH + roofH * 0.58], [crown, wallH + roofH]];
  b.add(o.grand && kz ? 'felt' : 'felt', lathe(profile, 28));
  if (o.grand) b.add(kz ? 'bandKz' : 'bandMn', lathe([[r + 0.27, wallH - 0.08], [r * 0.93, wallH + roofH * (kz ? 0.2 : 0.16)]], 28));
  b.add(kz ? 'wood' : 'red', cyl(crown, crown * 1.05, 0.28, 16), 0, wallH + roofH - 0.05, 0);
  if (kz) b.add(o.grand ? 'gold' : 'woodLight', lathe([[crown * 0.95, wallH + roofH + 0.2], [crown * 0.6, wallH + roofH + crown * 0.55], [0.05, wallH + roofH + crown * 0.7]], 12));
  else b.add('felt', cone(crown * 0.9, crown * 0.5, 12), 0, wallH + roofH + 0.2, 0);
  // Door on +Z.
  const dw = Math.min(1.5, r * 0.34);
  const dh = wallH * 0.86;
  b.add('wood', box(dw + 0.5, dh + 0.3, 0.3), 0, 0, r - 0.05);
  b.add(kz ? 'bandKz' : 'red', box(dw, dh, 0.12), 0, 0.05, r + 0.12);
  if (!kz) {
    // Ropes over the roof.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      b.add('woodLight', cyl(0.035, 0.035, wallH + 0.4, 4), Math.cos(a) * (r + 0.1), 0, Math.sin(a) * (r + 0.1));
    }
  }
}

/** A palisade of pointed logs between two points. */
export function palisade(b: Builder, ax: number, az: number, bx: number, bz: number, h = 4.2) {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(2, Math.round(len / 0.75));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const hh = h * (0.92 + ((i * 7919) % 13) / 100);
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    b.add('logs', cyl(0.3, 0.34, hh, 7), x, 0, z);
    b.add('logs', cone(0.3, 0.7, 7), x, hh, z);
  }
  const rot = -Math.atan2(bz - az, bx - ax);
  b.add('wood', box(len, 0.3, 0.2), (ax + bx) / 2, h * 0.55, (az + bz) / 2, rot);
}

/** A timber watchtower on four posts with a hipped roof (steppe camps). */
export function watchtower(b: Builder, h = 11, roof: MatKey = 'woodLight') {
  const s = 1.7;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('logs', cyl(0.22, 0.3, h, 7), sx * s, 0, sz * s);
  for (const y of [h * 0.3, h * 0.6]) {
    b.add('wood', box(s * 2, 0.2, 0.2), 0, y, s);
    b.add('wood', box(s * 2, 0.2, 0.2), 0, y, -s);
    b.add('wood', box(0.2, 0.2, s * 2), s, y, 0);
    b.add('wood', box(0.2, 0.2, s * 2), -s, y, 0);
  }
  b.add('woodLight', box(s * 2 + 1.4, 0.3, s * 2 + 1.4), 0, h * 0.72, 0);
  for (const sgn of [-1, 1]) {
    b.add('woodLight', box(s * 2 + 1.4, 1, 0.14), 0, h * 0.72 + 0.3, sgn * (s + 0.65));
    b.add('woodLight', box(0.14, 1, s * 2 + 1.4), sgn * (s + 0.65), h * 0.72 + 0.3, 0);
  }
  b.add(roof, sweptRoof(s * 2 + 1.2, s * 2 + 1.2, 2.2, 0.9, 0.5, 0), 0, h, 0);
}

/**
 * A crown of foliage: several lumpy, smooth-shaded masses with darker undersides (vertex colours),
 * so trees read as volumes of leaves and not as faceted balls.
 */
export function foliage(r: number, seed = 1, lumps = 5, detail = 1) {
  let k = seed * 9973;
  const rnd = () => {
    k = (k * 16807) % 2147483647;
    return (k & 0xffff) / 0xffff;
  };
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < lumps; i++) {
    const rr = r * (i === 0 ? 1 : 0.55 + rnd() * 0.3);
    const g = mergeVertices(new THREE.IcosahedronGeometry(rr, detail).deleteAttribute('uv').deleteAttribute('normal'), 1e-3);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const ox = i === 0 ? 0 : (rnd() - 0.5) * r * 1.5;
    const oy = i === 0 ? 0 : (rnd() - 0.35) * r * 0.9;
    const oz = i === 0 ? 0 : (rnd() - 0.5) * r * 1.5;
    for (let j = 0; j < pos.count; j++) {
      const x = pos.getX(j);
      const y = pos.getY(j);
      const z = pos.getZ(j);
      const n = 1 + Math.sin(x * 2.3 + seed) * Math.cos(z * 2.1 + i) * 0.14 + Math.sin(y * 3.1 + i * 2) * 0.08;
      pos.setXYZ(j, x * n + ox, y * n * 0.82 + oy, z * n + oz);
    }
    parts.push(g);
  }
  const m = mergeGeometries(parts, false)!;
  m.computeVertexNormals();
  const pos = m.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let j = 0; j < pos.count; j++) {
    const v = 0.55 + 0.45 * Math.min(1, Math.max(0, (pos.getY(j) + r * 0.7) / (r * 1.6)));
    col[j * 3] = col[j * 3 + 1] = col[j * 3 + 2] = v;
  }
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return m.toNonIndexed();
}
/** A conifer: stacked drooping tiers, darker towards the trunk. */
export function conifer(h = 11, r = 2.6, tiers = 5) {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const rr = r * (1 - t * 0.78);
    const hh = (h / tiers) * 1.9;
    const g = new THREE.ConeGeometry(rr, hh, 9, 1, true).deleteAttribute('uv');
    g.translate(0, h * 0.2 + t * h * 0.8 + hh / 2 - 0.4, 0);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    for (let j = 0; j < pos.count; j++) {
      const rad = Math.hypot(pos.getX(j), pos.getZ(j)) / Math.max(rr, 0.01);
      const v = 0.5 + 0.5 * rad;
      col[j * 3] = col[j * 3 + 1] = col[j * 3 + 2] = v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g.toNonIndexed());
  }
  return mergeGeometries(parts, false)!;
}
