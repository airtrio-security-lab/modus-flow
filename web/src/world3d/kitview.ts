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
    const g = b.build(this.mats);
    g.scale.setScalar(1.4);
    this.scene.add(g);
    this.kit = g;
    const box = new THREE.Box3().setFromObject(g);
    const size = box.getSize(new THREE.Vector3());
    this.centerY = Math.min(22, size.y * 0.32);
    this.want = Math.max(64, Math.hypot(size.x, size.z) * 1.05 + size.y * 0.5);
    this.renderer.shadowMap.needsUpdate = true;
    this.dirty = true;
  }

  resize(w: number, h: number) {
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private onDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture?.(e.pointerId);
    this.drag = { x: e.clientX, y: e.clientY };
    this.spin = false;
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
      if (this.pinch > 0) this.want = Math.min(420, Math.max(45, this.want * (this.pinch / Math.max(1, d))));
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
    this.camera.lookAt(0, this.centerY, 0);
    this.renderer.render(this.scene, this.camera);
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
