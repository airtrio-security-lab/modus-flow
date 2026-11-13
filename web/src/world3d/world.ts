import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Builder, banner, box, cone, cyl } from './geo';
import { KITS, greatPalace, library, plaza, type CivId } from './kits';
import { GEO, buildForest, buildRoads, buildSky, buildTerrain, configure, layoutSites, makeHeight, type Road, type Site } from './terrain';
import { bannerTexture, createMaterials, createWorldMaterials, setAnisotropy } from './tex';
import { FEEL, Feel, easeInOutCubic, easeInQuad, easeOutBack, easeOutCubic } from './feel';

/**
 * The 3D commonwealth (ADR-0026): one real-time scene for desktop and mobile. The engine only
 * presents what the backend reports — districts, their civilization and level, envoys and their
 * stage — and never decides anything itself.
 */
export interface DistrictIn {
  id: string;
  name: string;
  civ: CivId;
  /** 1…5, from the server's level thresholds. */
  level: number;
  /** Heraldic colour of the department. */
  color: string;
}
export interface EnvoyIn {
  id: string;
  /** Home district; null = «Без подразделения» (the envoys' camp at the palace). */
  districtId: string | null;
  /** 0 = at the district gate, 1 = at the palace of the Great Round Table. */
  t: number;
  tone: 'normal' | 'late' | 'mine' | 'paused';
}
export interface WorldInput {
  districts: DistrictIn[];
  achievements: number;
}
/**
 * What the person saw last time (ADR-0030). The screen keeps it, the engine only compares: a castle
 * whose server level is higher than the remembered one rises, an envoy whose stage changed walks there.
 */
export interface Seen {
  /** District id → the level seen last time. */
  levels: Record<string, number>;
  /** Envoy id → its district and place on the road seen last time. */
  envoys: Record<string, { d: string | null; t: number }>;
}
export type Quality = 'high' | 'medium' | 'low';
export type AnchorKind = 'district' | 'palace' | 'library' | 'archive' | 'plaza' | 'camp' | 'envoy';
export interface Anchor {
  id: string;
  kind: AnchorKind;
  /** CSS pixels inside the host. */
  x: number;
  y: number;
  /** Distance from the camera, metres. */
  dist: number;
  visible: boolean;
}
export interface View {
  x: number;
  z: number;
  dist: number;
  /** Azimuth: 0 looks north (−Z) from the south. */
  az: number;
  /** Polar angle from the vertical: 0 = straight down. */
  pol: number;
}
interface Spot {
  id: string;
  kind: AnchorKind;
  /** Where the label hangs. */
  pos: THREE.Vector3;
  /** Picking sphere. */
  center: THREE.Vector3;
  r: number;
}
const TIERS: Record<Quality, { dpr: number; shadow: number; seg: number; trees: number; aa: boolean }> = {
  high: { dpr: 2, shadow: 4096, seg: 260, trees: 2600, aa: true },
  medium: { dpr: 1.5, shadow: 2048, seg: 200, trees: 1600, aa: true },
  low: { dpr: 1, shadow: 0, seg: 150, trees: 900, aa: false },
};
const SUN = new THREE.Vector3(-0.58, 0.6, 0.55).normalize();
const KIT_SCALE = 1.4;
const CENTRE_SCALE = 1.35;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const ENVOY_SCALE = 2.3;
/** A point of the road at share `t` (0 = district gate, 1 = palace steps); `dir` gets the direction towards the palace. */
function roadAt(road: Road, t: number, out: THREE.Vector3, dir?: { x: number; z: number }) {
  const f = clamp(t, 0, 1) * (road.points.length - 1);
  const i = Math.min(road.points.length - 2, Math.floor(f));
  const a = road.points[i]!;
  const c = road.points[i + 1]!;
  out.lerpVectors(a, c, f - i);
  if (dir) {
    dir.x = c.x - a.x;
    dir.z = c.z - a.z;
  }
  return out;
}

export function webglSupported() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 2, 9000);
  private mats: Record<string, THREE.Material>;
  private wm: ReturnType<typeof createWorldMaterials>;
  private sun = new THREE.DirectionalLight(0xffe0bb, 3.1);
  private tier: (typeof TIERS)[Quality];
  private height: (x: number, z: number) => number = () => 0;
  private sites: Site[] = [];
  private roads: Road[] = [];
  private land = new THREE.Group();
  private centre = new THREE.Group();
  private plazaGroup = new THREE.Group();
  private districtsGroup = new THREE.Group();
  private envoysGroup = new THREE.Group();
  private ring: THREE.Mesh;
  private districtKey = new Map<string, string>();
  private districtMesh = new Map<string, THREE.Object3D>();
  private input: WorldInput = { districts: [], achievements: 0 };
  private layoutKey = '';
  private plazaKey = -1;
  private spots: Spot[] = [];
  private centreSpots: Spot[] = [];
  private plazaAt = new THREE.Vector3();
  private campAt = new THREE.Vector3();
  private envoyItems: { id: string; obj: THREE.Object3D; baseY: number; phase: number; districtId: string | null; t: number; walking: boolean }[] = [];
  /** Responses to real data events (ADR-0030); runs only while `live`. */
  private feel = new Feel();
  private seen: Seen | null = null;
  private levelNow = new Map<string, number>();
  private dataSet = false;
  private envoysSet = false;
  private pulseGeo: THREE.BufferGeometry | null = null;
  private pulses = new Set<THREE.Mesh>();
  readonly quality: Quality;
  private bannerTex = new Map<string, THREE.Texture>();
  private figureGeo = new Map<string, THREE.BufferGeometry>();
  private figureMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.4 });

  private view: View = { x: 0, z: 40, dist: 900, az: 0, pol: 0.95 };
  private goal: View = { ...this.view };
  private targetY = GEO.centerY;
  private flight: { from: View; to: View; t0: number; ms: number; done: () => void } | null = null;
  private w = 1;
  private h = 1;
  private raf = 0;
  private last = 0;
  private dirty = true;
  private running = false;
  private disposed = false;
  private slow = 0;
  private shift = { x: 0, y: 0 };
  private shiftNow = { x: 0, y: 0 };
  private shadowFrames = 0;
  private dprNow: number;
  private hover: string | null = null;
  private selected: string | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; moved: number; rotate: boolean; pinch?: { d: number; a: number } } | null = null;
  private clock = 0;
  /** Frame times of the last frames, ms (performance report). */
  readonly frames: number[] = [];

  /** Continuous animation (water, envoys); off = render only when something changed. */
  live = true;
  onAnchors: (list: Anchor[]) => void = () => {};
  onPick: (id: string | null, kind: AnchorKind | null) => void = () => {};
  onHover: (id: string | null, kind: AnchorKind | null) => void = () => {};
  onFlight: (active: boolean) => void = () => {};
  onLost: () => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement,
    private host: HTMLElement,
    quality: Quality,
  ) {
    this.quality = quality;
    this.tier = TIERS[quality];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.tier.aa, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.dprNow = Math.min(window.devicePixelRatio || 1, this.tier.dpr);
    this.renderer.setPixelRatio(this.dprNow);
    this.renderer.shadowMap.enabled = this.tier.shadow > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    setAnisotropy(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.wm = createWorldMaterials();
    this.mats = { ...createMaterials(), trunk: this.wm.trunk, leafPine: this.wm.leafPine, leafGreen: this.wm.leafGreen, leafPink: this.wm.leafPink, pond: this.wm.pond, fire: this.wm.fire };
    for (const k of ['slate', 'tileJ', 'tileGreen', 'thatch', 'copper', 'tileBlue', 'felt']) (this.mats[k] as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    for (const m of Object.values(this.mats)) (m as THREE.MeshStandardMaterial).vertexColors = true;
    this.mats['ban:realm'] = this.bannerMat('#3d4a63', 'realm');

    // Light: a low warm sun, a cool sky fill, the sky itself as the environment.
    const sky = buildSky(SUN);
    this.scene.add(sky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xc6d6ee, 0x74694f, 0.62));
    // A cool fill from the opposite side: shaded facades stay readable, as in evening light bounced off the valley.
    const fill = new THREE.DirectionalLight(0xa9c0e6, 0.4);
    fill.position.set(0.6, 0.35, -0.7);
    this.scene.add(fill);
    this.sun.castShadow = this.tier.shadow > 0;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.land, this.centre, this.plazaGroup, this.districtsGroup, this.envoysGroup);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.984, 1, 128).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, fog: false }),
    );
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    this.scene.add(this.ring);

    host.addEventListener('pointerdown', this.onDown);
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerup', this.onUp);
    host.addEventListener('pointercancel', this.onUp);
    host.addEventListener('pointerleave', this.onLeave);
    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('contextmenu', this.onContext);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.start();
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------
  /** What the person saw last time; call before the first `setData` / `setEnvoys`. */
  remember(seen: Seen | null) {
    this.seen = seen;
  }

  setData(input: WorldInput) {
    this.input = input;
    const key = input.districts.map((d) => d.id).join(',');
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.buildLand();
    }
    let changed = false;
    const seen = new Set<string>();
    const grown: string[] = [];
    for (const d of input.districts) {
      seen.add(d.id);
      // A castle rises only when the server reports a higher level than the one shown before.
      const before = this.levelNow.get(d.id) ?? this.seen?.levels[d.id];
      this.levelNow.set(d.id, d.level);
      if (before !== undefined && d.level > before) grown.push(d.id);
      const k = `${d.civ}:${d.level}:${d.color}`;
      if (this.districtKey.get(d.id) === k) continue;
      this.districtKey.set(d.id, k);
      this.buildDistrict(d);
      changed = true;
    }
    for (const id of [...this.districtMesh.keys()])
      if (!seen.has(id)) {
        this.drop(this.districtMesh.get(id)!);
        this.districtMesh.delete(id);
        this.districtKey.delete(id);
        changed = true;
      }
    if (this.plazaKey !== input.achievements) {
      this.plazaKey = input.achievements;
      this.buildPlaza();
      changed = true;
    }
    if (changed) this.refreshSpots();
    this.shadowFrames = 3;
    this.dirty = true;
    const first = !this.dataSet;
    this.dataSet = true;
    grown.forEach((id, i) => this.grow(id, (first ? FEEL.sinceDelay : 0) + i * 0.25));
  }

  /**
   * A castle grew (the server said so): the new building rises with a small spring and a ring spreads
   * over its plateau. Nothing but the picture changes; the camera and clicks keep working.
   */
  private grow(id: string, delay: number) {
    const g = this.districtMesh.get(id);
    const site = this.sites.find((s) => s.id === id);
    if (!g || !site || !this.live) return;
    const squash = FEEL.grow.squash;
    this.feel.play({
      key: `grow:${id}`,
      delay,
      duration: FEEL.grow.duration,
      easing: easeOutBack,
      step: (v) => {
        // Volume is kept: lower means wider, and the overshoot makes it settle like a real weight.
        const y = squash + (1 - squash) * v;
        const xz = 1 / Math.sqrt(y);
        g.scale.set(KIT_SCALE * xz, KIT_SCALE * y, KIT_SCALE * xz);
      },
      done: () => {
        g.scale.setScalar(KIT_SCALE);
        g.updateMatrixWorld(true);
        this.shadowFrames = 2;
        this.refreshSpots();
      },
    });
    this.pulseGeo ??= new THREE.RingGeometry(0.93, 1, 96).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xd9ba7c, transparent: true, opacity: 0, depthWrite: false, fog: false });
    const ring = new THREE.Mesh(this.pulseGeo, mat);
    ring.position.set(site.x, site.y + 0.6, site.z);
    ring.renderOrder = 2;
    ring.visible = false;
    this.scene.add(ring);
    this.pulses.add(ring);
    this.feel.play({
      key: `pulse:${id}`,
      delay,
      duration: FEEL.grow.pulse,
      easing: easeOutCubic,
      step: (v, t) => {
        ring.visible = t > 0 && t < 1;
        ring.scale.setScalar((GEO.siteR - 2) * (0.3 + 0.7 * v));
        mat.opacity = 0.85 * (1 - t);
      },
      done: () => {
        ring.removeFromParent();
        mat.dispose();
        this.pulses.delete(ring);
      },
    });
  }

  private bannerMat(color: string, emblem: Parameters<typeof bannerTexture>[1]) {
    const key = `${color}:${emblem}`;
    let t = this.bannerTex.get(key);
    if (!t) {
      t = bannerTexture(color, emblem);
      this.bannerTex.set(key, t);
    }
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9, side: THREE.DoubleSide, envMapIntensity: 0.3, vertexColors: true });
  }

  private drop(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    obj.removeFromParent();
  }

  /** Terrain, river, roads, forest and the neutral centre: rebuilt only when the list of districts changes. */
  private buildLand() {
    for (const c of [...this.land.children]) this.drop(c);
    for (const c of [...this.centre.children]) this.drop(c);
    for (const [id, m] of this.districtMesh) {
      this.drop(m);
      this.districtKey.delete(id);
    }
    this.districtMesh.clear();
    const ids = this.input.districts.map((d) => d.id);
    configure(ids.length);
    this.sites = layoutSites(ids);
    this.height = makeHeight(this.sites);
    const R = GEO.ring;
    this.land.add(buildTerrain(this.height, this.tier.seg, this.wm.ground, this.sites));
    const water = new THREE.Mesh(new THREE.PlaneGeometry(GEO.world * 2, GEO.world * 2).rotateX(-Math.PI / 2), this.wm.water);
    {
      const uv = water.geometry.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * GEO.world * 2, uv.getY(i) * GEO.world * 2);
    }
    water.position.y = GEO.water;
    water.receiveShadow = true;
    this.land.add(water);
    const rb = new Builder();
    rb.ground = -1e6;
    this.roads = buildRoads(this.sites, this.height, rb);
    this.land.add(rb.build(this.mats));

    // The neutral centre: the palace in the middle, the library and archive, the plaza and the envoys' camp between the roads.
    const y = GEO.centerY;
    const b = new Builder();
    b.ground = y;
    b.at(0, y - 0.25, 0, 0, () => b.add('cobble', cyl(66, 66, 0.4, 56)));
    b.at(0, y, 0, 0, () => greatPalace(b, 'ban:realm'), CENTRE_SCALE);
    const n = Math.max(1, this.sites.length);
    const gaps = this.sites.map((s) => s.angle + Math.PI / n);
    const taken = new Set<number>();
    const gap = (want: number) => {
      let best = 0;
      let bd = Infinity;
      gaps.forEach((g, i) => {
        const d = Math.abs(Math.atan2(Math.sin(g - want), Math.cos(g - want)));
        if (d < bd && !taken.has(i)) {
          bd = d;
          best = i;
        }
      });
      taken.add(best);
      return gaps[best] ?? want;
    };
    const rc = GEO.centerR - 24;
    const at = (a: number, r: number) => new THREE.Vector3(Math.sin(a) * r, y, -Math.cos(a) * r);
    const face = (a: number) => Math.atan2(-Math.sin(a), Math.cos(a)); // local +Z towards the palace
    const la = gap(-0.6);
    const ca = gap(0.6);
    const pa = gap(Math.PI);
    const lib = at(la, rc);
    b.at(lib.x, y, lib.z, face(la), () => b.at(-7.8, 0, 0, 0, () => library(b)));
    this.campAt = at(ca, rc - 6);
    b.at(this.campAt.x, y, this.campAt.z, face(ca), () => {
      for (const [x, z, r] of [[-7, -2, 3.4], [6, -4, 2.8], [1, -9, 3], [9, 4, 2.4]] as [number, number, number][]) {
        b.add('felt', cone(r, r * 1.25, 8), x, 0, z);
        b.add('bandMn', cyl(r * 0.99, r * 0.99, 0.5, 8, true), x, 0.2, z);
        b.add('wood', cyl(0.06, 0.06, r * 1.6, 5), x, 0, z);
      }
      for (let i = 0; i < 7; i++) b.add('rock', box(0.4, 0.3, 0.4), Math.sin(i) * 0.9, 0, 2 + Math.cos(i) * 0.9);
      b.add('fire', cone(0.5, 1.2, 6), 0, 0.1, 2);
      b.at(-2.5, 0, 6, 0, () => banner(b, 'ban:realm', 9, 1.5, 3.8));
      b.at(3.5, 0, 7, 0, () => banner(b, 'ban:realm', 7, 1.2, 3));
    });
    this.plazaAt = at(pa, rc - 4);
    // Paths from the palace ring to the neutral buildings.
    for (const [a, r] of [[la, rc - 14], [ca, rc - 16], [pa, rc - 26]] as [number, number][]) {
      const len = r - 64;
      const mid = at(a, 64 + len / 2);
      b.add('cobble', box(5, 0.3, len + 2), mid.x, y - 0.12, mid.z, face(a));
    }
    this.centre.add(b.build(this.mats));

    const libRot = face(la);
    const local = (p: THREE.Vector3, lx: number, ly: number, lz: number) => new THREE.Vector3(p.x + Math.cos(libRot) * lx + Math.sin(libRot) * lz, p.y + ly, p.z - Math.sin(libRot) * lx + Math.cos(libRot) * lz);
    // The forest keeps clear of the library, its steps and the archive: the three portals are never behind a tree.
    const court = local(lib, 4, 0, 6);
    this.land.add(buildForest(this.sites, this.height, this.tier.trees, { pine: this.wm.forestPine, leaf: this.wm.forestLeaf, trunk: this.wm.forestTrunk }, [{ x: court.x, z: court.z, r: 40 }]));
    this.centreSpots = [
      // The donjon of the palace is the tallest thing in the city: its label floats above the spire (ADR-0034).
      { id: 'palace', kind: 'palace', pos: new THREE.Vector3(0, y + 100, 0), center: new THREE.Vector3(0, y + 30, 0), r: 50 },
      { id: 'library', kind: 'library', pos: local(lib, -7.8, 38, 0), center: local(lib, -7.8, 11, 0), r: 22 },
      { id: 'archive', kind: 'archive', pos: local(lib, 23.2, 30, -1), center: local(lib, 23.2, 10, -1), r: 12 },
      { id: 'plaza', kind: 'plaza', pos: this.plazaAt.clone().setY(y + 16), center: this.plazaAt.clone().setY(y + 2), r: 22 },
      { id: 'camp', kind: 'camp', pos: this.campAt.clone().setY(y + 18), center: this.campAt.clone().setY(y + 3), r: 13 },
    ];

    // Sun and its static shadow map over the whole city.
    this.sun.position.copy(SUN).multiplyScalar(1400);
    this.sun.target.position.set(0, 0, 0);
    if (this.tier.shadow) {
      const s = this.sun.shadow;
      s.mapSize.set(this.tier.shadow, this.tier.shadow);
      const e = R + 105;
      s.camera.left = -e;
      s.camera.right = e;
      s.camera.top = e;
      s.camera.bottom = -e;
      s.camera.near = 400;
      s.camera.far = 2600;
      s.camera.updateProjectionMatrix();
      s.bias = -0.0006;
      s.normalBias = 0.6;
    }
    this.scene.fog = new THREE.Fog(0xcdbfae, R * 1.7, R * 6.2);
    this.plazaKey = -1;
    const home = this.overview();
    this.view = { ...home };
    this.goal = { ...home };
  }

  private buildPlaza() {
    for (const c of [...this.plazaGroup.children]) this.drop(c);
    const b = new Builder();
    b.ground = GEO.centerY - 3;
    b.at(this.plazaAt.x, GEO.centerY, this.plazaAt.z, 0, () => plaza(b, this.input.achievements));
    this.plazaGroup.add(b.build(this.mats));
  }

  private buildDistrict(d: DistrictIn) {
    const old = this.districtMesh.get(d.id);
    this.feel.drop(`grow:${d.id}`);
    if (old) this.drop(old);
    const site = this.sites.find((s) => s.id === d.id);
    if (!site) return;
    const banKey = `ban:${d.id}`;
    (this.mats[banKey] as THREE.Material | undefined)?.dispose();
    this.mats[banKey] = this.bannerMat(d.color, d.civ);
    const b = new Builder();
    const L = clamp(Math.round(d.level), 1, 5);
    (KITS[d.civ] ?? KITS.camelot)(b, L, banKey);
    const g = b.build(this.mats);
    g.position.set(site.x, site.y, site.z);
    g.rotation.y = Math.atan2(-site.x, -site.z);
    g.scale.setScalar(KIT_SCALE);
    g.name = d.id;
    g.updateMatrixWorld(true);
    this.districtsGroup.add(g);
    this.districtMesh.set(d.id, g);
  }

  private refreshSpots() {
    this.spots = [...this.centreSpots];
    for (const [id, g] of this.districtMesh) {
      const box3 = new THREE.Box3().setFromObject(g);
      const c = box3.getCenter(new THREE.Vector3());
      const size = box3.getSize(new THREE.Vector3());
      this.spots.push({ id, kind: 'district', pos: new THREE.Vector3(c.x, box3.max.y + 9, c.z), center: c, r: Math.max(18, Math.min(Math.hypot(size.x, size.z) / 2, GEO.siteR) * 0.8) });
    }
    for (const e of this.envoyItems) this.spots.push({ id: e.id, kind: 'envoy', pos: e.obj.position.clone().setY(e.baseY + 8), center: e.obj.position.clone().setY(e.baseY + 2.5), r: 3.4 });
    this.updateRing();
  }

  // -------------------------------------------------------------------------
  // Envoys: where the backend says they are
  // -------------------------------------------------------------------------
  private figure(pennant: string) {
    let g = this.figureGeo.get(pennant);
    if (g) return g;
    const paint = (geo: THREE.BufferGeometry, color: number | string) => {
      const n = geo.index ? geo.toNonIndexed() : geo;
      const c = new THREE.Color(color);
      const col = new Float32Array(n.attributes.position!.count * 3);
      for (let i = 0; i < col.length; i += 3) {
        col[i] = c.r;
        col[i + 1] = c.g;
        col[i + 2] = c.b;
      }
      n.setAttribute('color', new THREE.BufferAttribute(col, 3));
      n.deleteAttribute('uv');
      return n;
    };
    const flag = new THREE.BufferGeometry();
    flag.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.95, -0.28, 0, 0, -0.56, 0, 0, 0, 0, 0, -0.56, 0, 0.95, -0.28, 0], 3));
    flag.computeVertexNormals();
    g = mergeGeometries([
      paint(cone(0.46, 1.3, 9), 0x3d3a36),
      paint(cyl(0.2, 0.3, 0.62, 8).translate(0, 0.9, 0), 0x6f5a45),
      paint(cone(0.4, 0.5, 8).translate(0, 1.18, 0), 0x2f3b4a),
      paint(new THREE.SphereGeometry(0.19, 10, 8).translate(0, 1.78, 0), 0xcaa17c),
      paint(cone(0.24, 0.3, 8).translate(0, 1.84, 0), 0x2f3b4a),
      paint(cyl(0.03, 0.035, 3, 5).translate(0.4, 0, 0), 0x3a2c1f),
      paint(flag.translate(0.42, 2.95, 0), pennant),
      paint(box(0.3, 0.22, 0.14).translate(-0.3, 0.86, 0.1), 0xd9c9a3),
    ])!;
    this.figureGeo.set(pennant, g);
    return g;
  }

  setEnvoys(list: EnvoyIn[]) {
    // Where every envoy stood a moment ago (or at the last visit): the start of its walk to the new stage.
    const first = !this.envoysSet;
    this.envoysSet = true;
    const animate = this.live && (!first || this.seen !== null);
    const before = new Map<string, { d: string | null; t: number; pos: THREE.Vector3 | null }>();
    if (first) for (const [id, s] of Object.entries(this.seen?.envoys ?? {})) before.set(id, { d: s.d, t: s.t, pos: null });
    else for (const e of this.envoyItems) before.set(e.id, { d: e.districtId, t: e.t, pos: e.obj.position.clone().setY(e.baseY) });
    const staying = new Set(list.map((e) => e.id));
    for (const e of this.envoyItems) {
      this.feel.drop(`envoy:${e.id}`);
      if (animate && !staying.has(e.id)) this.leave(e.obj);
      else e.obj.removeFromParent();
    }
    this.envoyItems = [];
    let moved = 0;
    const slots = new Map<string, number>();
    const colorOf = new Map(this.input.districts.map((d) => [d.id, d.color]));
    for (const e of list) {
      const road = e.districtId ? this.roads.find((r) => r.id === e.districtId) : null;
      const p = new THREE.Vector3();
      let rot = 0;
      if (road && road.points.length > 1) {
        const f = clamp(e.t, 0, 1) * (road.points.length - 1);
        const i = Math.min(road.points.length - 2, Math.floor(f));
        const a = road.points[i]!;
        const c = road.points[i + 1]!;
        p.lerpVectors(a, c, f - i);
        const key = `${e.districtId}:${Math.round(f / 3)}`;
        const k = slots.get(key) ?? 0;
        slots.set(key, k + 1);
        // Envoys at the same stage stand in a file across the road, not inside each other.
        const side = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 1.9;
        const dx = c.x - a.x;
        const dz = c.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        p.x += (-dz / l) * side + (dx / l) * (k > 4 ? -2.2 * Math.floor(k / 5) : 0);
        p.z += (dx / l) * side + (dz / l) * (k > 4 ? -2.2 * Math.floor(k / 5) : 0);
        rot = Math.atan2(dx, dz);
      } else {
        const k = slots.get('camp') ?? 0;
        slots.set('camp', k + 1);
        const a = k * 2.4;
        p.set(this.campAt.x + Math.sin(a) * (5 + k * 0.5), GEO.centerY + 0.2, this.campAt.z + Math.cos(a) * (5 + k * 0.5));
        rot = a + Math.PI;
      }
      const pennant = e.tone === 'paused' ? '#8fa3ba' : e.tone === 'late' ? '#c8392b' : e.tone === 'mine' ? '#e3b54a' : (e.districtId && colorOf.get(e.districtId)) || '#7d8798';
      const m = new THREE.Mesh(this.figure(pennant), this.figureMat);
      m.position.copy(p);
      m.rotation.y = rot;
      m.scale.setScalar(ENVOY_SCALE);
      m.castShadow = false;
      this.envoysGroup.add(m);
      const item = { id: e.id, obj: m, baseY: p.y, phase: this.envoyItems.length * 1.7, districtId: e.districtId, t: e.t, walking: false };
      this.envoyItems.push(item);
      if (!animate) continue;
      const was = before.get(e.id);
      const delay = (first ? FEEL.sinceDelay : 0) + Math.min(moved, 12) * FEEL.stagger;
      if (was && was.d === e.districtId && road && road.points.length > 1 && Math.abs(was.t - e.t) > 0.01) {
        // The stage changed: the envoy walks along its road instead of jumping.
        this.walk(item, road, was.t, e.t, was.pos, p, rot, delay);
        moved++;
      } else if (!was || was.d !== e.districtId) {
        // A new item, or one handed to another department: the envoy appears at its place.
        this.feel.play({ key: `envoy:${e.id}`, delay, hold: true, duration: FEEL.arrive.duration, easing: easeOutBack, step: (v) => m.scale.setScalar(ENVOY_SCALE * Math.max(0.001, v)) });
        moved++;
      }
    }
    this.refreshSpots();
    this.dirty = true;
  }

  private walk(item: World['envoyItems'][number], road: Road, fromT: number, toT: number, startPos: THREE.Vector3 | null, end: THREE.Vector3, rot: number, delay: number) {
    const obj = item.obj;
    const endOff = end.clone().sub(roadAt(road, toT, new THREE.Vector3()));
    // Keep the place in the file across the road; a start far from the road (the land was rebuilt) is ignored.
    let startOff = startPos ? startPos.clone().sub(roadAt(road, fromT, new THREE.Vector3())) : endOff.clone();
    if (startOff.length() > 14) startOff = endOff.clone();
    const at = new THREE.Vector3();
    const off = new THREE.Vector3();
    const dir = { x: 0, z: 1 };
    const back = toT < fromT;
    this.feel.play({
      key: `envoy:${item.id}`,
      delay,
      hold: true,
      duration: FEEL.walk.base + FEEL.walk.perRoad * Math.abs(toT - fromT),
      easing: easeInOutCubic,
      step: (v, t) => {
        if (t >= 1) {
          obj.position.copy(end);
          obj.rotation.y = rot;
          item.baseY = end.y;
          item.t = toT;
          item.walking = false;
        } else {
          const u = fromT + (toT - fromT) * v;
          roadAt(road, u, at, dir);
          off.lerpVectors(startOff, endOff, v);
          obj.position.set(at.x + off.x, at.y + off.y, at.z + off.z);
          // Facing where it goes: to the palace, or back home with the decision.
          obj.rotation.y = Math.atan2(back ? -dir.x : dir.x, back ? -dir.z : dir.z);
          item.baseY = obj.position.y;
          item.t = u;
          item.walking = t > 0;
        }
        // The card over the envoy's head and the click target follow it.
        const s = this.spots.find((x) => x.id === item.id && x.kind === 'envoy');
        if (s) {
          s.pos.set(obj.position.x, item.baseY + 8, obj.position.z);
          s.center.set(obj.position.x, item.baseY + 2.5, obj.position.z);
        }
      },
    });
  }

  /** The item is closed: its envoy leaves the road. */
  private leave(obj: THREE.Object3D) {
    const y = obj.position.y;
    this.feel.play({
      duration: FEEL.leave.duration,
      easing: easeInQuad,
      step: (v) => {
        obj.scale.setScalar(ENVOY_SCALE * Math.max(0.001, 1 - v));
        obj.position.y = y + v * 1.6;
      },
      done: () => obj.removeFromParent(),
    });
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------
  overview(): View {
    // A portrait screen needs more distance to hold the ring of districts.
    const aspect = this.w / this.h;
    // A portrait screen cannot hold the whole ring: it opens on the centre and the nearest districts; the rest is a swipe away.
    if (aspect < 1) return { x: 0, z: GEO.ring * 0.16, dist: GEO.ring * 2.7, az: 0, pol: 1.0 };
    return { x: 0, z: GEO.ring * 0.1, dist: GEO.ring * 2.3, az: 0, pol: 1.1 };
  }
  /** The view that frames a district, the palace or another place. */
  viewOf(id: string): View | null {
    const site = this.sites.find((s) => s.id === id);
    if (site) {
      const az = Math.atan2(-site.x, -site.z) + 0.42;
      const portrait = this.w / this.h < 1;
      return { x: site.x - site.x * 0.03, z: site.z - site.z * 0.03, dist: portrait ? 300 : 205, az, pol: 1.08 };
    }
    // An envoy: come close enough to read the card over its head, keeping the direction of view.
    const envoy = this.spots.find((s) => s.id === id && s.kind === 'envoy');
    if (envoy) return { x: envoy.center.x, z: envoy.center.z, dist: 170, az: this.view.az, pol: 1.02 };
    const spot = this.centreSpots.find((s) => s.id === id);
    if (!spot) return null;
    // The library and the archive look at the palace: the camera comes from that side and a little from the
    // right, so the three portals and the doors of the archive are seen, not the back wall (ADR-0034).
    if (spot.kind === 'library' || spot.kind === 'archive') {
      const front = Math.atan2(-spot.center.x, -spot.center.z);
      return { x: spot.center.x, z: spot.center.z, dist: spot.kind === 'library' ? 135 : 88, az: front + (spot.kind === 'library' ? 0.8 : 1.05), pol: 1.02 };
    }
    const az = spot.kind === 'palace' ? this.view.az : Math.atan2(-spot.center.x, -spot.center.z) + Math.PI + 0.3;
    return { x: spot.center.x, z: spot.center.z, dist: spot.kind === 'palace' ? 250 : 150, az, pol: 1.06 };
  }
  getView(): View {
    return { ...this.view };
  }
  setView(v: View) {
    this.flight = null;
    this.view = this.limit({ ...v });
    this.goal = { ...this.view };
    this.dirty = true;
  }
  /** A cinematic flight; resolves when it ends or is skipped. */
  flyTo(to: View, ms = 2200): Promise<void> {
    this.finishFlight();
    const from = { ...this.view };
    const target = this.limit({ ...to });
    // Turn the short way round.
    target.az = from.az + Math.atan2(Math.sin(target.az - from.az), Math.cos(target.az - from.az));
    if (ms <= 0) {
      this.setView(target);
      return Promise.resolve();
    }
    return new Promise((done) => {
      this.flight = { from, to: target, t0: performance.now(), ms, done };
      this.onFlight(true);
      this.dirty = true;
    });
  }
  /** Skip the flight: jump to its end. */
  skip() {
    this.finishFlight();
  }
  private finishFlight() {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    this.view = { ...f.to };
    this.goal = { ...f.to };
    this.dirty = true;
    this.onFlight(false);
    f.done();
  }
  get flying() {
    return this.flight !== null;
  }
  private limit(v: View) {
    v.dist = clamp(v.dist, 46, GEO.ring * 5.4);
    v.pol = clamp(v.pol, 0.18, 1.38);
    const r = Math.hypot(v.x, v.z);
    const max = GEO.ring + 110;
    if (r > max) {
      v.x *= max / r;
      v.z *= max / r;
    }
    return v;
  }
  private applyCamera() {
    const v = this.view;
    const ground = Math.max(this.height(v.x, v.z), GEO.water);
    this.targetY += (ground - this.targetY) * 0.2;
    const sp = Math.sin(v.pol);
    const pos = new THREE.Vector3(v.x + Math.sin(v.az) * sp * v.dist, this.targetY + Math.cos(v.pol) * v.dist, v.z + Math.cos(v.az) * sp * v.dist);
    // Never under the hills.
    const floor = this.height(pos.x, pos.z) + 7;
    if (pos.y < floor) pos.y = floor;
    this.camera.position.copy(pos);
    this.camera.lookAt(v.x, this.targetY + Math.min(14, v.dist * 0.04), v.z);
    this.camera.near = Math.max(1.5, v.dist * 0.02);
    this.camera.far = 9000;
    // The haze starts behind what the camera looks at, however far it stands.
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) {
      fog.near = v.dist * 0.85 + GEO.ring * 0.9;
      fog.far = v.dist * 2.4 + GEO.ring * 5.2;
    }
    // Panels cover part of the screen: the scene is shifted so its subject stays in the free part.
    this.shiftNow.x += (this.shift.x - this.shiftNow.x) * 0.18;
    this.shiftNow.y += (this.shift.y - this.shiftNow.y) * 0.18;
    if (Math.abs(this.shift.x - this.shiftNow.x) + Math.abs(this.shift.y - this.shiftNow.y) > 0.5) this.dirty = true;
    if (Math.abs(this.shiftNow.x) + Math.abs(this.shiftNow.y) > 0.5) this.camera.setViewOffset(this.w, this.h, this.shiftNow.x, this.shiftNow.y, this.w, this.h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Free part of the screen: `right` and `bottom` pixels are covered by panels. */
  setCovered(right: number, bottom: number) {
    this.shift = { x: right / 2, y: bottom / 2 };
    this.dirty = true;
  }

  resize(w: number, h: number) {
    if (w < 2 || h < 2) return;
    const first = this.w === 1 && this.h === 1;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 48 : 36;
    this.camera.updateProjectionMatrix();
    if (first && this.layoutKey) {
      const home = this.overview();
      this.view = { ...home };
      this.goal = { ...home };
    }
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  private local(e: { clientX: number; clientY: number }) {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private ray(x: number, y: number) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1), this.camera);
    return rc.ray;
  }
  private groundAt(x: number, y: number) {
    const ray = this.ray(x, y);
    const out = new THREE.Vector3();
    return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.targetY), out) ? out : null;
  }
  private spotAt(x: number, y: number) {
    const ray = this.ray(x, y);
    let best: Spot | null = null;
    let bd = Infinity;
    const sphere = new THREE.Sphere();
    const hit = new THREE.Vector3();
    for (const s of this.spots) {
      sphere.set(s.center, s.r);
      if (!ray.intersectSphere(sphere, hit)) continue;
      const d = hit.distanceTo(ray.origin) - (s.kind === 'envoy' ? 30 : 0);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }
  private cancelFlightByUser() {
    if (!this.flight) return;
    const f = this.flight;
    this.flight = null;
    this.goal = { ...this.view };
    this.onFlight(false);
    f.done();
  }
  private onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-world-ui]')) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.host.setPointerCapture?.(e.pointerId);
    this.cancelFlightByUser();
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.drag = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, moved: 99, rotate: false, pinch: { d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x) } };
    } else this.drag = { x: p.x, y: p.y, moved: 0, rotate: e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey };
  };
  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') this.setHover(this.spotAt(p.x, p.y));
      return;
    }
    this.pointers.set(e.pointerId, p);
    const d = this.drag;
    if (!d) return;
    if (this.pointers.size >= 2 && d.pinch) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      this.zoomAt(mx, my, d.pinch.d / Math.max(1, dist));
      this.goal.az -= Math.atan2(Math.sin(ang - d.pinch.a), Math.cos(ang - d.pinch.a));
      this.panBy(d.x, d.y, mx, my);
      d.pinch = { d: dist, a: ang };
      d.x = mx;
      d.y = my;
      return;
    }
    const dx = p.x - d.x;
    const dy = p.y - d.y;
    d.moved += Math.abs(dx) + Math.abs(dy);
    if (d.rotate) {
      this.goal.az -= dx * 0.0052;
      this.goal.pol = clamp(this.goal.pol - dy * 0.004, 0.18, 1.38);
      this.view.az = this.goal.az;
      this.view.pol = this.goal.pol;
    } else this.panBy(d.x, d.y, p.x, p.y);
    d.x = p.x;
    d.y = p.y;
    this.dirty = true;
  };
  private onUp = (e: PointerEvent) => {
    const had = this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (this.pointers.size === 0) this.drag = null;
    else if (this.pointers.size === 1 && d) {
      const [a] = [...this.pointers.values()] as [{ x: number; y: number }];
      this.drag = { x: a.x, y: a.y, moved: 99, rotate: false };
    }
    if (!had || !d || d.moved > 6 || e.type === 'pointercancel') return;
    const p = this.local(e);
    const s = this.spotAt(p.x, p.y);
    this.onPick(s?.id ?? null, s?.kind ?? null);
  };
  private onLeave = () => this.setHover(null);
  private onContext = (e: Event) => e.preventDefault();
  private onWheel = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest('[data-world-scroll]')) return;
    e.preventDefault();
    this.cancelFlightByUser();
    const p = this.local(e);
    this.zoomAt(p.x, p.y, Math.exp(clamp(e.deltaY, -240, 240) * 0.0014));
  };
  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.stop();
    this.onLost();
  };
  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.start();
    else this.stop();
  };
  private panBy(x0: number, y0: number, x1: number, y1: number) {
    const a = this.groundAt(x0, y0);
    const b = this.groundAt(x1, y1);
    if (!a || !b) return;
    // Near the horizon a pixel is a kilometre: cap one step.
    const dx = clamp(a.x - b.x, -400, 400);
    const dz = clamp(a.z - b.z, -400, 400);
    this.goal.x += dx;
    this.goal.z += dz;
    this.limit(this.goal);
    this.view.x = this.goal.x;
    this.view.z = this.goal.z;
    this.dirty = true;
  }
  /** Zoom keeping the ground point under the cursor in place. */
  zoomAt(x: number, y: number, factor: number) {
    const before = this.goal.dist;
    const next = clamp(before * factor, 46, GEO.ring * 5.4);
    const p = this.groundAt(x, y);
    if (p && Math.hypot(p.x - this.goal.x, p.z - this.goal.z) < before * 2) {
      const k = 1 - next / before;
      this.goal.x += (p.x - this.goal.x) * k;
      this.goal.z += (p.z - this.goal.z) * k;
    }
    this.goal.dist = next;
    this.limit(this.goal);
    this.dirty = true;
  }
  /** Keyboard and on-screen controls. */
  nudge(kind: 'left' | 'right' | 'up' | 'down' | 'in' | 'out' | 'cw' | 'ccw' | 'tiltUp' | 'tiltDown' | 'home') {
    this.cancelFlightByUser();
    const g = this.goal;
    const step = g.dist * 0.16;
    const fx = -Math.sin(g.az);
    const fz = -Math.cos(g.az);
    const move = (dx: number, dz: number) => {
      g.x += dx * step;
      g.z += dz * step;
    };
    if (kind === 'up') move(fx, fz);
    else if (kind === 'down') move(-fx, -fz);
    else if (kind === 'left') move(fz, -fx);
    else if (kind === 'right') move(-fz, fx);
    else if (kind === 'in') g.dist *= 0.78;
    else if (kind === 'out') g.dist *= 1.28;
    else if (kind === 'cw') g.az -= 0.3;
    else if (kind === 'ccw') g.az += 0.3;
    else if (kind === 'tiltUp') g.pol -= 0.12;
    else if (kind === 'tiltDown') g.pol += 0.12;
    else Object.assign(g, this.overview());
    this.limit(g);
    this.dirty = true;
  }
  private setHover(s: Spot | null) {
    const id = s?.id ?? null;
    if (id === this.hover) return;
    this.hover = id;
    this.host.style.cursor = id ? 'pointer' : '';
    this.onHover(id, s?.kind ?? null);
    this.updateRing();
  }
  select(id: string | null) {
    const changed = id !== this.selected;
    this.selected = id;
    this.updateRing();
    // The ring settles onto the chosen district: a quiet answer to the click.
    if (changed && id && this.live && this.ring.visible) {
      const base = GEO.siteR - 4;
      const mat = this.ring.material as THREE.MeshBasicMaterial;
      this.feel.play({
        key: 'select',
        duration: FEEL.select.duration,
        easing: easeOutBack,
        step: (v, t) => {
          this.ring.scale.setScalar(base * (1.12 - 0.12 * v));
          mat.opacity = 1 - 0.3 * t;
        },
      });
    }
  }
  private updateRing() {
    const id = this.hover && this.sites.some((s) => s.id === this.hover) ? this.hover : this.selected;
    const site = this.sites.find((s) => s.id === id);
    const d = this.input.districts.find((x) => x.id === id);
    this.ring.visible = Boolean(site && d);
    if (site && d) {
      this.ring.position.set(site.x, site.y + 0.5, site.z);
      this.ring.scale.setScalar(GEO.siteR - 4);
      (this.ring.material as THREE.MeshBasicMaterial).color.set(0xd9ba7c);
    }
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------
  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const gap = now - this.last;
    const dt = Math.min(0.1, gap / 1000);
    this.last = now;
    let moving = false;
    if (this.flight) {
      const f = this.flight;
      const t = clamp((now - f.t0) / f.ms, 0, 1);
      const k = ease(t);
      const lift = Math.sin(Math.PI * k) * Math.min(260, Math.hypot(f.to.x - f.from.x, f.to.z - f.from.z) * 0.35);
      this.view = {
        x: f.from.x + (f.to.x - f.from.x) * k,
        z: f.from.z + (f.to.z - f.from.z) * k,
        dist: f.from.dist + (f.to.dist - f.from.dist) * k + lift,
        az: f.from.az + (f.to.az - f.from.az) * k,
        pol: f.from.pol + (f.to.pol - f.from.pol) * k,
      };
      moving = true;
      if (t >= 1) this.finishFlight();
    } else {
      const k = 1 - Math.exp(-dt * 11);
      for (const key of ['x', 'z', 'dist', 'az', 'pol'] as const) {
        const d = this.goal[key] - this.view[key];
        if (Math.abs(d) > (key === 'az' || key === 'pol' ? 0.0004 : 0.02)) {
          this.view[key] += d * k;
          moving = true;
        } else this.view[key] = this.goal[key];
      }
    }
    // Motion was switched off while a response was playing: everything goes straight to rest.
    if (!this.live && this.feel.size) {
      this.feel.settle();
      this.dirty = true;
    }
    if (!moving && !this.dirty && !this.live) return;
    if (this.live) {
      this.clock += dt;
      const n = this.wm.water.normalMap;
      if (n) n.offset.set(this.clock * 0.012, this.clock * 0.007);
      this.feel.update(dt);
      // A walking envoy steps faster and higher than one that waits.
      for (const e of this.envoyItems) e.obj.position.y = e.baseY + Math.abs(Math.sin(this.clock * (e.walking ? 7 : 1.6) + e.phase)) * (e.walking ? 0.3 : 0.12);
    }
    this.dirty = false;
    const t0 = performance.now();
    if (this.shadowFrames > 0) {
      this.shadowFrames--;
      this.renderer.shadowMap.needsUpdate = true;
      this.dirty = true;
    }
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
    this.publishAnchors();
    const ms = performance.now() - t0;
    this.frames.push(gap);
    if (this.frames.length > 240) this.frames.shift();
    // Adaptive resolution: if frames are long, render fewer pixels before dropping anything else.
    this.slow = dt > 0.045 || ms > 34 ? this.slow + 1 : Math.max(0, this.slow - 2);
    if (this.slow > 50 && this.dprNow > 0.75) {
      this.dprNow = Math.max(0.75, this.dprNow - 0.25);
      this.renderer.setPixelRatio(this.dprNow);
      this.renderer.setSize(this.w, this.h, false);
      this.slow = 0;
    }
  };
  private publishAnchors() {
    const v = new THREE.Vector3();
    const list: Anchor[] = [];
    for (const s of this.spots) {
      v.copy(s.pos).project(this.camera);
      list.push({ id: s.id, kind: s.kind, x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h, dist: s.pos.distanceTo(this.camera.position), visible: v.z > -1 && v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.2 });
    }
    this.onAnchors(list);
  }
  /** One frame right now (screenshots, tests, reduced motion). */
  renderNow() {
    if (!this.live) this.feel.settle();
    this.renderer.shadowMap.needsUpdate = true;
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
    this.publishAnchors();
  }
  /** Where a building's centre is on the screen right now (CSS pixels): used by end-to-end checks of real picking. */
  screenOf(id: string) {
    const spot = this.spots.find((x) => x.id === id);
    if (!spot) return null;
    this.applyCamera();
    const v = spot.center.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.w, y: (-v.y * 0.5 + 0.5) * this.h };
  }
  stats() {
    const i = this.renderer.info;
    const f = [...this.frames].sort((a, b) => a - b);
    return { districts: this.districtMesh.size, envoys: this.envoyItems.length, calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, dpr: this.dprNow, medianMs: f[Math.floor(f.length / 2)] ?? 0, p90Ms: f[Math.floor(f.length * 0.9)] ?? 0 };
  }

  /** Measurements for the diagnostics panel (`?diag=1`): the same numbers as `stats()` plus the device's side. */
  diagnostics() {
    const gl = this.renderer.getContext();
    let gpu = '';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    } catch {
      /* the browser hides it */
    }
    return { ...this.stats(), quality: this.quality, width: this.w, height: this.h, deviceDpr: window.devicePixelRatio || 1, live: this.live, responses: this.feel.size, gpu };
  }

  dispose() {
    this.disposed = true;
    this.stop();
    for (const p of this.pulses) (p.material as THREE.Material).dispose();
    this.pulses.clear();
    this.pulseGeo?.dispose();
    const h = this.host;
    h.removeEventListener('pointerdown', this.onDown);
    h.removeEventListener('pointermove', this.onMove);
    h.removeEventListener('pointerup', this.onUp);
    h.removeEventListener('pointercancel', this.onUp);
    h.removeEventListener('pointerleave', this.onLeave);
    h.removeEventListener('wheel', this.onWheel);
    h.removeEventListener('contextmenu', this.onContext);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const g of this.figureGeo.values()) g.dispose();
    const mats = new Set<THREE.Material>([...Object.values(this.mats), ...Object.values(this.wm), this.figureMat, this.ring.material as THREE.Material]);
    for (const m of mats) {
      const s = m as THREE.MeshStandardMaterial;
      s.map?.dispose();
      s.normalMap?.dispose();
      m.dispose();
    }
    for (const t of this.bannerTex.values()) t.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
  }
}
