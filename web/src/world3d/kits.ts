import * as THREE from 'three';
import { Builder, archWall, banner, box, cone, conifer, curtain, cyl, foliage, gable, hall, hanging, lathe, palisade, roundTower, squareTower, sweptRoof, watchtower, yurt } from './geo';

/**
 * Four civilizations × five levels (ADR-0022). Each kit is an original composition with its own
 * architectural grammar; a level adds and replaces structures — it is never a recolour.
 * All kits face +Z (their gate looks at the centre of the commonwealth) and fit a 60 m radius.
 * `ban` is the material key of the district's banner cloth.
 */
export type CivId = 'camelot' | 'japan' | 'kazakh' | 'mongolia';
export type Kit = (b: Builder, level: number, ban: string) => void;

const ring = (n: number, r: number, fn: (x: number, z: number, a: number, i: number) => void, start = 0, arc = Math.PI * 2) => {
  for (let i = 0; i < n; i++) {
    const a = start + (arc * i) / (arc >= Math.PI * 2 - 0.001 ? n : Math.max(1, n - 1));
    fn(Math.sin(a) * r, Math.cos(a) * r, a, i);
  }
};
function tree(b: Builder, x: number, z: number, kind: 'pine' | 'leaf' | 'sakura', s = 1) {
  b.at(x, 0, z, (x * 13 + z * 7) % 6, () => {
    b.add('trunk', cyl(0.18, 0.28, kind === 'pine' ? 2.2 : 2.6, 6));
    if (kind === 'pine') b.add('leafPine', conifer(7.5, 2.1, 4));
    else b.add(kind === 'sakura' ? 'leafPink' : 'leafGreen', foliage(2.2, Math.abs(Math.round(x * 3 + z * 5)) + 1, 5), 0, 4, 0);
  }, s);
}
function tent(b: Builder, r = 2.4) {
  b.add('felt', cone(r, r * 1.3, 8));
  b.add('wood', cyl(0.06, 0.06, r * 1.6, 5));
}
function campfire(b: Builder) {
  ring(7, 0.7, (x, z) => b.add('rock', box(0.35, 0.3, 0.35), x, 0, z));
  b.add('fire', cone(0.4, 1, 6), 0, 0.1, 0);
}
function scaffold(b: Builder, w: number, h: number) {
  for (const x of [-w / 2, w / 2]) for (const z of [-1, 1]) b.add('woodLight', cyl(0.1, 0.1, h, 5), x, 0, z);
  for (let y = 2; y < h; y += 2.4) b.add('woodLight', box(w + 0.6, 0.12, 2.4), 0, y, 0);
}

// ---------------------------------------------------------------------------
// Камелот — a knightly fortress: curtain walls, round towers, donjon, gatehouse, bridge, inner ward
// ---------------------------------------------------------------------------
function gatehouse(b: Builder, ban: string, h: number, grand: boolean) {
  const w = grand ? 9 : 7;
  b.add('stone', archWall(w, h, 4.6, 3.6, 5.2), 0, 0, 0);
  b.add('dark', box(3.4, 5, 0.3), 0, 0, -1.6);
  b.add('iron', box(3.5, 1.3, 0.14), 0, 3.9, 1.2);
  for (const s of [-1, 1]) b.at(s * (w / 2 + 2.2), 0, 0.6, 0, () => roundTower(b, 'stone', 2.9, h + (grand ? 5 : 3), 'slate'));
  b.add('stone', box(w, 0.6, 5.2), 0, h, 0);
  b.at(0, 0, 2.4, 0, () => {
    for (let i = 0; i < 4; i++) b.add('stone', box(0.9, 0.9, 0.5), -w / 2 + 1.2 + i * ((w - 2.4) / 3), h + 0.6, 0);
  });
  b.at(0, h - 0.2, 2.45, 0, () => hanging(b, ban, 2.4, 4.6));
  if (grand) b.at(0, h + 0.6, 0, 0, () => b.add('slate', gable(w - 1, 4, 2.6, 0.3)));
}
function donjon(b: Builder, ban: string, w: number, h: number, turrets: boolean) {
  squareTower(b, 'stone', w, w, h, { windows: 4 });
  if (turrets) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at((sx * w) / 2, h * 0.55, (sz * w) / 2, 0, () => roundTower(b, 'stone', 1.7, h * 0.62, 'slate', { windows: false, roofH: 5 }));
    b.add('stone', box(w * 0.6, 4, w * 0.6), 0, h + 0.6, 0);
    b.add('slate', sweptRoof(w * 0.6, w * 0.6, 7, 0.5, 0, 0), 0, h + 4.6, 0);
    b.add('gold', cyl(0.08, 0.08, 2.4, 6), 0, h + 11.4, 0);
  } else b.add('slate', sweptRoof(w - 1.4, w - 1.4, 4.6, 0.2, 0, 0), 0, h + 0.6, 0);
  b.at(0, h * 0.9, w / 2 + 0.62, 0, () => hanging(b, ban, 3, 8));
  for (const sgn of [-1, 1]) b.at((sgn * w) / 2 + sgn * 0.62, h * 0.9, 0, (sgn * Math.PI) / 2, () => hanging(b, ban, 2.4, 6.5));
}
const camelot: Kit = (b, L, ban) => {
  if (L === 1) {
    // An outpost: a timber stockade, a first stone tower going up, a thatched hall, tents.
    const R = 15;
    ring(9, R, (x, z, a, i) => {
      if (i === 0) return;
      const a2 = a + (Math.PI * 2) / 9;
      palisade(b, x, z, Math.sin(a2) * R, Math.cos(a2) * R, 4);
    }, -Math.PI / 9);
    b.at(-5, 0, -4, 0, () => {
      roundTower(b, 'stone', 3.2, 8, null);
      b.at(4.6, 0, 0, Math.PI / 2, () => scaffold(b, 4, 9));
    });
    b.at(5, 0, -3, 0.3, () => hall(b, 'wood', 'thatch', 9, 6, 3.4, 3.4));
    b.at(4, 0, 6, 0, () => tent(b));
    b.at(-6, 0, 6, 0, () => tent(b, 2));
    b.at(0, 0, 3, 0, () => campfire(b));
    b.at(1.5, 0, R + 1, 0, () => banner(b, ban, 6));
    return;
  }
  const W = [0, 0, 17, 23, 27, 31][L]!; // half-width of the main ward
  const D = [0, 0, 15, 20, 23, 26][L]!;
  const wallH = [0, 0, 6.5, 8.5, 9.5, 10.5][L]!;
  const towerH = wallH + [0, 0, 4.5, 6, 7.5, 9][L]!;
  if (L >= 4) b.add('stoneDark', box(W * 2 + 10, 1.4, D * 2 + 10), 0, -1.2, 0);
  b.add('cobble', box(W * 2, 0.3, D * 2), 0, -0.1, 0);
  // Curtain walls; the front one is split by the gatehouse.
  const gw = L >= 4 ? 9 : 7;
  curtain(b, 'stone', -W, -D, W, -D, wallH);
  curtain(b, 'stone', -W, -D, -W, D, wallH);
  curtain(b, 'stone', W, D, W, -D, wallH);
  curtain(b, 'stone', -gw / 2 - 4.5, D, -W, D, wallH);
  curtain(b, 'stone', W, D, gw / 2 + 4.5, D, wallH);
  b.at(0, 0, D, 0, () => gatehouse(b, ban, wallH + 1.5, L >= 4));
  // Corner towers; from level 4 also mid-wall towers.
  const corners: [number, number][] = [[-W, -D], [W, -D], [-W, D], [W, D]];
  for (const [x, z] of corners) b.at(x, 0, z, 0, () => roundTower(b, 'stone', L >= 4 ? 3.6 : 3.1, towerH, L >= 3 || z > 0 ? 'slate' : null));
  if (L >= 4) for (const [x, z] of [[-W, 0], [W, 0], [0, -D]] as [number, number][]) b.at(x, 0, z, 0, () => roundTower(b, 'stone', 3, towerH - 2, L >= 5 ? 'slate' : null));
  // The donjon on the rear half of the ward.
  const kw = [0, 0, 9, 11, 12.5, 14][L]!;
  const kh = [0, 0, 15, 20, 26, 32][L]!;
  b.at(L >= 3 ? -W * 0.25 : 0, 0, -D * 0.35, 0, () => donjon(b, ban, kw, kh, L >= 3));
  // Buildings of the ward.
  if (L >= 3) b.at(W * 0.45, 0, -D * 0.3, Math.PI / 2, () => hall(b, 'stone', 'slate', 15, 7.5, 6, 5, { chimney: true }));
  if (L >= 3) b.at(W * 0.5, 0, D * 0.45, 0, () => hall(b, 'wood', 'slate', 8, 5.5, 3.6, 3.2));
  b.at(-W * 0.55, 0, D * 0.45, 0, () => hall(b, 'wood', L >= 3 ? 'slate' : 'thatch', 8, 5, 3.4, 3));
  if (L >= 4) {
    // A chapel with a bell turret.
    b.at(-W * 0.6, 0, -D * 0.05, 0, () => {
      hall(b, 'stone', 'slate', 11, 6, 6.5, 5.5);
      b.at(-6.5, 0, 0, 0, () => {
        squareTower(b, 'stone', 3.4, 3.4, 13, { windows: 2, crenel: false });
        b.add('slate', sweptRoof(3.6, 3.6, 6, 0.3, 0, 0), 0, 13.6, 0);
      });
    });
    // A stone bridge and barbican in front of the gate.
    b.add('stone', box(5.5, 1.2, 16), 0, -0.9, D + 10.5);
    for (const s of [-1, 1]) {
      b.add('stone', box(0.5, 1.1, 16), s * 2.6, 0.3, D + 10.5);
      b.at(s * 4.2, 0, D + 19, 0, () => roundTower(b, 'stone', 2.2, 7.5, L >= 5 ? 'slate' : null, { windows: false }));
    }
    b.add('stone', archWall(6.4, 6.5, 2.2, 3.6, 4.8), 0, 0, D + 19);
  }
  if (L >= 5) {
    // The outer bailey with its own wall, market houses and stables.
    const OW = W + 15;
    const OD = D + 13;
    curtain(b, 'stone', -OW, D - 4, -OW, OD + 8, 6.5, 1.8);
    curtain(b, 'stone', OW, OD + 8, OW, D - 4, 6.5, 1.8);
    curtain(b, 'stone', -5.5, OD + 8, -OW, OD + 8, 6.5, 1.8);
    curtain(b, 'stone', OW, OD + 8, 5.5, OD + 8, 6.5, 1.8);
    curtain(b, 'stone', -OW, D - 4, -W, D - 4, 6.5, 1.8);
    curtain(b, 'stone', W, D - 4, OW, D - 4, 6.5, 1.8);
    for (const s of [-1, 1]) b.at(s * OW, 0, OD + 8, 0, () => roundTower(b, 'stone', 3, 11, 'slate'));
    for (const s of [-1, 1]) {
      b.at(s * (W + 7), 0, D + 9, Math.PI / 2, () => hall(b, 'wood', 'slate', 9, 5.5, 3.6, 3.2));
      b.at(s * (W + 8), 0, D + 17, 0.2 * s, () => hall(b, 'plaster', 'slate', 7, 5, 3.8, 3));
    }
    b.at(-W * 0.25, kh + 14, -D * 0.35, 0, () => banner(b, ban, 4, 1.2, 2.2));
  }
  // Banners at the gate and on the ward.
  for (const s of [-1, 1]) b.at(s * (gw / 2 + 8), 0, D + 2.5, 0, () => banner(b, ban, 8));
  if (L >= 3) for (const s of [-1, 1]) b.at(s * 3.2, 0, D - 4, 0, () => banner(b, ban, 6.5, 1.2, 3));
  // Heraldic cloths on the front curtain between the towers.
  if (L >= 3) for (const s of [-1, 1]) b.at(s * (W * 0.55 + 2), wallH - 0.3, D + 1.16, 0, () => hanging(b, ban, 2, 4.4));
  if (L === 2) b.at(W * 0.5, 0, -D * 0.4, Math.PI / 2, () => scaffold(b, 5, 8));
};

// ---------------------------------------------------------------------------
// Японский сёгунат — stone base, timber and plaster keep with tiered swept roofs, gate, garden, bridge
// ---------------------------------------------------------------------------
function ishigaki(b: Builder, w: number, d: number, h: number, batter = 1.6) {
  const g = new THREE.CylinderGeometry(Math.SQRT1_2, Math.SQRT1_2 * 1, h, 4, 1);
  g.rotateY(Math.PI / 4);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const top = pos.getY(i) > 0;
    const sx = top ? w : w + batter * 2;
    const sz = top ? d : d + batter * 2;
    pos.setXYZ(i, pos.getX(i) * sx, pos.getY(i) + h / 2, pos.getZ(i) * sz);
    uv.setXY(i, uv.getX(i) * (w + d) * 2, uv.getY(i) * h);
  }
  g.computeVertexNormals();
  b.add('rock', g);
}
/** One storey of a keep: timber band, plaster walls, windows, and the swept roof skirt above it. */
function storey(b: Builder, w: number, d: number, h: number, last: boolean) {
  b.add('wood', box(w + 0.2, 0.5, d + 0.2));
  b.add('plaster', box(w, h, d));
  b.add('wood', box(w + 0.15, 0.3, d + 0.15), 0, h - 0.3, 0);
  const n = Math.max(2, Math.round(w / 2.6));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (w / n) * (i + 0.5);
    for (const s of [-1, 1]) b.add('window', box(0.9, 0.8, 0.1), x, h * 0.5, (s * d) / 2 + s * 0.02);
  }
  const m = Math.max(2, Math.round(d / 2.6));
  for (let i = 0; i < m; i++) {
    const z = -d / 2 + (d / m) * (i + 0.5);
    for (const s of [-1, 1]) b.add('window', box(0.1, 0.8, 0.9), (s * w) / 2 + s * 0.02, h * 0.5, z);
  }
  const rh = last ? Math.min(w, d) * 0.42 : 2;
  b.add('tileJ', sweptRoof(w, d, rh, last ? 1.5 : 1.7, last ? 1 : 0.8, last ? Math.max(1.5, w - d * 0.7) : w * 0.6), 0, h, 0);
  if (!last) {
    // A small decorative gable on the front and back slopes.
    for (const s of [-1, 1]) b.add('tileJ', gable(1.4, 2.6, 1.2, 0.15), 0, h + 0.3, (s * d) / 2 + s * 0.9, Math.PI / 2);
  } else {
    b.add('tileJ', box(Math.max(1.5, w - d * 0.7) + 0.6, 0.35, 0.4), 0, h + rh - 0.1, 0);
    for (const s of [-1, 1]) b.add('gold', box(0.3, 0.9, 0.25), (s * (Math.max(1.5, w - d * 0.7) + 0.4)) / 2, h + rh, 0);
  }
}
function tenshu(b: Builder, tiers: number, w: number, d: number, baseH: number) {
  ishigaki(b, w + 1.5, d + 1.5, baseH);
  let y = baseH;
  let cw = w;
  let cd = d;
  for (let i = 0; i < tiers; i++) {
    const h = i === 0 ? 4.2 : 3.4;
    b.at(0, y, 0, 0, () => storey(b, cw, cd, h, i === tiers - 1));
    y += h + (i === tiers - 1 ? 0 : 1.1);
    cw *= 0.78;
    cd *= 0.78;
  }
}
function jwall(b: Builder, ax: number, az: number, bx: number, bz: number) {
  const len = Math.hypot(bx - ax, bz - az);
  const rot = -Math.atan2(bz - az, bx - ax);
  b.at((ax + bx) / 2, 0, (az + bz) / 2, rot, () => {
    b.add('rock', box(len, 1.3, 1.5));
    b.add('plaster', box(len, 2, 0.8), 0, 1.3, 0);
    b.add('tileJ', gable(len, 1.2, 0.7, 0.25), 0, 3.3, 0);
  });
}
function jgate(b: Builder, ban: string, grand: boolean) {
  const w = grand ? 5 : 4;
  for (const s of [-1, 1]) b.add('wood', box(0.6, 5, 0.6), (s * w) / 2, 0, 0);
  b.add('wood', box(w + 1.6, 0.6, 0.7), 0, 4.4, 0);
  b.add('wood', box(w, 3.8, 0.2), 0, 0, -0.2);
  b.add('tileJ', sweptRoof(w + 1.5, 2.4, 1.5, 0.9, 0.5, w), 0, 5, 0);
  if (grand) {
    b.add('plaster', box(w + 1.2, 2.6, 2.6), 0, 5.2, 0);
    b.add('tileJ', sweptRoof(w + 1.2, 2.6, 1.8, 1.2, 0.7, w), 0, 7.8, 0);
  }
  for (const s of [-1, 1]) b.at(s * (w / 2 + 2), 0, 1.5, 0, () => banner(b, ban, 6, 0.9, 4.4));
}
function lantern(b: Builder) {
  b.add('stoneDark', cyl(0.18, 0.25, 1.1, 6));
  b.add('stoneDark', box(0.6, 0.5, 0.6), 0, 1.1, 0);
  b.add('window', box(0.3, 0.3, 0.62), 0, 1.2, 0);
  b.add('stoneDark', cone(0.55, 0.45, 6), 0, 1.6, 0);
}
function garden(b: Builder, r: number) {
  b.add('pond', cyl(r, r, 0.12, 20), 0, 0.02, 0);
  ring(6, r + 0.4, (x, z, _a, i) => b.add('rock', new THREE.IcosahedronGeometry(0.5 + (i % 3) * 0.25, 0), x, 0.2, z));
  // An arched timber bridge over the pond.
  for (let i = -2; i <= 2; i++) b.add('red', box(1.5, 0.18, 1.2), 0, 0.5 + (4 - i * i) * 0.16, i * 1.05);
  for (const s of [-1, 1]) for (let i = -2; i <= 2; i++) b.add('red', box(0.1, 0.7, 0.1), s * 0.7, 0.5 + (4 - i * i) * 0.16, i * 1.05);
}
function pagoda(b: Builder, tiers: number) {
  let y = 0;
  let w = 5;
  b.add('rock', box(w + 2, 0.8, w + 2));
  y += 0.8;
  for (let i = 0; i < tiers; i++) {
    b.add('red', box(w, 2.2, w), 0, y, 0);
    b.add('tileJ', sweptRoof(w, w, 1.5, 1.5, 0.7, 0), 0, y + 2.2, 0);
    y += 3.2;
    w *= 0.82;
  }
  b.add('gold', cyl(0.08, 0.12, 3.4, 6), 0, y, 0);
}
const japan: Kit = (b, L, ban) => {
  const sak = (x: number, z: number, s = 1) => tree(b, x, z, 'sakura', s);
  if (L === 1) {
    // A gate, a reception hall on a low stone base, a garden.
    b.at(0, 0, 13, 0, () => jgate(b, ban, false));
    b.at(0, 0, -3, 0, () => {
      ishigaki(b, 13, 9, 1.2, 0.8);
      b.at(0, 1.2, 0, 0, () => storey(b, 11, 7, 3.6, true));
    });
    b.at(-9, 0, 7, 0, () => garden(b, 2.6));
    b.at(7, 0, 8, 0, () => lantern(b));
    sak(10, 3);
    sak(-12, -2, 0.9);
    tree(b, 12, -8, 'pine');
    return;
  }
  const W = [0, 0, 17, 22, 26, 30][L]!;
  const D = [0, 0, 15, 19, 22, 25][L]!;
  if (L >= 3) ishigaki(b, W * 2 + 6, D * 2 + 6, 1.6, 2.2);
  const y0 = L >= 3 ? 1.6 : 0;
  b.at(0, y0, 0, 0, () => {
    // Enclosure walls with a gate on the front.
    b.add('sand', box(W * 2 + (L >= 3 ? 5.6 : 0), 0.24, D * 2 + (L >= 3 ? 5.6 : 0)), 0, -0.1, 0);
    jwall(b, -W, -D, W, -D);
    jwall(b, -W, -D, -W, D);
    jwall(b, W, D, W, -D);
    jwall(b, -4.5, D, -W, D);
    jwall(b, W, D, 4.5, D);
    b.at(0, 0, D, 0, () => jgate(b, ban, L >= 4));
    // The keep.
    const tiers = [0, 0, 2, 3, 4, 5][L]!;
    const kw = [0, 0, 10, 12, 14, 16][L]!;
    b.at(-W * 0.15, 0, -D * 0.3, 0, () => tenshu(b, tiers, kw, kw * 0.82, [0, 0, 3, 4.5, 5.5, 7][L]!));
    // Corner turrets (yagura).
    const yag: [number, number][] = L >= 5 ? [[-W, -D], [W, -D], [-W, D], [W, D]] : L >= 4 ? [[-W, D], [W, D], [W, -D]] : L >= 3 ? [[W, D], [-W, D]] : [[W, D]];
    for (const [x, z] of yag) b.at(x, 0, z, 0, () => tenshu(b, L >= 4 ? 2 : 1, 5.5, 5.5, 3.2));
    // The lord's hall and the garden.
    b.at(W * 0.5, 0, -D * 0.25, Math.PI / 2, () => {
      ishigaki(b, 13, 7.5, 0.9, 0.5);
      b.at(0, 0.9, 0, 0, () => storey(b, 12, 6.5, 3.4, true));
    });
    b.at(W * 0.45, 0, D * 0.5, 0, () => garden(b, L >= 4 ? 3.6 : 2.8));
    b.at(W * 0.45 + 5, 0, D * 0.5 + 2, 0, () => lantern(b));
    b.at(-W * 0.6, 0, D * 0.55, 0, () => lantern(b));
    if (L >= 4) b.at(-W * 0.62, 0, D * 0.35, 0, () => pagoda(b, L >= 5 ? 5 : 3));
    if (L >= 3) b.at(-W * 0.55, 0, -D * 0.1 + (L >= 4 ? -8 : 6), 0, () => {
      ishigaki(b, 8, 6, 0.8, 0.4);
      b.at(0, 0.8, 0, 0, () => storey(b, 7, 5, 3, true));
    });
    sak(W * 0.2, D * 0.7);
    sak(-W * 0.3, D * 0.75, 0.9);
    if (L >= 3) sak(W * 0.75, D * 0.15, 1.1);
    if (L >= 4) sak(-W * 0.8, -D * 0.5);
    tree(b, W * 0.8, -D * 0.7, 'pine');
    tree(b, -W * 0.8, D * 0.05, 'pine', 0.9);
  });
  // A stone-and-timber bridge to the gate, cherry trees along the approach.
  b.add('rock', box(6, 1.2, 9), 0, y0 - 1.3, D + 6.5);
  for (const s of [-1, 1]) b.add('red', box(0.2, 0.9, 9), s * 2.8, y0, D + 6.5);
  for (const s of [-1, 1]) {
    sak(s * 8, D + 9, 1.1);
    sak(s * 12, D + 2, 0.9);
    if (L >= 4) sak(s * 15, D + 12);
    if (L >= 5) sak(s * (W + 5), 0, 1.1);
  }
};

// ---------------------------------------------------------------------------
// Казахское ханство — the khan's yurt and its orda, carved gates, a domed brick mausoleum-hall
// ---------------------------------------------------------------------------
function kzGate(b: Builder, ban: string, h = 6) {
  for (const s of [-1, 1]) {
    b.add('wood', cyl(0.4, 0.5, h, 8), s * 3, 0, 0);
    b.add('gold', new THREE.SphereGeometry(0.42, 8, 6), s * 3, h + 0.3, 0);
  }
  b.add('wood', box(7.4, 0.6, 0.6), 0, h - 1, 0);
  b.add('bandKz', box(6, 0.9, 0.2), 0, h - 2, 0);
  for (const s of [-1, 1]) b.at(s * 5, 0, 0.5, 0, () => banner(b, ban, 8, 1.3, 3.4));
}
function mazar(b: Builder, w: number, h: number, towers: boolean) {
  b.add('brick', box(w + 1.2, 0.8, w + 1.2));
  b.add('brick', box(w, h, w), 0, 0.8, 0);
  // The portal: a tall frame with a pointed niche.
  b.add('brick', archWall(w * 0.62, h + 3.4, 1.4, w * 0.3, h * 0.78, true), 0, 0.8, w / 2 + 0.5);
  b.add('tileBlue', box(w * 0.62 + 0.2, 0.5, 1.5), 0, h + 4.2, w / 2 + 0.5);
  b.add('dark', box(w * 0.28, h * 0.7, 0.3), 0, 0.8, w / 2 - 0.1);
  // Drum and ribbed turquoise dome.
  b.add('brick', cyl(w * 0.4, w * 0.4, 2.2, 16), 0, h + 0.8, 0);
  b.add('tileBlue', cyl(w * 0.41, w * 0.41, 0.5, 16, true), 0, h + 2.3, 0);
  const R = w * 0.43;
  b.add('tileBlue', lathe([[R, h + 3], [R * 1.04, h + 3 + R * 0.35], [R * 0.86, h + 3 + R * 0.85], [R * 0.5, h + 3 + R * 1.2], [0.05, h + 3 + R * 1.42]], 20));
  b.add('gold', cyl(0.06, 0.06, 1.6, 5), 0, h + 3 + R * 1.4, 0);
  if (towers)
    for (const s of [-1, 1]) {
      b.add('brick', cyl(0.9, 1.1, h + 6, 10), s * (w / 2 + 0.2), 0, w / 2 + 0.4);
      b.add('tileBlue', lathe([[1.0, h + 6], [1.05, h + 6.5], [0.6, h + 7.4], [0.05, h + 7.9]], 10), s * (w / 2 + 0.2), 0, w / 2 + 0.4);
    }
}
const kazakh: Kit = (b, L, ban) => {
  const n = [0, 3, 5, 7, 9, 11][L]!;
  const khanR = [0, 0, 6, 7.5, 8.2, 9.5][L]!;
  if (L === 1) {
    ring(3, 8, (x, z, a) => b.at(x, 0, z, a + Math.PI, () => yurt(b, 3.4, 'kazakh')), 0.6);
    b.at(0, 0, 1, 0, () => campfire(b));
    b.at(6, 0, 9, 0, () => banner(b, ban, 6.5, 1.2, 3));
    b.add('woodLight', box(4, 0.15, 0.15), -7, 1.1, 8);
    for (const s of [-1, 1]) b.add('woodLight', cyl(0.1, 0.1, 1.2, 5), -7 + s * 1.9, 0, 8);
    return;
  }
  // The khan's yurt on a round platform, facing the gate.
  const ph = L >= 5 ? 2 : L >= 3 ? 1.1 : 0.4;
  b.add('stoneDark', cyl(khanR + 4, khanR + 4.6, ph, 28), 0, 0, -6);
  if (L >= 5) b.add('stoneDark', cyl(khanR + 7.5, khanR + 8.2, 0.9, 28), 0, 0, -6);
  b.add('stoneDark', box(5, ph * 0.5, 5), 0, 0, khanR + 0.5 - 6 + 4);
  b.at(0, ph, -6, 0, () => yurt(b, khanR, 'kazakh', { grand: true }));
  b.add('bandKz', box(3, 0.06, 6), 0, ph + 0.02, khanR - 6 + 2.5);
  // Yurts of the orda in an arc open to the gate.
  const R = khanR + (L >= 4 ? 19 : 15);
  ring(n - 1, R, (x, z, a, i) => b.at(x, 0, z - 6, a + Math.PI, () => yurt(b, 3.2 + ((i * 3) % 4) * 0.25, 'kazakh')), Math.PI * 0.32, Math.PI * 1.36);
  if (L >= 5) ring(6, R + 11, (x, z, a) => b.at(x, 0, z - 6, a + Math.PI, () => yurt(b, 3, 'kazakh')), Math.PI * 0.55, Math.PI * 0.9);
  b.at(0, 0, R - 2, 0, () => kzGate(b, ban, L >= 4 ? 7.5 : 6));
  // Tall standards around the platform.
  ring(L >= 4 ? 6 : 4, khanR + 3.2, (x, z) => b.at(x, ph, z - 6, 0, () => banner(b, ban, 9, 1.1, 3.2)), Math.PI * 0.25, Math.PI * 1.5);
  b.at(-9, 0, 12, 0, () => campfire(b));
  // Hitching rail and carts.
  b.add('woodLight', box(6, 0.15, 0.15), 11, 1.1, 14);
  for (const s of [-1, 0, 1]) b.add('woodLight', cyl(0.1, 0.1, 1.2, 5), 11 + s * 2.9, 0, 14);
  if (L >= 3) {
    // A low wattle fence closing the camp.
    ring(18, R + 5, (x, z, a) => {
      if (Math.abs(a - Math.PI * 2) < 0.4 || a < 0.4) return;
      const a2 = a + (Math.PI * 2) / 18;
      b.add('woodLight', box(Math.hypot(Math.sin(a2) * (R + 5) - x, Math.cos(a2) * (R + 5) - z), 1.2, 0.15), (x + Math.sin(a2) * (R + 5)) / 2, 0, (z + Math.cos(a2) * (R + 5)) / 2 - 6, a + Math.PI / 18);
    });
  }
  if (L >= 4) b.at(-R * 0.72, 0, -R * 0.62 - 6, Math.PI * 0.22, () => mazar(b, L >= 5 ? 12 : 9.5, L >= 5 ? 8 : 6.5, L >= 5));
  if (L >= 5) {
    // A brick caravan court at the entrance.
    for (const s of [-1, 1]) {
      b.at(s * 13, 0, R + 4, 0, () => {
        b.add('brick', box(14, 5, 3));
        for (let i = 0; i < 4; i++) b.add('dark', box(1.6, 3, 0.2), -5.2 + i * 3.4, 0, 1.55);
        b.add('tileBlue', box(14.4, 0.4, 3.4), 0, 5, 0);
      });
    }
  }
};

// ---------------------------------------------------------------------------
// Монгольская держава — the ruler's camp: a great ger, log palisades, watchtowers, standards, a timber palace
// ---------------------------------------------------------------------------
function tug(b: Builder, white: boolean, h = 8) {
  b.add('wood', cyl(0.08, 0.1, h, 6));
  b.add(white ? 'felt' : 'dark', cone(0.55, 1.5, 8), 0, h - 1.5, 0);
  b.add('gold', lathe([[0.02, h + 0.9], [0.22, h + 0.5], [0.05, h]], 6));
}
function cart(b: Builder) {
  b.add('woodLight', box(4.2, 0.3, 3), 0, 1.3, 0);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const w = cyl(1.2, 1.2, 0.25, 12);
      w.rotateX(Math.PI / 2);
      b.add('wood', w, sx * 1.5, 1.2 - 0.12, sz * 1.7);
    }
  b.add('woodLight', box(3.6, 0.15, 0.15), 3.6, 1.3, 0);
  b.at(0, 1.6, 0, 0, () => yurt(b, 1.9, 'mongolia'));
}
function palace(b: Builder, w: number, tiers: number) {
  b.add('stoneDark', box(w + 6, 1.4, w * 0.7 + 6));
  b.add('stoneDark', box(5, 0.7, 4), 0, 0, w * 0.35 + 4);
  let y = 1.4;
  let cw = w;
  for (let i = 0; i < tiers; i++) {
    const d = cw * 0.62;
    const h = i === 0 ? 5 : 3.2;
    const cols = Math.max(4, Math.round(cw / 3));
    for (let k = 0; k < cols; k++) for (const s of [-1, 1]) b.add('red', cyl(0.3, 0.3, h, 8), -cw / 2 + (cw / (cols - 1)) * k, y, (s * d) / 2);
    b.add('wood', box(cw - 1.2, h, d - 1.2), 0, y, 0);
    b.add('dark', box(2.4, h * 0.7, 0.2), 0, y, d / 2 - 0.5);
    b.add('tileGreen', sweptRoof(cw, d, i === tiers - 1 ? 3.6 : 2, 2, 1.1, cw * 0.55), 0, y + h, 0);
    y += h + 1.2;
    cw *= 0.7;
  }
  b.add('gold', lathe([[0.05, y + 3.2], [0.5, y + 2.2], [0.25, y + 1.6]], 8), 0, 0.8, 0);
}
const mongolia: Kit = (b, L, ban) => {
  if (L === 1) {
    b.at(-4, 0, -2, 0.3, () => yurt(b, 3.6, 'mongolia'));
    b.at(5, 0, -4, -0.4, () => yurt(b, 3.1, 'mongolia'));
    b.at(6, 0, 5, 0.5, () => cart(b));
    b.at(0, 0, 4, 0, () => campfire(b));
    b.at(-6, 0, 7, 0, () => tug(b, false));
    b.at(-8, 0, 6, 0, () => banner(b, ban, 6, 1.1, 2.8));
    return;
  }
  const R = [0, 0, 20, 26, 31, 36][L]!;
  const gerR = [0, 0, 6, 7.4, 8, 9.4][L]!;
  // The palisade: a ring of logs with a gate framed by tall posts and watchtowers.
  const seg = L >= 3 ? 20 : 12;
  ring(seg, R, (x, z, a, i) => {
    const a2 = a + (Math.PI * 2) / seg;
    if (i === 0 || i === seg - 1) return;
    if (L === 2 && i > 3 && i < seg - 4) return; // level 2: only the front is fenced
    palisade(b, x, z, Math.sin(a2) * R, Math.cos(a2) * R, L >= 4 ? 5 : 4.2);
  });
  const ga = (Math.PI * 2) / seg;
  for (const s of [-1, 1]) {
    b.add('logs', cyl(0.5, 0.6, 8.5, 8), Math.sin(ga) * R * s, 0, Math.cos(ga) * R);
    b.at(Math.sin(ga) * R * s + s * 5.5, 0, Math.cos(ga) * R - 1, 0, () => watchtower(b, L >= 4 ? 13 : 10, L >= 4 ? 'tileGreen' : 'woodLight'));
  }
  b.add('logs', box(Math.sin(ga) * R * 2 + 1.5, 0.7, 0.7), 0, 7.6, Math.cos(ga) * R);
  b.at(0, 7.4, Math.cos(ga) * R + 0.45, 0, () => hanging(b, ban, 1.6, 3));
  if (L >= 4) for (const s of [-1, 1]) b.at(s * R * 0.72, 0, -R * 0.72, 0, () => watchtower(b, 12, 'tileGreen'));
  // The great ger on a timber platform.
  const ph = L >= 3 ? 1.2 : 0.3;
  const gz = L >= 4 ? 4 : -2;
  b.add('woodLight', cyl(gerR + 3.4, gerR + 3.8, ph, 8), 0, 0, gz);
  b.add('woodLight', box(4.4, ph * 0.5, 4), 0, 0, gz + gerR + 4.4);
  b.at(0, ph, gz, 0, () => yurt(b, gerR, 'mongolia', { grand: true }));
  if (L >= 5) b.add('gold', lathe([[gerR * 0.26, ph + gerR * 0.94], [gerR * 0.2, ph + gerR * 1.1], [0.05, ph + gerR * 1.22]], 12), 0, 0, gz);
  // Gers of the camp.
  const n = [0, 0, 3, 5, 7, 10][L]!;
  ring(n, R * 0.66, (x, z, a, i) => b.at(x, 0, z, a + Math.PI, () => yurt(b, 3 + (i % 3) * 0.3, 'mongolia')), Math.PI * 0.42, Math.PI * 1.16);
  // Standards: the dark war standard and the white standards of peace.
  b.at(-5.5, 0, gz + gerR + 7, 0, () => tug(b, false, 9));
  if (L >= 3) b.at(5.5, 0, gz + gerR + 7, 0, () => tug(b, true, 9));
  if (L >= 4) for (let i = 0; i < 9; i++) b.at(-10 + i * 2.5, 0, R * 0.74, 0, () => tug(b, true, 6.5));
  b.at(9, 0, R * 0.5, 0.4, () => cart(b));
  b.at(-10, 0, R * 0.42, 0, () => campfire(b));
  for (const s of [-1, 1]) b.at(s * 3.4, 0, Math.cos(ga) * R + 3, 0, () => banner(b, ban, 7.5, 1.1, 3));
  // From level 4: a timber palace with swept green roofs behind the great ger.
  if (L >= 4) b.at(0, 0, -R * 0.5, 0, () => palace(b, L >= 5 ? 22 : 17, L >= 5 ? 3 : 2));
  if (L >= 5) {
    // An outer fence of the herds and a second gate.
    ring(26, R + 12, (x, z, a, i) => {
      if (i < 2 || i > 23) return;
      const a2 = a + (Math.PI * 2) / 26;
      const x2 = Math.sin(a2) * (R + 12);
      const z2 = Math.cos(a2) * (R + 12);
      b.add('woodLight', box(Math.hypot(x2 - x, z2 - z), 0.18, 0.18), (x + x2) / 2, 1.1, (z + z2) / 2, -Math.atan2(z2 - z, x2 - x));
      b.add('woodLight', cyl(0.12, 0.12, 1.4, 5), x, 0, z);
    });
  }
};

export const KITS: Record<CivId, Kit> = { camelot, japan, kazakh, mongolia };

// ---------------------------------------------------------------------------
// The neutral centre of the commonwealth
// ---------------------------------------------------------------------------
/** The palace of the Great Round Table: a domed rotunda with four equal wings — one per civilization, none above the others. */
export function greatPalace(b: Builder, ban: string) {
  b.add('stoneDark', cyl(40, 42, 2.4, 40));
  b.add('marble', cyl(34, 34, 0.6, 40), 0, 2.4, 0);
  const y = 3;
  // Grand stairs on four sides.
  for (let i = 0; i < 4; i++) b.at(0, 0, 0, (i * Math.PI) / 2, () => {
    for (let s = 0; s < 6; s++) b.add('marble', box(12, 0.5, 1.4), 0, s * 0.5, 44.6 - s * 1.4);
  });
  // The rotunda.
  b.add('stone', cyl(15, 15.6, 13, 32), 0, y, 0);
  ring(16, 15.3, (x, z, a) => {
    b.add('marble', cyl(0.75, 0.85, 11, 10), x * 1.09, y, z * 1.09);
    b.add('window', box(1.6, 5.5, 0.2), x, y + 3.5, z, a);
  });
  b.add('stone', cyl(17.6, 17.6, 1.4, 32), 0, y + 11, 0);
  b.add('stone', cyl(12.5, 13, 5, 32), 0, y + 13, 0);
  ring(12, 12.8, (x, z, a) => b.add('window', box(1.3, 2.8, 0.2), x, y + 14, z, a));
  const R = 12.6;
  const dy = y + 18;
  b.add('copper', lathe([[R, dy], [R * 1.02, dy + R * 0.3], [R * 0.9, dy + R * 0.62], [R * 0.62, dy + R * 0.9], [R * 0.26, dy + R * 1.04], [0.4, dy + R * 1.08]], 32));
  b.add('gold', cyl(1.6, 2.1, 2.2, 12), 0, dy + R * 1.06, 0);
  b.add('gold', lathe([[1.2, dy + R * 1.06 + 2.2], [0.9, dy + R * 1.06 + 3.6], [0.06, dy + R * 1.06 + 6.4]], 10));
  // Four wings with corner towers.
  for (let i = 0; i < 4; i++)
    b.at(0, y, 0, (i * Math.PI) / 2, () => {
      b.add('stone', box(13, 10, 14), 0, 0, 21);
      b.add('slate', gable(14.4, 13, 4.5, 0.4), 0, 10, 21, Math.PI / 2);
      b.add('stone', archWall(13, 12.5, 1.6, 4.4, 8), 0, 0, 28.6);
      b.add('dark', box(4.2, 7.6, 0.3), 0, 0, 28);
      for (const s of [-1, 1]) {
        b.add('marble', cyl(0.6, 0.7, 9, 10), s * 4.6, 0, 29.8);
        b.add('window', box(1.2, 4.5, 0.2), s * 4.2, 3, 28.05);
        b.at(s * 3.4, 12.2, 29.5, 0, () => hanging(b, ban, 1.6, 5.4));
      }
      b.at(15.5, 0, 15.5, 0, () => {
        roundTower(b, 'stone', 3.4, 17, 'slate', { roofH: 9 });
      });
    });
}
/** The Great Library (chronicle and decisions) with the Higher Archive as a rotunda with its own entrance. */
export function library(b: Builder) {
  b.add('stoneDark', box(46, 1.6, 22));
  b.add('stone', box(40, 11, 15), 0, 1.6, 0);
  b.add('copper', gable(41, 16, 5.5, 0.6), 0, 12.6, 0);
  for (let i = 0; i < 10; i++) {
    const x = -18 + i * 4;
    b.add('marble', cyl(0.65, 0.75, 9.6, 10), x, 1.6, 9.2);
    b.add('window', box(1.5, 6, 0.2), x + 2, 4, 7.55);
  }
  b.add('stone', box(41, 1.4, 4.4), 0, 11.2, 8.6);
  for (let s = 0; s < 4; s++) b.add('marble', box(16, 0.4, 1.3), 0, s * 0.4, 12.4 - s * 1.3 + 2);
  b.add('dark', box(3.6, 6.4, 0.3), 0, 1.6, 7.6);
  // The archive rotunda on the right end.
  b.at(27, 0, -1, 0, () => {
    b.add('stoneDark', cyl(11, 11.6, 1.6, 28));
    b.add('stone', cyl(8.6, 8.6, 10, 28), 0, 1.6, 0);
    ring(10, 8.7, (x, z, a) => b.add('window', box(1.1, 4.4, 0.2), x, 4.6, z, a));
    b.add('stone', cyl(9.4, 9.4, 0.9, 28), 0, 11.6, 0);
    b.add('tileBlue', lathe([[8.8, 12.5], [8.6, 14.5], [7, 17.4], [4, 19.4], [0.3, 20.2]], 28));
    b.add('gold', cyl(0.1, 0.1, 2.6, 6), 0, 20.2, 0);
    b.add('stone', archWall(5.4, 7.4, 1.4, 2.6, 5), 0, 1.6, 9);
    b.add('dark', box(2.5, 4.9, 0.3), 0, 1.6, 8.6);
    for (let s = 0; s < 3; s++) b.add('marble', box(6, 0.5, 1.2), 0, s * 0.5, 12 - s * 1.2);
  });
  b.add('stone', box(8, 7, 6), 18, 1.6, -1);
}
/** The achievements plaza: a fountain and one pedestal per achievement really earned by the castles. */
export function plaza(b: Builder, pedestals: number) {
  b.add('cobble', cyl(24, 24, 0.5, 40));
  b.add('marble', cyl(25, 25, 0.35, 40, true));
  b.add('marble', cyl(6.4, 6.8, 1, 24), 0, 0.5, 0);
  b.add('pond', cyl(5.8, 5.8, 0.1, 24), 0, 1.42, 0);
  b.add('marble', cyl(1.1, 1.5, 3.4, 12), 0, 0.5, 0);
  b.add('marble', cyl(2.4, 0.9, 0.5, 16), 0, 3.9, 0);
  b.add('gold', lathe([[0.05, 7], [0.7, 5.8], [0.35, 4.4]], 10));
  const n = Math.min(pedestals, 16);
  ring(n, 17, (x, z, a) => {
    b.at(x, 0.5, z, a, () => {
      b.add('marble', box(1.6, 2.2, 1.6));
      b.add('gold', lathe([[0.5, 2.2], [0.75, 2.9], [0.3, 3.5], [0.5, 3.9], [0.05, 4.1]], 8));
    });
  }, 0.3);
}
