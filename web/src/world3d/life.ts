import * as THREE from 'three';
import { AMBIENT, birdAt, cloudAt, cloudField, flicker, flocks, puffAt, shadowShift, type Bird, type Cloud, type CloudPlace, type Flock, type Puff } from './ambient';

/**
 * The ambient life of the 3D city in the scene (ADR-0044): drifting clouds with their shadows on the
 * land and the roofs, shafts of sunlight at the edges of the clouds, flocks of birds drawn as simple
 * ticks, smoke over the envoys' camp, cloth and treetops that move in the wind.
 *
 * The numbers live in `ambient.ts`; this file only draws them. It reads nothing from the server and
 * shows nothing about the data. One `update(t)` a frame, no allocation in it. With motion off the
 * layer is frozen at t = 0 and the birds are hidden: a bird that hangs in the air is worse than none.
 *
 * Cloud shadows are not shadow-map shadows: the city's shadow map is redrawn only when the city
 * changes, and redrawing it every frame for a cloud would cost more than the whole scene. Instead
 * every lit material darkens itself by one small repeating texture, sampled by the world position.
 */
export type LifeTier = 'high' | 'medium' | 'low';
const PLAN: Record<LifeTier, { clouds: number; bodies: boolean; flocks: number; shafts: boolean; sway: boolean; puffs: number }> = {
  high: { clouds: 9, bodies: true, flocks: 4, shafts: true, sway: true, puffs: 7 },
  medium: { clouds: 7, bodies: true, flocks: 3, shafts: true, sway: true, puffs: 6 },
  // The weakest tier keeps what costs next to nothing: the shadows of the clouds and one flock. No blended
  // surfaces (cloud bodies, shafts, smoke) and no moving vertices — there every pixel drawn twice is felt.
  low: { clouds: 5, bodies: false, flocks: 1, shafts: false, sway: false, puffs: 0 },
};
/** What a material does in the wind, besides taking the shade of a cloud. */
export type Sway = 'none' | 'cloth' | 'tree';

const SHADE_PARS = /* glsl */ `
varying vec2 vLifeXZ;
uniform sampler2D uLifeCloud;
uniform vec2 uLifeShift;
uniform float uLifeShade;
`;
const SHADE = /* glsl */ `
#include <color_fragment>
diffuseColor.rgb *= 1.0 - uLifeShade * texture2D(uLifeCloud, (vLifeXZ - uLifeShift) / ${AMBIENT.tile.toFixed(1)}).r;
`;

export class Life {
  readonly group = new THREE.Group();
  /** Shared by every patched material: one write a frame moves every shadow, banner and treetop. */
  private uniforms = {
    uLifeTime: { value: 0 },
    uLifeCloud: { value: null as THREE.Texture | null },
    uLifeShift: { value: new THREE.Vector2() },
    uLifeShade: { value: AMBIENT.shade as number },
  };
  private plan: (typeof PLAN)[LifeTier];
  private field: Cloud[];
  private clouds: THREE.InstancedMesh | null = null;
  private cloudMask: THREE.InstancedMesh | null = null;
  private shafts: THREE.InstancedMesh | null = null;
  private birds: THREE.InstancedMesh;
  private smoke: THREE.InstancedMesh | null = null;
  private flocks: Flock[] = [];
  private fire: THREE.MeshStandardMaterial | null = null;
  private fireBase = 1;
  private sky: THREE.ShaderMaterial | null = null;
  private camp = new THREE.Vector3();
  private groundY = 0;
  private sun: THREE.Vector3;
  /** Time shown now; -1 = nothing drawn yet. */
  private shown = -1;
  // Scratch objects of `update`: nothing is allocated in a frame.
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private place: CloudPlace = { x: 0, z: 0, size: 0 };
  private bird: Bird = { x: 0, y: 0, z: 0, heading: 0, flap: 0 };
  private puff: Puff = { dx: 0, y: 0, dz: 0, s: 0 };
  private shift = { x: 0, z: 0 };
  private across = new THREE.Vector3();
  private ring = 300;

  constructor(sun: THREE.Vector3, tier: LifeTier) {
    this.sun = sun.clone().normalize();
    this.plan = PLAN[tier];
    this.field = cloudField(this.plan.clouds);
    this.uniforms.uLifeCloud.value = shadowTexture(this.field);
    this.group.name = 'life';

    // Clouds: soft lumps, one instance each. Drawn twice: first only into the depth buffer, then the colour
    // where the depth matches — so the lumps of one cloud make one translucent body, not a pile of discs.
    if (this.plan.bodies) {
    const lumps = this.field.reduce((n, c) => n + c.lumps.length, 0);
    const cloudGeo = new THREE.IcosahedronGeometry(1, 2);
    cloudGeo.scale(1, 0.52, 1);
    this.cloudMask = new THREE.InstancedMesh(cloudGeo, new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true }), lumps);
    this.cloudMask.frustumCulled = false;
    this.cloudMask.renderOrder = 3;
    this.clouds = new THREE.InstancedMesh(
      cloudGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xb9c2d2, emissiveIntensity: 0.55, roughness: 1, metalness: 0, transparent: true, opacity: 0.88, depthWrite: false, depthFunc: THREE.EqualDepth, envMapIntensity: 0 }),
      lumps,
    );
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 3.5;
    // One set of matrices for both passes.
    this.clouds.instanceMatrix = this.cloudMask.instanceMatrix;
    this.group.add(this.cloudMask, this.clouds);
    }

    // Shafts of light: two crossed blades along the sun's ray at the lit edge of a cloud.
    if (this.plan.shafts) {
      const n = Math.min(AMBIENT.shafts, Math.ceil(this.field.length / 2));
      // One blade a shaft, turned round the sun's ray to face the camera: never seen edge-on as a thin line.
      this.shafts = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: shaftTexture(), color: 0xffe2ad, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false }),
        n,
      );
      this.shafts.frustumCulled = false;
      this.shafts.renderOrder = 4;
      this.shafts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(0), 3);
      this.group.add(this.shafts);
    }

    // Birds: one triangle per wing. Two instances a bird, mirrored — a tick that beats its wings.
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.42, 1, 0, -0.5, 0, 0, -0.16], 3));
    wing.computeVertexNormals();
    this.birds = new THREE.InstancedMesh(wing, new THREE.MeshBasicMaterial({ color: 0x1f2328, side: THREE.DoubleSide }), 2);
    this.birds.frustumCulled = false;
    this.group.add(this.birds);
  }

  /**
   * The place of the layer in a built city: the ring of districts sets the loops of the flocks, the
   * camp is where the smoke rises, `groundY` is the level cloud shadows are aimed at. Called when the
   * land is rebuilt; the old flocks and smoke are replaced.
   */
  attach(ring: number, groundY: number, camp: THREE.Vector3 | null, fire: THREE.MeshStandardMaterial | null) {
    this.groundY = groundY;
    this.ring = ring;
    this.flocks = flocks(ring, this.plan.flocks);
    const n = this.flocks.reduce((k, f) => k + f.n, 0) * 2;
    const old = this.birds;
    this.birds = new THREE.InstancedMesh(old.geometry, old.material, Math.max(1, n));
    this.birds.frustumCulled = false;
    this.birds.count = n;
    this.group.remove(old);
    old.dispose();
    this.group.add(this.birds);

    if (this.smoke) {
      this.group.remove(this.smoke);
      this.smoke.geometry.dispose();
      (this.smoke.material as THREE.Material).dispose();
      this.smoke.dispose();
      this.smoke = null;
    }
    if (camp && this.plan.puffs) {
      this.camp.copy(camp);
      this.smoke = new THREE.InstancedMesh(
        new THREE.IcosahedronGeometry(1, 1),
        new THREE.MeshStandardMaterial({ color: 0xb9b3a8, roughness: 1, metalness: 0, transparent: true, opacity: 0.34, depthWrite: false, envMapIntensity: 0.2 }),
        this.plan.puffs,
      );
      this.smoke.frustumCulled = false;
      this.smoke.renderOrder = 3;
      this.group.add(this.smoke);
    }
    this.fire = fire;
    this.fireBase = fire ? fire.emissiveIntensity : 1;
    this.shown = -1;
  }

  /** The sky drifts with the same wind: its `time` uniform is driven from here. */
  bindSky(sky: THREE.Mesh) {
    const mat = sky.material as THREE.ShaderMaterial;
    if (mat.uniforms?.time) this.sky = mat;
  }

  /**
   * Teach a lit material the weather: it takes the shade of the clouds and, if asked, moves in the
   * wind — cloth ripples along its own normal, a treetop leans (the trunk stays where it stands).
   * Call before the material is first drawn. Materials patched the same way share one program.
   */
  enliven(mat: THREE.Material, sway: Sway = 'none') {
    const move = this.plan.sway ? sway : 'none';
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vLifeXZ;\nuniform float uLifeTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          ${
            move === 'cloth'
              ? 'transformed += normal * sin(uLifeTime * 2.3 + position.x * 0.55 + position.y * 1.25 + position.z * 0.55) * 0.17;'
              : move === 'tree'
                ? `#ifdef USE_INSTANCING
                   float lifePhase = instanceMatrix[3].x * 0.071 + instanceMatrix[3].z * 0.053;
                   float lifeLean = max(position.y - 2.5, 0.0) * 0.022;
                   transformed.x += sin(uLifeTime * 1.15 + lifePhase) * lifeLean;
                   transformed.z += cos(uLifeTime * 0.9 + lifePhase * 1.3) * lifeLean * 0.7;
                   #endif`
                : ''
          }
          #ifdef USE_INSTANCING
          vLifeXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
          #else
          vLifeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
          #endif`,
        );
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${SHADE_PARS}`).replace('#include <color_fragment>', SHADE);
    };
    // Materials that move differently must not share a compiled program.
    mat.customProgramCacheKey = () => `life:${move}`;
  }

  /** The picture at time `t` seconds. `camera` is used only to keep a cloud from filling the screen. */
  update(t: number, camera: THREE.Camera) {
    this.shown = t;
    this.birds.visible = true;
    this.uniforms.uLifeTime.value = t;
    shadowShift(t, this.sun, this.groundY, this.shift);
    this.uniforms.uLifeShift.value.set(this.shift.x, this.shift.z);
    if (this.sky) this.sky.uniforms.time!.value = t;
    if (this.fire) this.fire.emissiveIntensity = this.fireBase * flicker(t);

    // Clouds; a cloud right in front of the camera shrinks away instead of whiting out the view.
    let i = 0;
    let shaft = 0;
    const cam = camera.position;
    this.q.identity();
    for (let k = 0; k < this.field.length; k++) {
      const c = this.field[k]!;
      cloudAt(c, t, this.place);
      // The body of a cloud is drawn only over the outskirts and the mountains: over the city it would hide
      // the very thing people came to look at, so there only its shadow passes. A cloud close to the camera
      // shrinks away as well instead of whiting out the view.
      const near = Math.hypot(this.place.x - cam.x, AMBIENT.cloudY - cam.y, this.place.z - cam.z);
      const out = Math.hypot(this.place.x, this.place.z);
      const size = this.place.size * smoothstep(260, 540, near) * smoothstep(this.ring + 90, this.ring + 250, out);
      if (this.clouds)
        for (const l of c.lumps) {
          this.p.set(this.place.x + l.dx, AMBIENT.cloudY + l.dy, this.place.z + l.dz);
          this.s.setScalar(l.s * size);
          this.clouds.setMatrixAt(i++, this.m.compose(this.p, this.q, this.s));
        }
      // A shaft at the sunward edge of every second cloud; it breathes slowly, each at its own pace.
      if (this.shafts && k % 2 === 0 && shaft < this.shafts.count) {
        const len = (AMBIENT.cloudY - this.groundY) / this.sun.y;
        const w = c.r * 1.05 * this.place.size;
        // Start under the edge of the cloud that faces the sun and run down the ray to the ground.
        this.p.set(this.place.x + this.sun.x * c.r * 0.7, AMBIENT.cloudY - c.r * 0.12, this.place.z + this.sun.z * c.r * 0.7).addScaledVector(this.sun, -len / 2);
        const glow = (0.55 + 0.45 * Math.sin(t * 0.17 + k * 1.9)) * 0.2 * this.place.size;
        this.c.setScalar(glow);
        // Across the ray and across the line of sight.
        this.across.copy(cam).sub(this.p).cross(this.sun);
        if (this.across.lengthSq() < 1e-6) this.across.set(1, 0, 0);
        this.blade(shaft++, this.across.normalize(), w, len);
      }
    }
    if (this.clouds) this.clouds.instanceMatrix.needsUpdate = true;
    if (this.shafts) {
      this.shafts.instanceMatrix.needsUpdate = true;
      this.shafts.instanceColor!.needsUpdate = true;
    }

    // Birds: two wings each, mirrored, rolled about the line of flight.
    i = 0;
    for (const f of this.flocks)
      for (let k = 0; k < f.n; k++) {
        birdAt(f, k, t, this.bird);
        this.p.set(this.bird.x, this.bird.y, this.bird.z);
        for (let side = 1; side >= -1; side -= 2) {
          this.q.setFromEuler(this.e.set(0, this.bird.heading, side * this.bird.flap, 'YXZ'));
          this.s.set(side * 4.6, 4.6, 4.6);
          this.birds.setMatrixAt(i++, this.m.compose(this.p, this.q, this.s));
        }
      }
    this.birds.instanceMatrix.needsUpdate = true;

    if (this.smoke) {
      this.q.identity();
      for (let k = 0; k < this.smoke.count; k++) {
        puffAt(k, this.smoke.count, t, this.puff);
        this.p.set(this.camp.x + this.puff.dx, this.camp.y + this.puff.y, this.camp.z + this.puff.dz);
        this.s.setScalar(this.puff.s);
        this.smoke.setMatrixAt(k, this.m.compose(this.p, this.q, this.s));
      }
      this.smoke.instanceMatrix.needsUpdate = true;
    }
  }
  // One blade of a shaft: `across` wide, `len` long down the sun's ray, centred on `this.p`, tinted `this.c`.
  private long = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private blade(i: number, across: THREE.Vector3, w: number, len: number) {
    this.m.makeBasis(this.s.copy(across).multiplyScalar(w), this.long.copy(this.sun).multiplyScalar(len), this.normal.copy(across).cross(this.sun).normalize());
    this.m.setPosition(this.p);
    this.shafts!.setMatrixAt(i, this.m);
    this.shafts!.setColorAt(i, this.c);
  }

  /** Motion is off: the layer stands at t = 0 and the birds are hidden. The camera still matters — a cloud never fills the view. */
  rest(camera: THREE.Camera) {
    this.update(0, camera);
    this.birds.visible = false;
  }
  /** True while the layer shows anything but its resting picture. */
  get moving() {
    return this.shown !== 0 || this.birds.visible;
  }

  /** For the scenarios: where things are right now, read back from the scene itself. */
  snapshot() {
    const at = (mesh: THREE.InstancedMesh, i: number) => {
      mesh.getMatrixAt(i, this.m);
      this.p.setFromMatrixPosition(this.m);
      return { x: this.p.x, y: this.p.y, z: this.p.z };
    };
    return {
      t: this.shown,
      // The first cloud of the field, body or not: its shadow is there on every tier.
      cloud: { ...cloudAt(this.field[0]!, Math.max(0, this.shown), this.place), y: AMBIENT.cloudY },
      bodies: this.clouds ? this.clouds.count : 0,
      bird: this.birds.count ? at(this.birds, 0) : null,
      birds: this.birds.count / 2,
      birdsVisible: this.birds.visible,
      clouds: this.field.length,
      shafts: this.shafts ? this.shafts.count : 0,
      puffs: this.smoke ? this.smoke.count : 0,
      shift: { x: this.uniforms.uLifeShift.value.x, z: this.uniforms.uLifeShift.value.y },
    };
  }

  dispose() {
    for (const mesh of [this.cloudMask, this.clouds, this.shafts, this.birds, this.smoke]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      mesh.dispose();
    }
    this.uniforms.uLifeCloud.value?.dispose();
    if (this.fire) this.fire.emissiveIntensity = this.fireBase;
  }
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The shade of the whole cloud field in one repeating texture: a soft dark spot per lump, painted
 * with its wrapped copies so the tile has no seam. White = full shade.
 */
function shadowTexture(field: Cloud[]) {
  const S = 512;
  const el = document.createElement('canvas');
  el.width = S;
  el.height = S;
  const c = el.getContext('2d')!;
  c.fillStyle = '#000';
  c.fillRect(0, 0, S, S);
  c.globalCompositeOperation = 'lighter';
  const k = S / AMBIENT.tile;
  for (const cloud of field)
    for (const l of cloud.lumps) {
      const r = l.s * 1.5 * k;
      for (const ox of [-S, 0, S])
        for (const oy of [-S, 0, S]) {
          const x = (cloud.x + l.dx) * k + ox;
          const y = (cloud.z + l.dz) * k + oy;
          if (x < -r || x > S + r || y < -r || y > S + r) continue;
          const g = c.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, 'rgba(255,255,255,0.62)');
          g.addColorStop(0.55, 'rgba(255,255,255,0.3)');
          g.addColorStop(1, 'rgba(255,255,255,0)');
          c.fillStyle = g;
          c.fillRect(x - r, y - r, r * 2, r * 2);
        }
    }
  const t = new THREE.CanvasTexture(el);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** A blade of light: bright under the cloud, gone at the ground, soft at both sides. */
function shaftTexture() {
  const W = 64;
  const H = 256;
  const el = document.createElement('canvas');
  el.width = W;
  el.height = H;
  const c = el.getContext('2d')!;
  const img = c.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const across = Math.sin((x / (W - 1)) * Math.PI) ** 2;
      const v = y / (H - 1);
      // v = 0 is the top of the canvas — the end of the blade under the cloud.
      const along = smoothstep(0, 0.12, v) * (1 - v) ** 1.4;
      const a = Math.round(255 * across * along);
      const o = (y * W + x) * 4;
      img.data[o] = a;
      img.data[o + 1] = a;
      img.data[o + 2] = a;
      img.data[o + 3] = 255;
    }
  c.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(el);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
