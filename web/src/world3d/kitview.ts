import * as THREE from 'three';
import { Builder, conifer } from './geo';
import { KITS, type CivId } from './kits';
import { buildSky } from './terrain';
import { bannerTexture, createMaterials, createWorldMaterials, setAnisotropy } from './tex';

/**
 * One district on its own hill (ADR-0026): the hero of the «Цитадель» screen and the preview of the
 * next levels. The same kits and materials as the city — a level shown here is exactly what the city
 * builds when the server reports that level.
 */
const SUN = new THREE.Vector3(-0.58, 0.6, 0.55).normalize();
export class KitView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1, 1, 4000);
  private mats: Record<string, THREE.Material>;
  private wm: ReturnType<typeof createWorldMaterials>;
  private kit: THREE.Object3D | null = null;
  private banner: THREE.MeshStandardMaterial | null = null;
  private az = 0.55;
  private pol = 1.24;
  private dist = 150;
  private want = 150;
  private centerY = 10;
  private raf = 0;
  private dirty = true;
  private drag: { x: number; y: number } | null = null;
  private pinch = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private disposed = false;
  /** Slow turn of the camera while nobody touches it. */
  spin = true;
  /** Buildings of the town (ADR-0029): where each section's pin stands, in scene coordinates. */
  private pins: { id: string; at: THREE.Vector3; own: boolean }[] = [];
  private pinIds: string[] = [];
  private turnTo: number | null = null;
  private span = 150;
  private zoomed = false;
  private sky = 0;
  /** Extra room around the kit (the town shows the posad before the gate and the pins above the roofs). */
  pad = 1;
  /** Called after every drawn frame with the screen position of each pin (CSS pixels inside the canvas). */
  onPins: ((list: { id: string; x: number; y: number; depth: number; shown: boolean; own: boolean }[]) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    setAnisotropy(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
    this.wm = createWorldMaterials();
    this.mats = { ...createMaterials(), trunk: this.wm.trunk, leafPine: this.wm.leafPine, leafGreen: this.wm.leafGreen, leafPink: this.wm.leafPink, pond: this.wm.pond, fire: this.wm.fire };
    for (const k of ['slate', 'tileJ', 'tileGreen', 'thatch', 'copper', 'tileBlue', 'felt']) (this.mats[k] as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    for (const m of Object.values(this.mats)) (m as THREE.MeshStandardMaterial).vertexColors = true;
    const sky = buildSky(SUN);
    this.scene.add(sky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene();
    env.add(sky.clone());
    this.scene.environment = pmrem.fromScene(env, 0.02).texture;
    pmrem.dispose();
    this.scene.fog = new THREE.Fog(0xcdbfae, 260, 1500);
    this.scene.add(new THREE.HemisphereLight(0xc6d6ee, 0x74694f, 0.62));
    const fill = new THREE.DirectionalLight(0xa9c0e6, 0.4);
    fill.position.set(0.6, 0.35, -0.7);
    this.scene.add(fill);
    const sun = new THREE.DirectionalLight(0xffe0bb, 3.1);
    sun.position.copy(SUN).multiplyScalar(500);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = c.bottom = -110;
    c.right = c.top = 110;
    c.near = 100;
    c.far = 1100;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.5;
    this.scene.add(sun);

    // A rounded hill: trodden earth under the walls, meadow around, a ring of firs on the slopes.
    const dirt = new THREE.Color(0x9b8660);
    const grass = new THREE.Color(0x5f7a3c);
    const tmp = new THREE.Color();
    const disc = new THREE.RingGeometry(0, 900, 96, 40).rotateX(-Math.PI / 2);
    const dp = disc.attributes.position as THREE.BufferAttribute;
    const dc = new Float32Array(dp.count * 3);
    for (let i = 0; i < dp.count; i++) {
      const x = dp.getX(i);
      const z = dp.getZ(i);
      const r = Math.hypot(x, z);
      const k = r / 900;
      // Radii are spread non-linearly: dense rings near the kit.
      const rr = 900 * k * k;
      const s = r > 0 ? rr / r : 0;
      dp.setXYZ(i, x * s, -Math.max(0, rr - 80) * 0.06, z * s);
      const t = Math.min(1, Math.max(0, (rr - 52) / 50));
      tmp.copy(dirt).lerp(grass, t);
      dc.set([tmp.r, tmp.g, tmp.b], i * 3);
      (disc.attributes.uv as THREE.BufferAttribute).setXY(i, x * s, z * s);
    }
    disc.setAttribute('color', new THREE.BufferAttribute(dc, 3));
    disc.computeVertexNormals();
    const ground = new THREE.Mesh(disc, this.wm.ground);
    ground.receiveShadow = true;
    this.scene.add(ground);
    const firs = new THREE.InstancedMesh(conifer(12, 2.9, 5), this.wm.forestPine, 90);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tint = new THREE.Color();
    for (let i = 0; i < 90; i++) {
      const a = i * 2.399 + Math.sin(i * 12.9898) * 0.9;
      const r = 96 + ((Math.sin(i * 78.233) * 43758.5453) % 1 + 1) % 1 * 150;
      const s = 0.5 + ((i * 13) % 10) / 22;
      m.compose(new THREE.Vector3(Math.sin(a) * r, -Math.max(0, r - 80) * 0.06 - 0.3, Math.cos(a) * r), q, new THREE.Vector3(s, s, s));
      firs.setMatrixAt(i, m);
      const k = 0.75 + ((i * 7) % 10) / 20;
      firs.setColorAt(i, tint.setRGB(0.055 * k, 0.115 * k, 0.07 * k));
    }
    firs.castShadow = true;
    this.scene.add(firs);

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.raf = requestAnimationFrame(this.frame);
  }

  set(civ: CivId, level: number, color: string) {
    if (this.kit) {
      this.kit.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.kit.removeFromParent();
    }
    this.banner?.map?.dispose();
    this.banner?.dispose();
    this.banner = new THREE.MeshStandardMaterial({ map: bannerTexture(color, civ), roughness: 0.9, side: THREE.DoubleSide, envMapIntensity: 0.3, vertexColors: true });
    this.mats['ban:kit'] = this.banner;
    const b = new Builder();
    (KITS[civ] ?? KITS.camelot)(b, Math.min(5, Math.max(1, Math.round(level))), 'ban:kit');
    const marks = b.marks;
    const g = b.build(this.mats);
    g.scale.setScalar(1.4);
    this.scene.add(g);
    this.kit = g;
    const box = new THREE.Box3().setFromObject(g);
    const size = box.getSize(new THREE.Vector3());
    this.placePins(marks, box);
    this.centerY = Math.min(22, size.y * 0.32);
    this.span = Math.max(64, Math.hypot(size.x, size.z) * 1.05 + size.y * 0.5);
    this.fit();
    this.renderer.shadowMap.needsUpdate = true;
    this.dirty = true;
  }

  /** Which sections get a pin. A section the kit has a building for stands on it; the rest take the most prominent free roofs. */
  setPins(ids: string[]) {
    this.pinIds = ids;
    if (this.kit) this.placePins(this.lastMarks, new THREE.Box3().setFromObject(this.kit));
    this.dirty = true;
  }
  private lastMarks = new Map<string, THREE.Vector3>();
  private placePins(marks: Map<string, THREE.Vector3>, box: THREE.Box3) {
    this.lastMarks = marks;
    this.pins = [];
    if (!this.kit || !this.pinIds.length) return;
    this.kit.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const top = (x: number, z: number) => {
      ray.set(new THREE.Vector3(x, box.max.y + 20, z), down);
      const hit = ray.intersectObject(this.kit!, true)[0];
      return hit ? hit.point.y : 0;
    };
    const k = this.kit.scale.x;
    const taken: THREE.Vector3[] = [];
    const rest: string[] = [];
    for (const id of this.pinIds) {
      const m = marks.get(id);
      if (!m) {
        rest.push(id);
        continue;
      }
      const at = new THREE.Vector3(m.x * k, top(m.x * k, m.z * k) + 2.4, m.z * k);
      this.pins.push({ id, at, own: true });
      taken.push(at);
    }
    if (rest.length) {
      // Sections without a building of their own yet: the highest roofs that are far enough from every other pin.
      const size = box.getSize(new THREE.Vector3());
      // One pass over the vertices: the highest point of every cell of a coarse grid (trees and banners do not count).
      const N = 11;
      const peak: (THREE.Vector3 | undefined)[] = new Array(N * N);
      this.kit.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || /^(leaf|trunk|ban|fire|pond)/.test(mesh.name)) return;
        const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i) * k;
          const y = pos.getY(i) * k;
          const z = pos.getZ(i) * k;
          const c = Math.min(N - 1, Math.max(0, Math.floor(((x - box.min.x) / size.x) * N))) * N + Math.min(N - 1, Math.max(0, Math.floor(((z - box.min.z) / size.z) * N)));
          const p = peak[c];
          if (!p) peak[c] = new THREE.Vector3(x, y, z);
          else if (y > p.y) p.set(x, y, z);
        }
      });
      const cand = peak.filter((p): p is THREE.Vector3 => !!p).map((p) => p.setY(p.y + 2.4));
      cand.sort((a, b) => b.y - a.y);
      let sep = Math.hypot(size.x, size.z) * 0.24;
      while (rest.length && sep > 1) {
        for (const c of cand) {
          if (!rest.length) break;
          if (taken.every((t) => Math.hypot(t.x - c.x, t.z - c.z) >= sep)) {
            this.pins.push({ id: rest.shift()!, at: c, own: false });
            taken.push(c);
          }
        }
        sep *= 0.7;
      }
    }
  }
  /** Turn the camera so that the building of a section faces the viewer. */
  look(id: string) {
    const p = this.pins.find((x) => x.id === id);
    if (!p) return;
    this.spin = false;
    this.turnTo = Math.atan2(p.at.x, p.at.z);
    this.dirty = true;
  }

  /** Distance at which the whole kit is in the frame: farther on a narrow (portrait) stage. */
  private fit() {
    const a = this.camera.aspect;
    this.want = Math.min(420, this.span * this.pad * (a < 1.35 ? Math.min(2, 1.35 / a) : 1));
    // The town sits lower in the frame, more so on a portrait stage: the sky above it is where the names stand.
    this.sky = this.pad > 1 ? (a < 1.35 ? 0.11 : 0.085) : 0;
  }

  resize(w: number, h: number) {
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.zoomed) this.fit();
    this.dirty = true;
  }

  private onDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture?.(e.pointerId);
    this.drag = { x: e.clientX, y: e.clientY };
    this.spin = false;
    this.turnTo = null;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch > 0) {
        this.want = Math.min(420, Math.max(45, this.want * (this.pinch / Math.max(1, d))));
        this.zoomed = true;
      }
      this.pinch = d;
    } else if (this.drag) {
      this.az -= (e.clientX - this.drag.x) * 0.006;
      this.pol = Math.min(1.42, Math.max(0.35, this.pol - (e.clientY - this.drag.y) * 0.004));
      this.drag = { x: e.clientX, y: e.clientY };
    }
    this.dirty = true;
  };
  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (!this.pointers.size) this.drag = null;
  };
  private onWheel = (e: WheelEvent) => {
    // The page scrolls as usual; zoom only with Ctrl/⌘ or a pinch gesture on a trackpad.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    this.want = Math.min(420, Math.max(45, this.want * Math.exp(e.deltaY * 0.002)));
    this.zoomed = true;
    this.dirty = true;
  };
  private onVisibility = () => {
    cancelAnimationFrame(this.raf);
    if (document.visibilityState === 'visible' && !this.disposed) this.raf = requestAnimationFrame(this.frame);
  };
  private frame = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.spin) {
      this.az += 0.0012;
      this.dirty = true;
    }
    if (this.turnTo !== null) {
      // The shortest way round.
      const d = Math.atan2(Math.sin(this.turnTo - this.az), Math.cos(this.turnTo - this.az));
      if (Math.abs(d) < 0.004) this.turnTo = null;
      else this.az += d * 0.14;
      this.dirty = true;
    }
    if (Math.abs(this.want - this.dist) > 0.1) {
      this.dist += (this.want - this.dist) * 0.12;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.renderNow();
  };
  renderNow() {
    const sp = Math.sin(this.pol);
    this.camera.position.set(Math.sin(this.az) * sp * this.dist, this.centerY + Math.cos(this.pol) * this.dist, Math.cos(this.az) * sp * this.dist);
    if (this.camera.position.y < 4) this.camera.position.y = 4;
    this.camera.lookAt(0, this.centerY + this.sky * this.dist, 0);
    this.renderer.render(this.scene, this.camera);
    if (this.onPins && this.pins.length) {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      const v = new THREE.Vector3();
      this.onPins(
        this.pins.map((p) => {
          v.copy(p.at).project(this.camera);
          // `own`: the kit has a building for this section (otherwise the pin stands on a free roof).
          return { id: p.id, own: p.own, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, depth: v.z, shown: v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05 };
        }),
      );
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    for (const m of new Set<THREE.Material>([...Object.values(this.mats), ...Object.values(this.wm)])) {
      const s = m as THREE.MeshStandardMaterial;
      s.map?.dispose();
      s.normalMap?.dispose();
      m.dispose();
    }
    this.scene.environment?.dispose();
    this.renderer.dispose();
  }
}
