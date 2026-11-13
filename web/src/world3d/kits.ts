import * as THREE from 'three';
import { Builder, archWall, banner, box, cone, conifer, curtain, cyl, foliage, gable, hall, hanging, lathe, merlons, palisade, roundTower, squareTower, sweptRoof, watchtower, yurt } from './geo';
import type { MatKey } from './tex';

/**
 * Four civilizations × five levels (ADR-0026). Each kit is an original composition with its own
 * architectural grammar; a level adds and replaces structures — it is never a recolour.
 * All kits face +Z (their gate looks at the centre of the commonwealth) and fit a 60 m radius.
 * `ban` is the material key of the district's banner cloth.
 */
export type CivId = 'camelot' | 'japan' | 'kazakh' | 'mongolia' | 'russia';
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
  // A fire in the open smokes too (ADR-0045).
  b.hearth(0, 1, 0);
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
    b.mark('growth', -5, 0, -4).mark('council', 5, 0, -3).mark('staff', 4, 0, 6).mark('tasks', -6, 0, 6).mark('initiatives', 0, 0, 3);
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
  // Where the sections of the town live (the pins of the 3D town): a building once it is built.
  b.mark('growth', L >= 3 ? -W * 0.25 : 0, 0, -D * 0.35).mark('warriors', 0, 0, D).mark('archive', W, 0, -D).mark('staff', -W * 0.55, 0, D * 0.45).mark('initiatives', 0, 0, D * 0.42);
  if (L >= 3) b.mark('council', W * 0.45, 0, -D * 0.3).mark('tasks', W * 0.5, 0, D * 0.45);
  if (L >= 4) b.mark('library', -W * 0.6, 0, -D * 0.05);
  // Until their buildings are built, the sections keep to a tower and the building site.
  b.mark('library', -W, 0, -D).mark('council', -W, 0, D).mark('tasks', L === 2 ? W * 0.5 : W, 0, L === 2 ? -D * 0.4 : D);
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
    b.mark('growth', 0, 0, -3).mark('warriors', 0, 0, 13).mark('initiatives', -9, 0, 7).mark('tasks', 7, 0, 8);
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
    // A workshop by the front wall: where the tasks of the district are done.
    b.at(-W * 0.3, 0, D * 0.52, 0, () => {
      ishigaki(b, 7.5, 5.4, 0.6, 0.3);
      b.at(0, 0.6, 0, 0, () => storey(b, 6.5, 4.4, 2.8, true));
    });
    // Where the sections of the town live (the pins of the 3D town).
    b.mark('growth', -W * 0.15, 0, -D * 0.3).mark('council', W * 0.5, 0, -D * 0.25).mark('warriors', 0, 0, D).mark('initiatives', W * 0.45, 0, D * 0.5);
    b.mark('tasks', -W * 0.3, 0, D * 0.52).mark('staff', W, 0, D);
    if (L >= 4) b.mark('library', -W * 0.62, 0, D * 0.35);
    if (L >= 3) b.mark('archive', -W * 0.55, 0, -D * 0.1 + (L >= 4 ? -8 : 6));
    if (L >= 3) b.mark('library', -W, 0, D);
    b.at(W * 0.45 + 5, 0, D * 0.5 + 2, 0, () => lantern(b));
    b.at(-W * 0.6, 0, D * 0.55, 0, () => lantern(b));
    if (L >= 4) b.at(-W * 0.62, 0, D * 0.35, 0, () => pagoda(b, L >= 5 ? 5 : 3));
    if (L >= 3) b.at(-W * 0.55, 0, -D * 0.1 + (L >= 4 ? -8 : 6), 0, () => {
      ishigaki(b, 8, 6, 0.8, 0.4);
      b.at(0, 0.8, 0, 0, () => storey(b, 7, 5, 3, true));
    });
    sak(W * 0.2, D * 0.7);
    sak(-W * 0.55, D * 0.78, 0.9);
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
    ring(3, 8, (x, z, a, i) => {
      b.mark(['growth', 'staff', 'library'][i]!, x, 0, z);
      b.at(x, 0, z, a + Math.PI, () => yurt(b, 3.4, 'kazakh'));
    }, 0.6);
    b.mark('initiatives', 0, 0, 1).mark('warriors', 6, 0, 9).mark('tasks', -7, 0, 8);
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
  // Where the sections of the town live: the khan's yurt is the council, the mazar keeps the growth of the district.
  b.mark('council', 0, 0, -6).mark('warriors', 0, 0, R - 2).mark('initiatives', -9, 0, 12).mark('tasks', 11, 0, 14);
  if (L >= 4) b.mark('growth', -R * 0.72, 0, -R * 0.62 - 6);
  ring(n - 1, R, (x, z, a, i) => {
    const id = i === 0 ? 'staff' : i === 1 ? 'archive' : i === n - 2 ? 'library' : i === Math.floor((n - 1) / 2) ? 'growth' : null;
    if (id) b.mark(id, x, 0, z - 6);
    b.at(x, 0, z - 6, a + Math.PI, () => yurt(b, 3.2 + ((i * 3) % 4) * 0.25, 'kazakh'));
  }, Math.PI * 0.32, Math.PI * 1.36);
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
    b.mark('growth', -4, 0, -2).mark('staff', 5, 0, -4).mark('tasks', 6, 0, 5).mark('initiatives', 0, 0, 4).mark('warriors', -6, 0, 7);
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
  // Where the sections of the town live: the great ger is the council, the palace (once built) keeps the growth.
  b.mark('council', 0, 0, gz).mark('warriors', 0, 0, Math.cos(ga) * R).mark('initiatives', -10, 0, R * 0.42).mark('tasks', 9, 0, R * 0.5);
  b.mark('staff', Math.sin(ga) * R + 5.5, 0, Math.cos(ga) * R - 1).mark('archive', -Math.sin(ga) * R - 5.5, 0, Math.cos(ga) * R - 1);
  if (L >= 4) b.mark('growth', 0, 0, -R * 0.5);
  ring(n, R * 0.66, (x, z, a, i) => {
    if (i === 0) b.mark('library', x, 0, z);
    if (i === n - 1) b.mark('growth', x, 0, z);
    b.at(x, 0, z, a + Math.PI, () => yurt(b, 3 + (i % 3) * 0.3, 'mongolia'));
  }, Math.PI * 0.42, Math.PI * 1.16);
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

// ---------------------------------------------------------------------------
// Русское царство (Moscow of the XVI–XVII centuries): from a timber ostrog to a red-brick kremlin with
// white cathedrals, tent-roofed towers, a boyar terem and trading rows. Original compositions: no
// existing building is copied.
// ---------------------------------------------------------------------------
/** «Шатёр»: an eight-sided tent roof with a small gilded onion on top. */
function shatyor(b: Builder, r: number, h: number, mat: MatKey = 'copper') {
  b.add(mat, cyl(r * 1.04, r * 1.04, 0.3, 8));
  b.add(mat, cone(r, h, 8), 0, 0.3, 0);
  b.add('gold', lathe([[0.02, h + 0.1], [0.3, h + 0.5], [0.24, h + 0.9], [0.03, h + 1.5]], 8));
}
/** An onion dome on a drum with slit windows. */
function onion(b: Builder, r: number, mat: MatKey, drum = r * 1.5) {
  b.add('plaster', cyl(r * 0.72, r * 0.78, drum, 12));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    b.add('dark', box(0.22 * r + 0.12, drum * 0.5, 0.1), Math.sin(a) * r * 0.76, drum * 0.28, Math.cos(a) * r * 0.76, a);
  }
  b.add(mat, lathe([[r * 0.76, drum], [r * 1.1, drum + r * 0.45], [r * 1.02, drum + r * 0.95], [r * 0.58, drum + r * 1.5], [r * 0.18, drum + r * 1.95], [0.03, drum + r * 2.4]], 14));
  b.add('gold', cyl(0.05, 0.05, r * 0.9 + 0.4, 5), 0, drum + r * 2.35, 0);
  b.add('gold', box(r * 0.5 + 0.2, 0.08, 0.08), 0, drum + r * 2.9 + 0.2, 0);
}
/** A wall tower: square, battlemented, with a lookout tier under a tent roof. */
function rusTower(b: Builder, wall: MatKey, w: number, h: number, roofH: number, roof: MatKey = 'copper') {
  squareTower(b, wall, w, w, h, { windows: 2, crenel: wall !== 'logs' });
  b.at(0, h + 0.6, 0, 0, () => {
    b.add(wall, box(w * 0.62, 2.2, w * 0.62));
    b.add('dark', box(w * 0.3, 1.1, w * 0.64), 0, 0.6, 0);
    b.add('dark', box(w * 0.64, 1.1, w * 0.3), 0, 0.6, 0);
    b.at(0, 2.2, 0, Math.PI / 8, () => shatyor(b, w * 0.5, roofH, roof));
  });
}
/** The gate tower: a taller, tiered tower with a passage. */
function rusGate(b: Builder, ban: string, wall: MatKey, w: number, h: number, grand: boolean) {
  b.add(wall, archWall(w, h, w, w * 0.42, Math.min(5, h * 0.5)), 0, 0, 0);
  b.add(wall, box(w + 1, 0.6, w + 1), 0, h, 0);
  if (wall !== 'logs') for (const s of [-1, 1]) b.at(0, 0, (s * (w + 1)) / 2 - s * 0.25, 0, () => merlons(b, wall, w + 1, h + 0.6, 0));
  b.at(0, h + 0.6, 0, 0, () => {
    b.add(wall, box(w * 0.66, grand ? 5 : 3, w * 0.66));
    for (const s of [-1, 1]) b.add('window', box(0.6, 1.4, 0.12), 0, (grand ? 5 : 3) * 0.35, (s * w * 0.66) / 2 + s * 0.02);
    b.at(0, grand ? 5 : 3, 0, 0, () => {
      if (grand) {
        b.add(wall, cyl(w * 0.26, w * 0.3, 3, 8));
        b.at(0, 3, 0, 0, () => shatyor(b, w * 0.3, w * 1.1, 'copper'));
      } else b.at(0, 0, 0, Math.PI / 8, () => shatyor(b, w * 0.42, w * 0.9, wall === 'logs' ? 'woodLight' : 'copper'));
    });
  });
  b.at(0, h - 0.3, w / 2 + 0.62, 0, () => hanging(b, ban, 2.2, 4.4));
}
/** A white-stone cathedral: a cube with apses, a portal and one or five domes. */
function cathedral(b: Builder, w: number, h: number, domes: 1 | 5, side: MatKey = 'gold') {
  b.add('plaster', box(w + 1, 0.7, w + 1));
  b.add('plaster', box(w, h, w), 0, 0.7, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('plaster', box(0.9, h + 0.4, 0.9), (sx * w) / 2, 0.7, (sz * w) / 2);
  // Rounded gables along the top of every wall («закомары»).
  for (let k = -1; k <= 1; k++)
    for (const s of [-1, 1]) {
      b.add('plaster', cyl(w / 6.4, w / 6.4, 0.5, 12), (k * w) / 3.1, h + 0.45, (s * w) / 2 - s * 0.25).add('plaster', cyl(w / 6.4, w / 6.4, 0.5, 12), (s * w) / 2 - s * 0.25, h + 0.45, (k * w) / 3.1);
    }
  for (const x of [-w * 0.3, 0, w * 0.3]) b.add('plaster', cyl(w * 0.15, w * 0.15, h * 0.72, 10), x, 0.7, -w / 2);
  b.add('dark', box(w * 0.2, h * 0.42, 0.3), 0, 0.7, w / 2);
  b.add('gold', box(w * 0.26, 0.3, 0.4), 0, 0.7 + h * 0.44, w / 2);
  for (const s of [-1, 1]) for (const x of [-w * 0.3, w * 0.3]) b.add('window', box(0.5, h * 0.3, 0.12), x, h * 0.45, (s * w) / 2 + s * 0.02);
  b.add('copper', box(w + 0.3, 0.5, w + 0.3), 0, h + 0.7, 0);
  b.at(0, h + 1.2, 0, 0, () => onion(b, w * (domes === 5 ? 0.19 : 0.24), 'gold', w * (domes === 5 ? 0.42 : 0.36)));
  if (domes === 5) for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at(sx * w * 0.3, h + 1.2, sz * w * 0.3, 0, () => onion(b, w * 0.115, side, w * 0.2));
}
/** A bell tower: an eight-sided pillar in three tiers with open arches for the bells. */
function belfry(b: Builder, h: number) {
  b.add('plaster', cyl(2.5, 2.9, h * 0.46, 8));
  b.add('plaster', cyl(2.9, 2.9, 0.5, 8), 0, h * 0.46, 0);
  b.add('plaster', cyl(2, 2.2, h * 0.3, 8), 0, h * 0.46 + 0.5, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.add('dark', box(0.9, h * 0.13, 0.14), Math.sin(a) * 2.02, h * 0.6, Math.cos(a) * 2.02, a);
  }
  b.add('plaster', cyl(2.3, 2.3, 0.4, 8), 0, h * 0.76 + 0.5, 0);
  b.at(0, h * 0.76 + 0.9, 0, 0, () => onion(b, 1.5, 'gold', h * 0.14));
}
/** A boyar's terem: a white ground floor, a painted upper floor, steep roofs and a tent-roofed porch. */
function terem(b: Builder, w: number, d: number, tower: boolean) {
  b.add('plaster', box(w, 3.2, d));
  for (let k = 0; k < Math.floor(w / 2.6); k++) b.add('dark', box(0.9, 1.5, 0.14), -w / 2 + 1.5 + k * 2.6, 0.7, d / 2);
  b.at(0, 3.2, 0, 0, () => hall(b, 'brickRed', 'tileGreen', w * 0.96, d * 0.9, 3, 3.6));
  if (tower)
    b.at(-w * 0.32, 6.2, 0, 0, () => {
      b.add('brickRed', box(d * 0.62, 3.4, d * 0.62));
      for (const s of [-1, 1]) b.add('window', box(0.55, 1.3, 0.12), 0, 1, (s * d * 0.62) / 2 + s * 0.02);
      b.at(0, 3.4, 0, Math.PI / 8, () => shatyor(b, d * 0.42, 5, 'tileGreen'));
    });
  // The red porch with a flight of steps.
  b.at(w * 0.3, 0, d / 2 + 2.2, 0, () => {
    for (let k = 0; k < 6; k++) b.add('plaster', box(2.6, 0.5, 0.7), 0, k * 0.5, 2.4 - k * 0.7);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('plaster', cyl(0.22, 0.26, 2.6, 8), sx * 1.2, 3, -1.6 + sz * 0.9);
    b.at(0, 5.6, -1.6, Math.PI / 4, () => shatyor(b, 2, 2.6, 'tileGreen'));
  });
}
/** Trading rows: a long arcade under a plank roof. */
function rows(b: Builder, len: number) {
  b.add('plaster', box(len, 3, 4));
  for (let k = 0; k < Math.floor(len / 2.6); k++) b.add('dark', box(1.5, 2, 0.2), -len / 2 + 1.5 + k * 2.6, 0, 2);
  b.at(0, 3, 0, 0, () => b.add('wood', gable(len + 0.8, 5, 1.6, 0.5)));
  // Market stalls under awnings in front of the arcade.
  for (let k = 0; k < 3; k++)
    b.at(-len / 3 + (k * len) / 3, 0, 6, 0, () => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('wood', cyl(0.08, 0.08, 2.2, 5), sx * 1.3, 0, sz * 0.9);
      b.add(k % 2 ? 'red' : 'woodLight', box(3, 0.14, 2.2), 0, 2.2, 0);
      b.add('wood', box(2.4, 0.9, 1), 0, 0, 0);
    });
}
/** A timber church: a log body with a tall tent roof and a small onion. */
function logChurch(b: Builder, w = 5) {
  b.add('logs', box(w, 4.5, w));
  b.add('logs', box(w * 0.6, 3.4, w * 0.6), 0, 0, w * 0.8);
  b.add('dark', box(1, 2, 0.2), 0, 0, w * 1.1);
  b.at(0, 4.5, 0, Math.PI / 8, () => {
    b.add('logs', cyl(w * 0.5, w * 0.56, 1.6, 8));
    b.at(0, 1.6, 0, 0, () => b.add('woodLight', cone(w * 0.56, w * 1.5, 8)));
    b.at(0, 1.6 + w * 1.5 - 0.6, 0, 0, () => onion(b, 0.5, 'woodLight', 0.5));
  });
}
function russia(b: Builder, L: number, ban: string) {
  const izba = (x: number, z: number, r = 0) => b.at(x, 0, z, r, () => hall(b, 'logs', 'woodLight', 6.5, 5, 2.8, 2.4, { chimney: true }));
  if (L === 1) {
    // An ostrog on the frontier: a ring of sharpened logs, a watchtower, a chapel and two izbas.
    const R = 14;
    ring(9, R, (x, z, a) => {
      const a2 = a + (Math.PI * 2) / 9;
      palisade(b, x, z, Math.sin(a2) * R, Math.cos(a2) * R, 4.2);
    }, -Math.PI / 9);
    b.mark('growth', -6, 0, -5).mark('library', 4.5, 0, -4).mark('tasks', -4.5, 0, 5).mark('staff', 5, 0, 5.5).mark('initiatives', 0, 0, 2);
    b.at(-6, 0, -5, 0, () => watchtower(b, 10, 'woodLight'));
    b.at(4.5, 0, -4, 0, () => logChurch(b, 4.2));
    izba(-4.5, 5, 0.2);
    izba(5, 5.5, -0.3);
    b.at(0, 0, 2, 0, () => campfire(b));
    b.at(1.5, 0, R + 1, 0, () => banner(b, ban, 6.5));
    return;
  }
  const W = [0, 0, 16, 21, 26, 30][L]!;
  const D = [0, 0, 14, 18, 22, 25][L]!;
  const wallH = [0, 0, 5.4, 7, 8.6, 9.6][L]!;
  const front: MatKey = L >= 3 ? 'brickRed' : 'logs';
  const rest: MatKey = L >= 4 ? 'brickRed' : 'logs';
  const wall = (mat: MatKey, ax: number, az: number, bx: number, bz: number) => (mat === 'logs' ? palisade(b, ax, az, bx, bz, wallH) : curtain(b, mat, ax, az, bx, bz, wallH, 2));
  b.add('sand', box(W * 2, 0.24, D * 2), 0, -0.1, 0);
  if (L >= 4) b.add('cobble', box(W * 1.1, 0.3, D * 1.2), 0, -0.06, D * 0.15);
  const gw = L >= 4 ? 8 : 6.5;
  wall(rest, -W, -D, W, -D);
  wall(rest, -W, -D, -W, D);
  wall(rest, W, D, W, -D);
  wall(front, -gw / 2 - 0.4, D, -W, D);
  wall(front, W, D, gw / 2 + 0.4, D);
  b.at(0, 0, D, 0, () => rusGate(b, ban, front, gw, wallH + (L >= 4 ? 5 : 3), L >= 4));
  // Corner towers; brick ones first appear on the front, towards the road.
  const tw = L >= 4 ? 5.4 : 4.4;
  const th = wallH + (L >= 5 ? 6 : L >= 4 ? 5 : 3.4);
  for (const [x, z] of [[-W, -D], [W, -D], [-W, D], [W, D]] as [number, number][]) {
    const mat = z > 0 ? front : rest;
    b.at(x, 0, z, 0, () => rusTower(b, mat, tw, th, mat === 'logs' ? 4.5 : L >= 5 ? 7.5 : 6, mat === 'logs' ? 'woodLight' : 'copper'));
  }
  if (L >= 4) for (const [x, z] of [[-W, 0], [W, 0], [0, -D]] as [number, number][]) b.at(x, 0, z, 0, () => rusTower(b, 'brickRed', 4.6, th - 2.5, 5, 'copper'));
  if (L >= 5) for (const [x, z] of [[-W * 0.5, D], [W * 0.5, D], [-W * 0.5, -D], [W * 0.5, -D]] as [number, number][]) b.at(x, 0, z, 0, () => rusTower(b, 'brickRed', 4, th - 4, 4.4, 'tileGreen'));
  // Where the sections of the town live (the pins of the 3D town): a building once it is built.
  b.mark('growth', L === 2 ? -W * 0.3 : -W * 0.22, 0, L === 2 ? -D * 0.25 : -D * 0.28).mark('council', W * 0.4, 0, -D * 0.38).mark('warriors', 0, 0, D);
  b.mark('tasks', -W * 0.6, 0, D * 0.55).mark('initiatives', L >= 3 ? -W * 0.55 : 0, 0, L >= 3 ? D + 7 : D * 0.3);
  if (L >= 4) b.mark('archive', -W * 0.62, 0, -D * 0.5).mark('library', W * 0.62, 0, D * 0.05);
  b.mark('staff', L >= 5 ? -W * 0.55 : W * 0.15, 0, L >= 5 ? D * 0.25 : D * 0.5);
  // Before the bell tower and the chambers are built, the archive and the books keep to the rear towers and an izba.
  b.mark('archive', -W, 0, -D);
  if (L === 3) b.mark('library', -W * 0.2, 0, D * 0.55);
  b.mark('library', W, 0, -D);
  // The heart of the town: the cathedral, the bell tower, the terem.
  if (L === 2) b.at(-W * 0.3, 0, -D * 0.25, 0, () => logChurch(b, 5.4));
  else b.at(-W * 0.22, 0, -D * 0.28, 0, () => cathedral(b, [0, 0, 0, 8.5, 11, 12.5][L]!, [0, 0, 0, 8, 10, 11.5][L]!, L >= 4 ? 5 : 1));
  if (L >= 4) b.at(-W * 0.62, 0, -D * 0.5, 0, () => belfry(b, L >= 5 ? 30 : 23));
  b.at(W * 0.4, 0, -D * 0.38, 0, () => terem(b, [0, 0, 9, 12, 15, 18][L]!, [0, 0, 6, 7, 8, 9][L]!, L >= 3));
  if (L >= 5) {
    // A second church with painted domes and the treasury chambers.
    b.at(W * 0.5, 0, D * 0.42, -Math.PI / 2, () => cathedral(b, 7, 6.5, 5, 'tileBlue'));
    b.at(-W * 0.55, 0, D * 0.25, Math.PI / 2, () => terem(b, 11, 6.5, false));
  }
  izba(-W * 0.6, D * 0.55, 0.1);
  izba(W * 0.15, D * 0.5, -0.2);
  if (L >= 3) izba(-W * 0.2, D * 0.55, 0.3);
  if (L >= 4) b.at(W * 0.62, 0, D * 0.05, Math.PI / 2, () => hall(b, 'plaster', 'tileGreen', 12, 6, 4, 3.4, { chimney: true }));
  for (const s of [-1, 1]) b.at(s * (gw / 2 + 2.4), 0, D - 4.5, 0, () => banner(b, ban, 7, 1.3, 3.2));
  // The posad before the gate: trading rows and carts.
  if (L >= 3) b.at(-W * 0.55, 0, D + 7, 0, () => rows(b, L >= 4 ? 16 : 11));
  if (L >= 5) b.at(W * 0.55, 0, D + 7, 0, () => rows(b, 16));
  // Before the rows are built, two market stalls stand at the gate.
  if (L === 2)
    for (const [x, r, top] of [[W * 0.55, 0.3, 'red'], [W * 0.78, -0.2, 'woodLight']] as [number, number, MatKey][])
      b.at(x, 0, D + 5, r, () => {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add('wood', cyl(0.08, 0.08, 2.2, 5), sx * 1.3, 0, sz * 0.9);
        b.add(top, box(3, 0.14, 2.2), 0, 2.2, 0);
        b.add('wood', box(2.4, 0.9, 1), 0, 0, 0);
      });
  for (const [x, z] of [[-W - 6, -D * 0.4], [W + 6, D * 0.3], [-W - 5, D * 0.6]] as [number, number][]) tree(b, x, z, 'leaf', 1.1);
}

export const KITS: Record<CivId, Kit> = { camelot, japan, kazakh, mongolia, russia };

// ---------------------------------------------------------------------------
// The neutral centre of the commonwealth
// ---------------------------------------------------------------------------
/** A four-sided spire whose faces look along the axes; `half` is half the side of its base. */
function pyramid(half: number, h: number) {
  const g = cone(half * Math.SQRT2, h, 4);
  g.rotateY(Math.PI / 4);
  return g;
}
/**
 * A row of lancet windows on a wall that faces +Z: a lit pane behind a stone panel with pointed
 * openings. Centred on X, standing on y = 0 of the current frame; put it 0.1 in front of the wall.
 */
function lancets(b: Builder, wall: MatKey, len: number, h: number, n: number, openW: number, openH: number) {
  b.add('window', box(len - 0.5, openH + openW * 0.25, 0.1), 0, 0, -0.05);
  const w = len / n;
  for (let i = 0; i < n; i++) b.add(wall, archWall(w, h, 0.7, openW, openH, true), -len / 2 + w * (i + 0.5), 0, 0.35);
}
/**
 * The seal of the commonwealth on a wall that faces +Z: a gold ring with one stud per civilization
 * around one field — the Round Table seen from above. No civilization is set above another.
 */
function seal(b: Builder, r: number, field: MatKey = 'burgundy') {
  b.add(field, new THREE.CircleGeometry(r * 0.94, 24), 0, 0, 0.02);
  b.add('gold', new THREE.TorusGeometry(r, r * 0.12, 6, 28), 0, 0, 0.06);
  b.add('gold', new THREE.CircleGeometry(r * 0.28, 16), 0, 0, 0.05);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.add('gold', new THREE.SphereGeometry(r * 0.16, 8, 6), Math.sin(a) * r, Math.cos(a) * r, 0.1);
  }
}
/**
 * The Palace of the Great Round Table (ADR-0034): a palace-fortress. The central donjon is the tallest
 * thing in the city, the great hall of the Council is the most massive; a crenellated ward with four
 * corner towers of different heights and a gatehouse stands on the round plinth where every road ends.
 */
export function greatPalace(b: Builder, ban: string) {
  b.add('stoneDark', cyl(40, 42, 2.4, 40));
  b.add('marble', cyl(34, 34, 0.6, 40), 0, 2.4, 0);
  // Stairs on four sides: every road still ends at steps. The ceremonial flight to the main gate (+Z) is twice as wide.
  for (let i = 0; i < 4; i++)
    b.at(0, 0, 0, (i * Math.PI) / 2, () => {
      const w = i === 0 ? 22 : 10;
      for (let s = 0; s < 6; s++) b.add('marble', box(w, 0.5, 1.4), 0, s * 0.5, 44.6 - s * 1.4);
      if (i === 0)
        for (const sx of [-1, 1]) {
          b.add('stoneDark', box(2.2, 3.6, 7.4), sx * 12.2, 0, 41.2);
          b.add('marble', box(2.6, 0.5, 7.8), sx * 12.2, 3.6, 41.2);
          b.add('gold', new THREE.SphereGeometry(0.7, 10, 8), sx * 12.2, 4.8, 43.4);
        }
    });
  b.at(0, 3, 0, 0, () => {
    const W = 22;
    const wallH = 9;
    // The ward: a dark battered footing, then curtain walls with merlons on the outer side.
    for (let i = 0; i < 4; i++) b.at(0, 0, 0, (i * Math.PI) / 2, () => b.add('stoneDark', box(W * 2 + 2, 1.5, 3.6), 0, 0, W));
    curtain(b, 'stone', -W, W, -7, W, wallH, 2.4);
    curtain(b, 'stone', 7, W, W, W, wallH, 2.4);
    curtain(b, 'stone', W, W, W, -W, wallH, 2.4);
    curtain(b, 'stone', W, -W, -W, -W, wallH, 2.4);
    curtain(b, 'stone', -W, -W, -W, W, wallH, 2.4);
    // Four corner towers, each of its own height; the rear pair is taller, so the front never hides the hall.
    for (const [x, z, r, h] of [[-W, W, 3.5, 17], [W, W, 3.7, 20.5], [W, -W, 4.2, 27], [-W, -W, 4, 23.5]] as [number, number, number, number][])
      b.at(x, 0, z, 0, () => roundTower(b, 'stone', r, h, 'slate', { roofH: r * 2.7 }));

    // The gatehouse: a pointed gate between two drum towers, the seal of the commonwealth over the arch.
    b.at(0, 0, W, 0, () => {
      b.add('stone', archWall(14, 14, 6, 5.2, 8, true));
      b.add('dark', box(5.4, 8.8, 0.3), 0, 0, -2.4);
      b.add('iron', box(5.2, 1.5, 0.16), 0, 7, 1.4);
      for (const sx of [-1, 1]) {
        b.at(sx * 9.4, 0, 1.2, 0, () => roundTower(b, 'stone', 3, 17.5, 'slate', { roofH: 8 }));
        b.at(sx * 4.7, 13.4, 3.06, 0, () => hanging(b, ban, 1.7, 6.2));
        b.at(sx * 5, 14.7, -0.6, 0, () => banner(b, ban, 7, 1.6, 3.8));
      }
      b.add('stone', box(14, 0.7, 6.6), 0, 14, 0);
      merlons(b, 'stone', 14, 14.7, 3);
      b.at(0, 11.4, 3.02, 0, () => seal(b, 1.5));
    });

    // The inner court: cobbles, and the Round Table itself laid in the paving.
    b.add('cobble', box(W * 2 - 2, 0.12, W * 2 - 2));
    b.add('marble', cyl(6.4, 6.4, 0.2, 36), 0, 0.1, 12.2);
    const table = new THREE.TorusGeometry(6.2, 0.3, 6, 40);
    table.rotateX(Math.PI / 2);
    b.add('gold', table, 0, 0.36, 12.2);
    b.add('gold', cyl(1.3, 1.3, 0.12, 20), 0, 0.3, 12.2);

    // The great hall of the Council: the most massive volume, lancet windows between buttresses, a steep slate roof.
    const HW = 32;
    const HD = 18;
    const HH = 16;
    b.at(0, 0, -7, 0, () => {
      b.add('stoneDark', box(HW + 1.8, 1.3, HD + 1.8));
      b.add('stone', box(HW, HH, HD));
      b.add('marble', box(HW + 1.2, 0.7, HD + 2.2), 0, HH, 0);
      b.add('slate', gable(HW + 0.6, HD + 1.6, 9.5, 0.5), 0, HH + 0.7, 0);
      // Stone gable ends with a lit oculus each: the roof is slate, the walls are not.
      for (const sx of [-1, 1]) {
        b.add('stone', gable(0.5, HD + 1.8, 9.7, 0.5), sx * (HW / 2 + 0.4), HH + 0.7, 0);
        b.add('window', new THREE.CircleGeometry(1.5, 20), sx * (HW / 2 + 1.42), HH + 4, 0, (sx * Math.PI) / 2);
      }
      const bay = (HW - 2) / 7;
      for (const s of [1, -1])
        b.at(0, 0, 0, s === 1 ? 0 : Math.PI, () => {
          b.at(0, 4, HD / 2 + 0.1, 0, () => lancets(b, 'stone', HW - 2, HH - 4, 7, 1.7, 8.4));
          for (let i = 0; i <= 7; i++) {
            if (s === 1 && (i === 3 || i === 4)) continue; // the portal stands here
            const x = -(HW - 2) / 2 + bay * i;
            b.add('stone', box(1, HH * 0.82, 1.5), x, 0, HD / 2 + 0.95);
            b.add('marble', box(1.3, 0.4, 1.8), x, HH * 0.82, HD / 2 + 0.95);
          }
        });
      // The portal of the hall: bronze doors under a pointed arch, a short flight of steps into the court.
      b.at(0, 0, HD / 2 + 1.6, 0, () => {
        b.add('stone', archWall(8.8, 12.6, 3, 4.6, 8.8, true));
        b.add('slate', gable(3.4, 9.8, 3.6, 0.3), 0, 12.6, 0, Math.PI / 2);
        b.add('bronze', box(4.8, 9.2, 0.3), 0, 0, -0.9);
        b.add('iron', box(0.14, 9.2, 0.34), 0, 0, -0.88);
        for (let s = 0; s < 3; s++) b.add('marble', box(11, 0.4, 1.2), 0, s * 0.4, 4.6 - s * 1.2);
      });
    });

    // The donjon: the one great vertical of the commonwealth, rising through the hall.
    const DW = 12;
    const DH = 36;
    b.at(0, 0, -7, 0, () => {
      squareTower(b, 'stone', DW, DW, DH, { windows: 0 });
      for (let k = 0; k < 4; k++) b.at(0, DH - 11.5, 0, (k * Math.PI) / 2, () => b.at(0, 0, DW / 2 + 0.1, 0, () => lancets(b, 'stone', DW - 2.6, 9.6, 2, 1.8, 7)));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at((sx * DW) / 2, DH - 5.5, (sz * DW) / 2, 0, () => roundTower(b, 'stone', 1.7, 8.5, 'slate', { windows: false, roofH: 5.8 }));
      b.add('stone', box(8, 6.4, 8), 0, DH + 0.6, 0);
      for (let k = 0; k < 4; k++) b.at(0, DH + 1.8, 0, (k * Math.PI) / 2, () => {
        for (const t of [-1.7, 1.7]) b.add('window', box(1, 3.4, 0.12), t, 0, 4.03);
      });
      b.add('marble', box(9, 0.5, 9), 0, DH + 7, 0);
      b.add('slate', pyramid(4.9, 14.5), 0, DH + 7.5, 0);
      b.add('gold', cyl(0.12, 0.16, 2.6, 6), 0, DH + 21.6, 0);
      b.add('gold', new THREE.SphereGeometry(0.6, 10, 8), 0, DH + 24.4, 0);
      b.at(0, DH + 0.6, 4.6, 0, () => banner(b, ban, 8.5, 1.9, 4.4));
    });
  });
}
/**
 * The Great Library (ADR-0034): a temple of knowledge. A tall nave with three pointed portals — one
 * per hall: Летопись, Библиотека решений, Высший Архив — between two towers, low wings with lancet
 * windows, a wide central flight of steps. A short gallery joins it to the Higher Archive.
 */
export function library(b: Builder) {
  b.add('stoneDark', box(44, 1.6, 25), 0, 0, 0.5);
  b.add('marble', box(42.4, 0.4, 23.4), 0, 1.6, 0.5);
  for (let s = 0; s < 5; s++) b.add('marble', box(20, 0.4, 1.3), 0, s * 0.4, 18.6 - s * 1.3);
  b.at(0, 2, 0, 0, () => {
    const NW = 20;
    const NH = 15;
    // The nave: its gable looks at the palace.
    b.add('stone', box(NW, NH, 17), 0, 0, -0.5);
    b.add('marble', box(NW + 1, 0.7, 18), 0, NH, -0.5);
    b.add('slate', gable(16.6, NW + 0.6, 8.5, 0.5), 0, NH + 0.7, -0.6, Math.PI / 2);
    b.add('stone', gable(0.9, NW + 1.6, 9, 0), 0, NH + 0.7, 8.55, Math.PI / 2);
    // A round window in the gable: the lamp of the reading hall.
    b.add('window', new THREE.CircleGeometry(1.9, 24), 0, NH + 3.7, 9.03);
    b.add('gold', new THREE.TorusGeometry(2, 0.2, 6, 28), 0, NH + 3.7, 9.06);
    // Windows of the back wall: the building has no blind side.
    b.at(0, 3, -9.1, Math.PI, () => lancets(b, 'stone', NW - 2, 11, 4, 1.6, 7.6));
    // Three portals, one per hall, each under its own medallion: bronze, green, burgundy.
    const medal: MatKey[] = ['bronze', 'copper', 'burgundy'];
    for (let i = 0; i < 3; i++) {
      const x = -NW / 3 + (NW / 3) * i;
      b.add('stone', archWall(NW / 3, 11.4, 1.5, 3.5, 8, true), x, 0, 8.75);
      b.add('dark', box(3.7, 8.6, 0.2), x, 0, 8.1);
      b.add('wood', box(3.5, 6.2, 0.25), x, 0, 8.3);
      b.add('iron', box(0.1, 6.2, 0.3), x, 0, 8.32);
      b.add(medal[i]!, new THREE.CircleGeometry(0.62, 16), x, 10.1, 9.52);
      b.add('gold', new THREE.TorusGeometry(0.66, 0.09, 5, 18), x, 10.1, 9.54);
    }
    b.add('marble', box(NW + 0.6, 0.5, 1.9), 0, 11.4, 8.75);
    for (let i = 0; i < 5; i++) b.add('window', box(1, 2.3, 0.1), -6.4 + i * 3.2, 12.2, 8.03);
    for (const s of [-1, 1]) {
      // A tower on each side of the nave.
      b.at(s * 12.6, 0, 5, 0, () => {
        squareTower(b, 'stone', 5, 5, 19, { windows: 3, crenel: false });
        b.add('marble', box(6.2, 0.5, 6.2), 0, 19.6, 0);
        b.add('slate', pyramid(3.3, 8.5), 0, 20.1, 0);
        b.add('gold', cyl(0.07, 0.07, 1.8, 6), 0, 28.3, 0);
        b.add('gold', new THREE.SphereGeometry(0.28, 8, 6), 0, 30.2, 0);
      });
      // A low wing of reading rooms with tall lancet windows.
      b.at(s * 17, 0, -1, 0, () => {
        b.add('stone', box(8, 10, 13));
        b.add('marble', box(8.6, 0.5, 13.8), 0, 10, 0);
        b.add('slate', gable(8.2, 13.6, 4.6, 0.4), 0, 10.5, 0);
        b.at(s * 1, 1.2, 6.6, 0, () => lancets(b, 'stone', 5.6, 8.6, 2, 1.4, 6.2));
        // The free end of the left wing has windows; the right one meets the gallery to the archive.
        if (s === -1) b.at(-4.1, 1.2, 0, -Math.PI / 2, () => lancets(b, 'stone', 12, 8.6, 3, 1.5, 6.2));
      });
    }
  });
  // The gallery to the archive: one complex, two characters.
  b.add('stone', box(4.4, 5.6, 5), 22.8, 2, -1);
  b.add('slate', gable(4.6, 5.4, 1.8, 0.2), 22.8, 7.6, -1);
  b.at(31, 0, -1, 0, () => higherArchive(b));
}
/**
 * The Higher Archive (ADR-0034): a treasury, not one more library. A heavy stepped footing, blind
 * walls between corner piers, slit windows under the cornice, closed bronze doors with iron bands
 * and the seal of approved heritage above them. The building says nothing about any record: what
 * is kept here is decided only by the server workflow.
 */
function higherArchive(b: Builder) {
  b.add('stoneDark', box(19, 1.2, 19));
  b.add('stoneDark', box(17.4, 1.4, 17.4), 0, 1.2, 0);
  for (let s = 0; s < 5; s++) b.add('marble', box(9.6, 0.52, 1.25), 0, s * 0.52, 14.6 - s * 1.25);
  for (const sx of [-1, 1]) {
    b.add('stoneDark', box(1.7, 3.6, 6.4), sx * 5.8, 0, 11.6);
    b.add('marble', box(2.1, 0.45, 6.8), sx * 5.8, 3.6, 11.6);
  }
  b.at(0, 2.6, 0, 0, () => {
    b.add('stone', box(14, 11, 14));
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        b.add('stoneDark', box(2.8, 12, 2.8), sx * 6.3, 0, sz * 6.3);
        b.add('marble', box(3.2, 0.5, 3.2), sx * 6.3, 12, sz * 6.3);
      }
    b.add('marble', box(15.4, 0.9, 15.4), 0, 11, 0);
    b.add('stone', box(11.4, 2.8, 11.4), 0, 11.9, 0);
    b.add('marble', box(12.2, 0.5, 12.2), 0, 14.7, 0);
    b.add('slate', pyramid(6.3, 5), 0, 15.2, 0);
    b.add('gold', cyl(0.1, 0.14, 1.4, 6), 0, 20, 0);
    b.add('gold', new THREE.SphereGeometry(0.5, 10, 8), 0, 21.6, 0);
    // Slits instead of windows: light for the keepers, nothing to climb through.
    for (let k = 0; k < 4; k++)
      b.at(0, 0, 0, (k * Math.PI) / 2, () => {
        for (const t of k === 0 ? [-3.4, 3.4] : [-3.2, 0, 3.2]) b.add('window', box(0.34, 2.2, 0.1), t, 7.6, 7.04);
      });
    // The portal: closed doors.
    b.add('stone', archWall(8.4, 9.6, 2.2, 4.2, 7.2), 0, 0, 7.9);
    b.add('marble', box(9.2, 0.6, 2.8), 0, 9.6, 7.9);
    b.add('bronze', box(4.3, 7.3, 0.35), 0, 0, 7.5);
    b.add('iron', box(0.12, 7.2, 0.4), 0, 0, 7.52);
    for (const yy of [1.5, 3.5, 5.5]) b.add('iron', box(4.3, 0.22, 0.4), 0, yy, 7.52);
    b.at(0, 13.3, 5.74, 0, () => seal(b, 1.05));
    for (const sx of [-1, 1]) b.at(sx * 6.3, 10.8, 7.74, 0, () => hanging(b, 'burgundy', 1.5, 6.4));
  });
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
