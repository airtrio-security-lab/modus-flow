import * as THREE from 'three';
import { Builder, archWall, box, conifer, foliage } from './geo';
import { rng } from './tex';

/**
 * Geography of the commonwealth (ADR-0026): a central island plateau for the neutral buildings,
 * a river gorge around it, district plateaus on the outer bank at different heights, forested
 * hills between them and a mountain rim. Everything is a pure function of the list of districts,
 * so the city grows when the organization adds departments.
 */
export interface Site {
  id: string;
  x: number;
  z: number;
  /** Height of the plateau. */
  y: number;
  /** Angle of the district on the ring; the kit is rotated to face the centre. */
  angle: number;
}
export const GEO = {
  centerR: 118,
  centerY: 22,
  gorgeR: 166,
  gorgeW: 26,
  bankY: 20,
  siteR: 70,
  ring: 290,
  world: 900,
  water: 0.8,
};
/** Size the world for `n` districts: the island holds the neutral buildings between the roads, the ring holds the plateaus. */
export function configure(n: number) {
  GEO.centerR = Math.max(118, n * 11 + 30);
  GEO.gorgeR = GEO.centerR + 48;
  GEO.ring = Math.max(GEO.gorgeR + GEO.gorgeW + GEO.siteR + 30, n * 27);
  GEO.world = GEO.ring + 760;
}
export const ringRadius = (_n?: number) => GEO.ring;

export function layoutSites(ids: string[]): Site[] {
  const n = Math.max(ids.length, 1);
  const R = ringRadius(n);
  return ids.map((id, i) => {
    // Start in the upper-left, go clockwise; heights alternate so neighbours never sit level.
    const angle = -Math.PI * 0.72 + (i / n) * Math.PI * 2;
    return { id, x: Math.sin(angle) * R, z: -Math.cos(angle) * R, y: 24 + ((i * 5) % 4) * 3.5, angle };
  });
}

// Value noise.
function hash(x: number, z: number) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, z: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  return (hash(xi, zi) * (1 - u) + hash(xi + 1, zi) * u) * (1 - v) + (hash(xi, zi + 1) * (1 - u) + hash(xi + 1, zi + 1) * u) * v;
}
function fbm(x: number, z: number, oct = 4) {
  let a = 0.5;
  let f = 1;
  let s = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x * f, z * f);
    a *= 0.5;
    f *= 2.03;
  }
  return s;
}
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Angles (on the ring convention of layoutSites) where the river enters and leaves the gorge. */
const RIVER_IN = Math.PI * 0.2;
const RIVER_OUT = Math.PI * 1.12;

export function makeHeight(sites: Site[]) {
  const R = ringRadius(sites.length);
  return (x: number, z: number) => {
    const r = Math.hypot(x, z);
    // Rolling hills.
    let h = 13 + fbm(x * 0.006 + 3.1, z * 0.006 + 1.7) * 26 + fbm(x * 0.03, z * 0.03, 2) * 3;
    // Foothills, then the mountain rim far behind the city.
    const m = sstep(R + 150, R + 600, r);
    if (m > 0) {
      const ridge = 1 - Math.abs(fbm(x * 0.0036 + 9, z * 0.0036 + 4, 5) * 2 - 1);
      h += m * 26 + m * m * (30 + ridge * ridge * 330);
    }
    // District plateaus and the ramps of their roads down to the outer bank.
    for (const s of sites) {
      const d = Math.hypot(x - s.x, z - s.z);
      const w = sstep(GEO.siteR + 28, GEO.siteR, d);
      if (w > 0) h = mix(h, s.y, w);
      // Road corridor: along the radial line from the site to the gorge.
      const ux = -s.x / R;
      const uz = -s.z / R;
      const along = (x - s.x) * ux + (z - s.z) * uz; // metres towards the centre
      const across = Math.abs((x - s.x) * -uz + (z - s.z) * ux);
      const end = R - GEO.gorgeR - GEO.gorgeW;
      if (along > GEO.siteR * 0.6 && along < end + 6 && across < 16) {
        const t = sstep(GEO.siteR * 0.75, end, along);
        const wr = sstep(16, 7, across);
        h = mix(h, mix(s.y, GEO.bankY, t), wr);
      }
    }
    // The outer bank settles towards a common height near the gorge.
    const bank = sstep(GEO.gorgeR + GEO.gorgeW + 26, GEO.gorgeR + GEO.gorgeW, r) * sstep(GEO.gorgeR, GEO.gorgeR + GEO.gorgeW, r);
    h = mix(h, GEO.bankY + (fbm(x * 0.02, z * 0.02, 2) - 0.5) * 3, bank * 0.75);
    // The central island.
    const c = sstep(GEO.gorgeR - GEO.gorgeW * 0.55, GEO.centerR + 8, r);
    h = mix(h, GEO.centerY, c);
    // The gorge around the island, and the river's way in and out.
    const g = sstep(GEO.gorgeW, GEO.gorgeW * 0.3, Math.abs(r - GEO.gorgeR));
    h = mix(h, -6, g);
    for (const a of [RIVER_IN, RIVER_OUT]) {
      const dx = Math.sin(a);
      const dz = -Math.cos(a);
      const along = x * dx + z * dz;
      if (along > GEO.gorgeR) {
        const across = Math.abs(x * -dz + z * dx) + fbm(along * 0.01, a * 7, 2) * 30 - 15;
        const k = sstep(34, 9, Math.abs(across)) * (1 - sstep(R + 260, R + 420, along) * (a === RIVER_IN ? 0 : 0));
        h = mix(h, a === RIVER_IN ? -6 + sstep(R + 60, R + 300, along) * 60 : -6, k);
      }
    }
    return h;
  };
}

/** The terrain mesh with vertex colours by height and slope: meadow, forest floor, rock, scree, snow. */
export function buildTerrain(height: (x: number, z: number) => number, seg: number, mat: THREE.MeshStandardMaterial, sites: Site[] = []) {
  const size = GEO.world * 2;
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, height(x, z));
    // Height is sheared into V so cliffs get strata instead of a smeared texture.
    uv.setXY(i, x + z * 0.31, z + height(x, z) * 1.7);
  }
  g.computeVertexNormals();
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const meadow = new THREE.Color(0x5f7a3c);
  const dry = new THREE.Color(0x8c8a4e);
  const forest = new THREE.Color(0x3c5530);
  const rock = new THREE.Color(0x8f8776);
  const cliff = new THREE.Color(0x777062);
  const dirt = new THREE.Color(0x9b8660);
  const snow = new THREE.Color(0xf2f4f6);
  const bed = new THREE.Color(0x5a5a48);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const up = nor.getY(i);
    const n = fbm(x * 0.012 + 20, z * 0.012 + 7, 3);
    c.copy(meadow).lerp(dry, sstep(0.35, 0.75, n)).lerp(forest, sstep(0.55, 0.3, n) * 0.6);
    c.lerp(rock, sstep(0.86, 0.62, up));
    c.lerp(cliff, sstep(0.7, 0.4, up));
    c.lerp(rock, sstep(70, 120, y));
    c.lerp(snow, sstep(135, 190, y + n * 50) * sstep(0.3, 0.65, up + 0.2));
    // Trodden earth of the districts and of the island's centre.
    let worn = sstep(74, 52, Math.hypot(x, z)) * 0.8;
    for (const s of sites) worn = Math.max(worn, sstep(GEO.siteR * (0.86 + n * 0.3), GEO.siteR * 0.5, Math.hypot(x - s.x, z - s.z)) * 0.85);
    c.lerp(dirt, worn * sstep(0.5, 0.8, up));
    c.lerp(bed, sstep(3, -1, y));
    const k = 0.9 + hash(x * 0.37, z * 0.37) * 0.2;
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** A road from each district's gate to the central plaza: a cobbled ribbon on the ground and an arched stone bridge over the gorge. */
export interface Road {
  id: string;
  /** Points from the district gate (t = 0) to the palace steps (t = 1), on the surface. */
  points: THREE.Vector3[];
}
export function buildRoads(sites: Site[], height: (x: number, z: number) => number, b: Builder): Road[] {
  const R = ringRadius(sites.length);
  const roads: Road[] = [];
  const inner = GEO.gorgeR - GEO.gorgeW + 2;
  const outer = GEO.gorgeR + GEO.gorgeW - 2;
  for (const s of sites) {
    const ux = -s.x / R;
    const uz = -s.z / R;
    const from = 36;
    const to = R - 62;
    const pts: THREE.Vector3[] = [];
    const step = 4;
    const yIn = height(s.x + ux * (R - inner), s.z + uz * (R - inner));
    const yOut = height(s.x + ux * (R - outer), s.z + uz * (R - outer));
    for (let d = from; d <= to; d += step) {
      const x = s.x + ux * d;
      const z = s.z + uz * d;
      const r = R - d;
      const onBridge = r < outer && r > inner;
      const y = onBridge ? mix(yOut, yIn, (outer - r) / (outer - inner)) + Math.sin(((outer - r) / (outer - inner)) * Math.PI) * 1.6 : height(x, z) + 0.18;
      pts.push(new THREE.Vector3(x, y, z));
    }
    roads.push({ id: s.id, points: pts });
    const rot = Math.atan2(ux, uz);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const c = pts[i + 1]!;
      const r = Math.hypot((a.x + c.x) / 2, (a.z + c.z) / 2);
      const onBridge = r < outer && r > inner;
      const len = a.distanceTo(c) + 0.3;
      const pitch = Math.atan2(c.y - a.y, Math.hypot(c.x - a.x, c.z - a.z));
      const g = box(onBridge ? 8 : 6.4, onBridge ? 1.1 : 0.3, len);
      g.translate(0, onBridge ? -1.1 : -0.3, 0);
      g.rotateX(-pitch);
      b.add(onBridge ? 'stone' : 'cobble', g, (a.x + c.x) / 2, (a.y + c.y) / 2, (a.z + c.z) / 2, rot);
      if (onBridge) {
        for (const side of [-1, 1]) {
          const p = box(0.5, 1.1, len);
          p.translate(side * 3.7, 0, 0);
          p.rotateX(-pitch);
          b.add('stone', p, (a.x + c.x) / 2, (a.y + c.y) / 2, (a.z + c.z) / 2, rot);
        }
      }
    }
    // Piers and arches under the deck.
    const span = outer - inner;
    const piers = 3;
    for (let k = 0; k <= piers; k++) {
      const r = outer - (span * k) / piers;
      const x = s.x + ux * (R - r);
      const z = s.z + uz * (R - r);
      const deck = mix(yOut, yIn, k / piers) + Math.sin((k / piers) * Math.PI) * 1.6 - 1.1;
      const ground = Math.min(height(x, z), deck - 1);
      b.add('stone', box(8.4, deck - ground + 2, 3), x, ground - 2, z, rot);
      if (k < piers) {
        const mx = s.x + ux * (R - r + span / piers / 2);
        const mz = s.z + uz * (R - r + span / piers / 2);
        const dy = mix(yOut, yIn, (k + 0.5) / piers) + Math.sin(((k + 0.5) / piers) * Math.PI) * 1.6 - 1.1;
        const arch = archWall(span / piers, 7, 7.6, span / piers - 3.4, 5.6);
        arch.rotateY(Math.PI / 2);
        b.add('stone', arch, mx, dy - 7, mz, rot);
      }
    }
    // Gate towers at both ends of the bridge.
    for (const r of [outer + 1, inner - 1]) {
      const x = s.x + ux * (R - r);
      const z = s.z + uz * (R - r);
      const y = height(x, z);
      for (const side of [-1, 1]) {
        const px = x + Math.cos(rot) * side * 5;
        const pz = z - Math.sin(rot) * side * 5;
        b.add('stone', box(2.2, 6.5, 2.2), px, y - 1.5, pz, rot);
        b.add('slate', new THREE.ConeGeometry(1.9, 2.6, 4).rotateY(Math.PI / 4).translate(0, 1.3, 0), px, y + 5, pz, rot);
      }
    }
  }
  return roads;
}

/** Scatter trees on gentle wooded slopes, away from plateaus, roads and water. Returns two instanced meshes. */
/** `clear` — circles that stay free of trees: the forecourts of the buildings of the centre (ADR-0034). */
export function buildForest(sites: Site[], height: (x: number, z: number) => number, count: number, mats: { pine: THREE.Material; leaf: THREE.Material; trunk: THREE.Material }, clear: { x: number; z: number; r: number }[] = []) {
  const R = ringRadius(sites.length);
  const r = rng(77);
  const pine: THREE.Matrix4[] = [];
  const leaf: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let guard = 0;
  while (pine.length + leaf.length < count && guard++ < count * 30) {
    const x = (r() * 2 - 1) * (R + 330);
    const z = (r() * 2 - 1) * (R + 330);
    const rad = Math.hypot(x, z);
    if (rad < 64 || rad > R + 330) continue;
    const y = height(x, z);
    if (y < 3.5 || y > 135) continue;
    const slope = Math.abs(height(x + 3, z) - y) + Math.abs(height(x, z + 3) - y);
    if (slope > 3.4) continue;
    if (sites.some((s) => Math.hypot(x - s.x, z - s.z) < GEO.siteR - 4)) continue;
    // Keep the road corridors clear.
    if (sites.some((s) => {
      const ux = -s.x / R;
      const uz = -s.z / R;
      const along = (x - s.x) * ux + (z - s.z) * uz;
      return along > 0 && along < R && Math.abs((x - s.x) * -uz + (z - s.z) * ux) < 9;
    })) continue;
    // Clumps: trees prefer the darker patches of the forest noise.
    const n = fbm(x * 0.012 + 20, z * 0.012 + 7, 3);
    if (r() > 0.035 + sstep(0.56, 0.4, n)) continue;
    const s = 0.5 + r() * 0.45;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
    m.compose(new THREE.Vector3(x, y - 0.2, z), q, new THREE.Vector3(s, s * (0.9 + r() * 0.4), s));
    const kind = y > 44 || r() < 0.62 ? pine : leaf;
    // Checked last, after every draw of the generator: the rest of the forest stands where it stood.
    if (clear.some((c) => Math.hypot(x - c.x, z - c.z) < c.r)) continue;
    kind.push(m.clone());
  }
  const pineGeo = conifer(12, 2.9, 5);
  const leafGeo = foliage(3.1, 7, 4).translate(0, 5.6, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.45, 3.6, 5).translate(0, 1.8, 0);
  const out = new THREE.Group();
  const tint = new THREE.Color();
  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], hue: [number, number, number], shadow: boolean) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mm, i) => {
      im.setMatrixAt(i, mm);
      const k = 0.75 + r() * 0.5;
      tint.setRGB(hue[0] * k, hue[1] * (0.85 + r() * 0.3), hue[2] * k);
      im.setColorAt(i, tint);
    });
    im.castShadow = shadow;
    im.receiveShadow = false;
    im.frustumCulled = false;
    out.add(im);
  };
  mk(pineGeo, mats.pine, pine, [0.055, 0.115, 0.07], true);
  mk(leafGeo, mats.leaf, leaf, [0.1, 0.17, 0.05], true);
  mk(trunkGeo, mats.trunk, [...pine, ...leaf], [0.16, 0.11, 0.07], false);
  return out;
}
/** The sky dome: warm horizon, deep zenith, a soft sun glow — evening light without burning the details. */
export function buildSky(sunDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { sun: { value: sunDir.clone().normalize() } },
    vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 d; uniform vec3 sun;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
      float fb(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.03; a*=0.5; } return s; }
      void main(){
        float y = clamp(d.y, -0.05, 1.0);
        vec3 zen = vec3(0.20, 0.34, 0.56), hor = vec3(0.86, 0.74, 0.62), low = vec3(0.60, 0.55, 0.52);
        vec3 c = mix(hor, zen, pow(smoothstep(0.0, 0.75, y), 0.6));
        c = mix(low, c, smoothstep(-0.05, 0.04, y));
        float s = max(dot(normalize(d), sun), 0.0);
        c += vec3(1.0, 0.72, 0.42) * (pow(s, 6.0) * 0.28 + pow(s, 90.0) * 0.9);
        // High cirrus and cumulus banks, lit warm on the sun side.
        vec2 uv = d.xz / (d.y + 0.22) * 1.6;
        float cl = smoothstep(0.48, 0.78, fb(uv + vec2(3.0, 1.0))) * smoothstep(0.02, 0.22, y);
        vec3 cc = mix(vec3(0.62, 0.60, 0.66), vec3(1.0, 0.93, 0.84), 0.45 + 0.55 * s);
        c = mix(c, cc, cl * 0.72);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  return mesh;
}
