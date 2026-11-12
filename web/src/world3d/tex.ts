import * as THREE from 'three';

/**
 * Procedural PBR materials for the 3D commonwealth (ADR-0026). Every texture is drawn here on a
 * canvas — albedo, a height field turned into a normal map, and roughness — so the project ships no
 * third-party art and needs no licences. UVs of all geometry are in metres; `tile` is how many
 * metres one texture repeat covers.
 */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Draw = (c: CanvasRenderingContext2D, h: CanvasRenderingContext2D, S: number, r: () => number) => void;
const SIZE = 512;

function canvas(S = SIZE) {
  const el = document.createElement('canvas');
  el.width = el.height = S;
  return el;
}
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
function shade(col: number, k: number) {
  const r = Math.min(255, Math.max(0, ((col >> 16) & 255) * k));
  const g = Math.min(255, Math.max(0, ((col >> 8) & 255) * k));
  const b = Math.min(255, Math.max(0, (col & 255) * k));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
/** Fine grain noise over the whole canvas: breaks flat colour and adds micro-relief. */
function grain(c: CanvasRenderingContext2D, S: number, r: () => number, amount: number, alpha = 0.5) {
  const img = c.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amount * 255 * alpha;
    d[i] = Math.min(255, Math.max(0, d[i]! + n));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1]! + n));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2]! + n));
  }
  c.putImageData(img, 0, 0);
}
/** Soft large blotches: weathering, moss, damp. */
function blotches(c: CanvasRenderingContext2D, S: number, r: () => number, color: string, n: number, alpha: number) {
  for (let i = 0; i < n; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = S * (0.05 + r() * 0.16);
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.globalAlpha = alpha * (0.4 + r() * 0.6);
    c.fillStyle = g;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) c.fillRect(x - rad + dx, y - rad + dy, rad * 2, rad * 2);
  }
  c.globalAlpha = 1;
}

function normalFromHeight(h: HTMLCanvasElement, strength: number) {
  const S = h.width;
  const src = h.getContext('2d')!.getImageData(0, 0, S, S).data;
  const out = canvas(S);
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const at = (x: number, y: number) => src[(((y + S) % S) * S + ((x + S) % S)) * 4]! / 255;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      img.data[i] = (-dx / l) * 127 + 128;
      img.data[i + 1] = (dy / l) * 127 + 128;
      img.data[i + 2] = (1 / l) * 127 + 128;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return out;
}

export interface MatOpts {
  tile: number;
  rough?: number;
  metal?: number;
  normal?: number;
  emissive?: number;
  emissiveIntensity?: number;
  side?: THREE.Side;
  env?: number;
}
const maxAniso = { v: 4 };
export function setAnisotropy(n: number) {
  maxAniso.v = Math.max(1, Math.min(8, n));
}

function make(seed: number, draw: Draw, o: MatOpts) {
  const col = canvas();
  const hgt = canvas();
  const c = col.getContext('2d', { willReadFrequently: true })!;
  const h = hgt.getContext('2d', { willReadFrequently: true })!;
  h.fillStyle = '#808080';
  h.fillRect(0, 0, SIZE, SIZE);
  draw(c, h, SIZE, rng(seed));
  const wrap = (t: THREE.Texture, srgb: boolean) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / o.tile, 1 / o.tile);
    t.anisotropy = maxAniso.v;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const m = new THREE.MeshStandardMaterial({
    map: wrap(new THREE.CanvasTexture(col), true),
    normalMap: wrap(new THREE.CanvasTexture(normalFromHeight(hgt, o.normal ?? 2.2)), false),
    roughness: o.rough ?? 0.9,
    metalness: o.metal ?? 0,
    side: o.side ?? THREE.FrontSide,
    envMapIntensity: o.env ?? 0.55,
  });
  if (o.emissive !== undefined) {
    m.emissive = new THREE.Color(o.emissive);
    m.emissiveIntensity = o.emissiveIntensity ?? 1;
  }
  return m;
}

/** Coursed ashlar: rows of blocks with recessed mortar, each block slightly different. */
const ashlar =
  (base: number, mortar: number, rows: number, moss = 0.12): Draw =>
  (c, h, S, r) => {
    c.fillStyle = hex(mortar);
    c.fillRect(0, 0, S, S);
    h.fillStyle = '#3a3a3a';
    h.fillRect(0, 0, S, S);
    const rh = S / rows;
    for (let row = 0; row < rows; row++) {
      let x = -r() * rh * 1.5;
      while (x < S) {
        const w = rh * (1.2 + r() * 1.5);
        const k = 0.82 + r() * 0.32;
        const g = 3;
        for (const off of [0, S]) {
          c.fillStyle = shade(base, k);
          c.fillRect(x + g / 2 - off + (x < 0 ? S : 0) * 0, row * rh + g / 2, w - g, rh - g);
          if (x + w > S) c.fillRect(x - S + g / 2, row * rh + g / 2, w - g, rh - g);
          void off;
        }
        const v = 150 + r() * 70;
        h.fillStyle = `rgb(${v},${v},${v})`;
        h.fillRect(x + g, row * rh + g, w - g * 2, rh - g * 2);
        if (x + w > S) h.fillRect(x - S + g, row * rh + g, w - g * 2, rh - g * 2);
        x += w;
      }
    }
    blotches(c, S, r, 'rgba(60,52,40,0.9)', 14, 0.22);
    blotches(c, S, r, 'rgba(92,104,62,0.9)', 8, moss);
    blotches(c, S, r, 'rgba(255,246,225,0.9)', 8, 0.12);
    grain(c, S, r, 0.14);
    grain(h, S, r, 0.1);
  };

/** Irregular boulders (Japanese ishigaki, cliffs, rough foundations). */
const rubble =
  (base: number, dark: number, n: number): Draw =>
  (c, h, S, r) => {
    c.fillStyle = hex(dark);
    c.fillRect(0, 0, S, S);
    h.fillStyle = '#202020';
    h.fillRect(0, 0, S, S);
    for (let i = 0; i < n; i++) {
      const x = r() * S;
      const y = r() * S;
      const rx = S * (0.035 + r() * 0.06);
      const ry = rx * (0.55 + r() * 0.5);
      const k = 0.75 + r() * 0.4;
      for (const dx of [-S, 0, S])
        for (const dy of [-S, 0, S]) {
          c.fillStyle = shade(base, k);
          c.beginPath();
          c.ellipse(x + dx, y + dy, rx, ry, r() * 0.6, 0, Math.PI * 2);
          c.fill();
          const g = h.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rx);
          g.addColorStop(0, '#e8e8e8');
          g.addColorStop(0.8, '#9a9a9a');
          g.addColorStop(1, '#303030');
          h.fillStyle = g;
          h.beginPath();
          h.ellipse(x + dx, y + dy, rx, ry, 0, 0, Math.PI * 2);
          h.fill();
        }
    }
    blotches(c, S, r, 'rgba(70,84,48,0.9)', 10, 0.2);
    grain(c, S, r, 0.16);
  };

/** Planks or logs along one axis. */
const planks =
  (base: number, count: number, vertical: boolean, round = false): Draw =>
  (c, h, S, r) => {
    const w = S / count;
    for (let i = 0; i < count; i++) {
      const k = 0.78 + r() * 0.36;
      c.fillStyle = shade(base, k);
      if (vertical) c.fillRect(i * w, 0, w, S);
      else c.fillRect(0, i * w, S, w);
      // Grain streaks.
      c.globalAlpha = 0.16;
      c.strokeStyle = shade(base, 0.5);
      for (let s = 0; s < 9; s++) {
        const o = i * w + r() * w;
        c.beginPath();
        if (vertical) {
          c.moveTo(o, 0);
          c.bezierCurveTo(o + r() * 4 - 2, S / 3, o + r() * 4 - 2, (2 * S) / 3, o, S);
        } else {
          c.moveTo(0, o);
          c.bezierCurveTo(S / 3, o + r() * 4 - 2, (2 * S) / 3, o + r() * 4 - 2, S, o);
        }
        c.stroke();
      }
      c.globalAlpha = 1;
      const g = vertical ? h.createLinearGradient(i * w, 0, (i + 1) * w, 0) : h.createLinearGradient(0, i * w, 0, (i + 1) * w);
      g.addColorStop(0, '#202020');
      g.addColorStop(round ? 0.5 : 0.08, round ? '#f0f0f0' : '#b0b0b0');
      g.addColorStop(round ? 0.5 : 0.92, round ? '#f0f0f0' : '#b0b0b0');
      g.addColorStop(1, '#202020');
      h.fillStyle = g;
      if (vertical) h.fillRect(i * w, 0, w, S);
      else h.fillRect(0, i * w, S, w);
    }
    grain(c, S, r, 0.12);
  };

/** Overlapping shingles / slates / tiles in rows. */
const shingles =
  (base: number, rows: number, cols: number, roundTiles = false): Draw =>
  (c, h, S, r) => {
    c.fillStyle = shade(base, 0.55);
    c.fillRect(0, 0, S, S);
    const rh = S / rows;
    const cw = S / cols;
    for (let row = 0; row < rows; row++)
      for (let col = -1; col <= cols; col++) {
        const x = col * cw + (row % 2) * cw * 0.5;
        const y = row * rh;
        const k = 0.8 + r() * 0.36;
        c.fillStyle = shade(base, k);
        if (roundTiles) {
          c.fillRect(x + 1, y, cw - 2, rh);
        } else c.fillRect(x + 1, y + 1, cw - 2, rh - 1);
        const g = roundTiles ? h.createLinearGradient(x, 0, x + cw, 0) : h.createLinearGradient(0, y, 0, y + rh);
        if (roundTiles) {
          g.addColorStop(0, '#303030');
          g.addColorStop(0.5, '#f4f4f4');
          g.addColorStop(1, '#303030');
        } else {
          g.addColorStop(0, '#e0e0e0');
          g.addColorStop(0.85, '#8a8a8a');
          g.addColorStop(1, '#202020');
        }
        h.fillStyle = g;
        h.fillRect(x + 1, y, cw - 2, rh);
      }
    blotches(c, S, r, 'rgba(30,34,30,0.9)', 10, 0.18);
    blotches(c, S, r, 'rgba(110,120,84,0.9)', 6, 0.1);
    grain(c, S, r, 0.1);
  };

const plain =
  (base: number, mottled = 0.16, seams = 0): Draw =>
  (c, h, S, r) => {
    c.fillStyle = hex(base);
    c.fillRect(0, 0, S, S);
    blotches(c, S, r, 'rgba(0,0,0,0.9)', 14, mottled * 0.6);
    blotches(c, S, r, 'rgba(255,255,255,0.9)', 14, mottled * 0.6);
    if (seams) {
      c.strokeStyle = shade(base, 0.7);
      c.lineWidth = 2;
      h.strokeStyle = '#404040';
      h.lineWidth = 3;
      for (let i = 0; i < seams; i++) {
        const x = (i / seams) * S;
        for (const k of [c, h]) {
          k.beginPath();
          k.moveTo(x, 0);
          k.lineTo(x, S);
          k.stroke();
        }
      }
    }
    grain(c, S, r, 0.1);
    grain(h, S, r, 0.18);
  };

const cobble =
  (base: number): Draw =>
  (c, h, S, r) => {
    c.fillStyle = shade(base, 0.5);
    c.fillRect(0, 0, S, S);
    h.fillStyle = '#202020';
    h.fillRect(0, 0, S, S);
    const n = 15;
    const s = S / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = i * s + (j % 2) * s * 0.5 + (r() - 0.5) * 4;
        const y = j * s + (r() - 0.5) * 4;
        c.fillStyle = shade(base, 0.8 + r() * 0.35);
        const rr = s * 0.44;
        for (const dx of [0, -S]) {
          c.beginPath();
          c.ellipse(x + s / 2 + dx, y + s / 2, rr, rr * 0.9, 0, 0, Math.PI * 2);
          c.fill();
          const g = h.createRadialGradient(x + s / 2 + dx, y + s / 2, 0, x + s / 2 + dx, y + s / 2, rr);
          g.addColorStop(0, '#f0f0f0');
          g.addColorStop(1, '#505050');
          h.fillStyle = g;
          h.beginPath();
          h.ellipse(x + s / 2 + dx, y + s / 2, rr, rr * 0.9, 0, 0, Math.PI * 2);
          h.fill();
        }
      }
    blotches(c, S, r, 'rgba(60,50,36,0.9)', 12, 0.25);
    grain(c, S, r, 0.12);
  };

/** A horizontal ornament band (yurts): repeated motif between two stripes. `motif` 0 = horn/diamond (Kazakh), 1 = meander (Mongol). */
const ornament =
  (ground: number, line: number, accent: number, motif: 0 | 1): Draw =>
  (c, _h, S, r) => {
    c.fillStyle = hex(ground);
    c.fillRect(0, 0, S, S);
    c.fillStyle = hex(accent);
    c.fillRect(0, S * 0.06, S, S * 0.07);
    c.fillRect(0, S * 0.87, S, S * 0.07);
    c.strokeStyle = hex(line);
    c.fillStyle = hex(line);
    c.lineWidth = S * 0.035;
    c.lineJoin = 'round';
    const n = 4;
    const w = S / n;
    for (let i = 0; i < n; i++) {
      const cx = i * w + w / 2;
      const cy = S / 2;
      c.beginPath();
      if (motif === 0) {
        // Diamond with four curled horns — a simplified ram-horn «қошқар мүйіз» composition, drawn from scratch.
        const d = w * 0.2;
        c.moveTo(cx, cy - d);
        c.lineTo(cx + d, cy);
        c.lineTo(cx, cy + d);
        c.lineTo(cx - d, cy);
        c.closePath();
        c.stroke();
        for (const sx of [-1, 1])
          for (const sy of [-1, 1]) {
            c.beginPath();
            c.moveTo(cx + sx * d * 0.5, cy + sy * d * 0.5);
            c.bezierCurveTo(cx + sx * d * 1.4, cy + sy * d * 0.6, cx + sx * d * 1.7, cy + sy * d * 1.6, cx + sx * d * 1.0, cy + sy * d * 1.55);
            c.bezierCurveTo(cx + sx * d * 0.7, cy + sy * d * 1.5, cx + sx * d * 0.8, cy + sy * d * 1.1, cx + sx * d * 1.1, cy + sy * d * 1.15);
            c.stroke();
          }
      } else {
        // Square meander «алхан хээ».
        const d = w * 0.3;
        c.moveTo(cx - d, cy + d);
        c.lineTo(cx - d, cy - d);
        c.lineTo(cx + d, cy - d);
        c.lineTo(cx + d, cy + d * 0.45);
        c.lineTo(cx - d * 0.4, cy + d * 0.45);
        c.lineTo(cx - d * 0.4, cy - d * 0.35);
        c.lineTo(cx + d * 0.35, cy - d * 0.35);
        c.stroke();
        c.beginPath();
        c.moveTo(cx - d, cy + d);
        c.lineTo(cx + w - d, cy + d);
        c.stroke();
      }
    }
    grain(c, S, r, 0.1);
  };

export type MatKey =
  | 'stone' | 'stoneDark' | 'rock' | 'plaster' | 'wood' | 'woodLight' | 'logs' | 'slate' | 'tileJ' | 'tileGreen' | 'thatch'
  | 'felt' | 'feltDark' | 'bandKz' | 'bandMn' | 'brick' | 'tileBlue' | 'cobble' | 'gold' | 'copper' | 'iron' | 'window' | 'dark'
  | 'red' | 'marble' | 'sand' | 'brickRed';

/** The shared material library. Created once per renderer, disposed with it. */
export function createMaterials(): Record<MatKey, THREE.MeshStandardMaterial> {
  const flat = (color: number, rough: number, metal = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, envMapIntensity: 0.6, ...extra });
  return {
    stone: make(11, ashlar(0xd6c8ab, 0x97896f, 18), { tile: 6.5, rough: 0.93, normal: 1.7 }),
    stoneDark: make(12, ashlar(0xa89e8b, 0x6c6558, 14, 0.2), { tile: 10, rough: 0.95, normal: 2 }),
    rock: make(13, rubble(0x8f8a7c, 0x4a463e, 150), { tile: 14, rough: 0.97, normal: 3.4 }),
    plaster: make(14, plain(0xe9e3d3, 0.1), { tile: 12, rough: 0.9, normal: 0.8 }),
    wood: make(15, planks(0x4a3526, 9, true), { tile: 4, rough: 0.85, normal: 2 }),
    woodLight: make(16, planks(0x8a6a48, 9, false), { tile: 4, rough: 0.88, normal: 2 }),
    logs: make(17, planks(0x6e5438, 7, true, true), { tile: 3.2, rough: 0.9, normal: 3 }),
    slate: make(18, shingles(0x4a5f7c, 14, 10), { tile: 6, rough: 0.72, normal: 2.2 }),
    tileJ: make(19, shingles(0x3a4142, 10, 16, true), { tile: 5, rough: 0.62, normal: 3 }),
    tileGreen: make(20, shingles(0x4f6b54, 10, 16, true), { tile: 5, rough: 0.6, normal: 3 }),
    thatch: make(21, planks(0x9a8454, 26, true), { tile: 4, rough: 1, normal: 3 }),
    felt: make(22, plain(0xdcd2bb, 0.2, 6), { tile: 7, rough: 1, normal: 1.4 }),
    feltDark: make(23, plain(0x9b8f78, 0.25, 6), { tile: 7, rough: 1, normal: 1.4 }),
    bandKz: make(24, ornament(0x8f2f24, 0xe9cf8f, 0x1f4f6a, 0), { tile: 5, rough: 0.95, normal: 0.6 }),
    bandMn: make(25, ornament(0x26436b, 0xe58a2d, 0xc9c0a8, 1), { tile: 5, rough: 0.95, normal: 0.6 }),
    brick: make(26, ashlar(0xc19a6b, 0x8a6d4b, 24, 0.04), { tile: 5, rough: 0.92, normal: 2 }),
    tileBlue: make(27, shingles(0x2c7f8f, 16, 12), { tile: 4, rough: 0.35, normal: 1.6, env: 1 }),
    // Fired red brick of the Russian kremlin walls.
    brickRed: make(31, ashlar(0xb5604a, 0x8a4a3b, 26, 0.04), { tile: 5, rough: 0.9, normal: 1.6 }),
    cobble: make(28, cobble(0xb5ab97), { tile: 5, rough: 0.95, normal: 2.2 }),
    marble: make(29, plain(0xd8d2c4, 0.12), { tile: 10, rough: 0.55, normal: 0.6, env: 0.8 }),
    sand: make(30, plain(0xb49b6e, 0.2), { tile: 8, rough: 1, normal: 1.6 }),
    gold: flat(0xc9a24a, 0.38, 1, { envMapIntensity: 1.1 }),
    copper: flat(0x5f8f7f, 0.6, 0.55),
    iron: flat(0x2d3033, 0.55, 0.8),
    window: flat(0x1a1410, 0.5, 0, { emissive: new THREE.Color(0xffb45a), emissiveIntensity: 0.38 }),
    dark: flat(0x14110e, 0.9),
    red: flat(0x8f2b22, 0.8),
  };
}

/** A banner cloth with an original emblem of the district's style, tinted with the department's heraldic colour. */
export function bannerTexture(color: string, emblem: 'camelot' | 'japan' | 'kazakh' | 'mongolia' | 'russia' | 'realm') {
  const S = 256;
  const el = document.createElement('canvas');
  el.width = S / 2;
  el.height = S;
  const c = el.getContext('2d')!;
  c.fillStyle = color;
  c.fillRect(0, 0, S / 2, S);
  const g = c.createLinearGradient(0, 0, S / 2, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.28)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0.28)');
  c.fillStyle = g;
  c.fillRect(0, 0, S / 2, S);
  c.strokeStyle = '#d9bd7a';
  c.lineWidth = 4;
  c.strokeRect(6, 6, S / 2 - 12, S - 12);
  c.fillStyle = '#e6cf94';
  c.strokeStyle = '#e6cf94';
  const cx = S / 4;
  const cy = S * 0.42;
  c.lineWidth = 5;
  c.beginPath();
  if (emblem === 'camelot') {
    // A chalice-like tower between two chevrons.
    c.moveTo(cx - 22, cy + 30);
    c.lineTo(cx - 22, cy - 12);
    c.lineTo(cx - 10, cy - 12);
    c.lineTo(cx - 10, cy - 24);
    c.lineTo(cx + 10, cy - 24);
    c.lineTo(cx + 10, cy - 12);
    c.lineTo(cx + 22, cy - 12);
    c.lineTo(cx + 22, cy + 30);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(cx - 34, cy + 62);
    c.lineTo(cx, cy + 44);
    c.lineTo(cx + 34, cy + 62);
    c.stroke();
  } else if (emblem === 'japan') {
    // A five-petal crest in a ring.
    c.arc(cx, cy, 34, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      c.beginPath();
      c.ellipse(cx + Math.cos(a) * 15, cy + Math.sin(a) * 15, 10, 7, a, 0, Math.PI * 2);
      c.fill();
    }
  } else if (emblem === 'kazakh') {
    c.moveTo(cx, cy - 34);
    c.lineTo(cx + 26, cy);
    c.lineTo(cx, cy + 34);
    c.lineTo(cx - 26, cy);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, 9, 0, Math.PI * 2);
    c.fill();
  } else if (emblem === 'russia') {
    // A tower under a tent roof with a small onion on top: an original mark, no state heraldry.
    c.moveTo(cx - 18, cy + 34);
    c.lineTo(cx - 18, cy - 2);
    c.lineTo(cx + 18, cy - 2);
    c.lineTo(cx + 18, cy + 34);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(cx - 24, cy - 4);
    c.lineTo(cx, cy - 40);
    c.lineTo(cx + 24, cy - 4);
    c.closePath();
    c.fill();
    c.beginPath();
    c.ellipse(cx, cy - 46, 7, 9, 0, 0, Math.PI * 2);
    c.fill();
  } else if (emblem === 'mongolia') {
    c.moveTo(cx - 26, cy + 26);
    c.lineTo(cx - 26, cy - 26);
    c.lineTo(cx + 26, cy - 26);
    c.lineTo(cx + 26, cy + 10);
    c.lineTo(cx - 8, cy + 10);
    c.lineTo(cx - 8, cy - 8);
    c.lineTo(cx + 10, cy - 8);
    c.stroke();
  } else {
    // The commonwealth: four equal points around one ring.
    c.arc(cx, cy, 20, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      c.beginPath();
      c.arc(cx + Math.cos(a) * 34, cy + Math.sin(a) * 34, 7, 0, Math.PI * 2);
      c.fill();
    }
  }
  const t = new THREE.CanvasTexture(el);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso.v;
  return t;
}

/** Materials of the landscape and the small scenery that kits refer to by name. */
export function createWorldMaterials() {
  const ground = make(41, plain(0xe4e4e4, 0.12), { tile: 19, rough: 1, normal: 2.6, env: 0.25 });
  ground.vertexColors = true;
  // Water: a tiled wave height field turned into a normal map; the world scrolls its offset.
  const waves: Draw = (c, h, S, r) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, S, S);
    h.fillStyle = '#808080';
    h.fillRect(0, 0, S, S);
    for (let i = 0; i < 260; i++) {
      const x = r() * S;
      const y = r() * S;
      const w = 20 + r() * 60;
      const g = h.createRadialGradient(x, y, 0, x, y, w);
      const v = r() > 0.5 ? 255 : 0;
      g.addColorStop(0, `rgba(${v},${v},${v},0.22)`);
      g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      h.fillStyle = g;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        h.setTransform(1, 0, 0, 0.45, ox, oy + y * 0.55);
        h.fillRect(x - w, y - w, w * 2, w * 2);
      }
      h.setTransform(1, 0, 0, 1, 0, 0);
    }
  };
  const water = make(42, waves, { tile: 34, rough: 0.16, normal: 1.5, env: 1.25 });
  water.color = new THREE.Color(0x2c5360);
  water.map = null;
  water.transparent = true;
  water.opacity = 0.9;
  const leaf = (color: number, env = 0.25) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, vertexColors: true, envMapIntensity: env, side: THREE.DoubleSide });
  const bark = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 1, envMapIntensity: 0.2 });
  return {
    ground,
    water,
    forestPine: leaf(0xffffff),
    forestLeaf: leaf(0xffffff),
    forestTrunk: bark(0xffffff),
    trunk: bark(0x4f3d2c),
    leafPine: leaf(0x2f4a36),
    leafGreen: leaf(0x52703a),
    leafPink: leaf(0xe6a3b4),
    pond: new THREE.MeshStandardMaterial({ color: 0x2c5360, roughness: 0.12, envMapIntensity: 1.2 }),
    fire: new THREE.MeshStandardMaterial({ color: 0x331405, emissive: new THREE.Color(0xff7a1c), emissiveIntensity: 2.2, roughness: 1 }),
    foam: new THREE.MeshStandardMaterial({ color: 0xe9f1f2, roughness: 0.5, transparent: true, opacity: 0.82, envMapIntensity: 0.6 }),
  };
}
