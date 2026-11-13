import * as THREE from 'three';
import { MOTE_REACH, dropAt, glintAt, mistAt, moteAt, puffAt, type Mote, type Puff, type Spot } from './ambient';

/**
 * Details of a living city (ADR-0045): smoke over the hearths of the districts, glints of sun on the
 * river, mist in the gorge, what the wind carries through each district — petals in the Japanese
 * one, dust in the steppe ones, leaves in the others — and the spray of the fountain on the plaza.
 *
 * The same contract as the weather (ADR-0044): numbers in `ambient.ts`, a function of time alone, no
 * allocation in `update`, nothing read from the server, nothing meant. Which smoke rises where is
 * decided by the buildings that stand there (a great yurt, a chimney), not by any number of the
 * department. With motion off, what would hang in the air — motes, drops, glints — is hidden; smoke
 * and mist stand still. The lowest tier has none of this.
 */
export interface DistrictPlace {
  x: number;
  y: number;
  z: number;
  civ: string;
}
export interface DetailsInput {
  districts: DistrictPlace[];
  /** Hearths of the districts, world coordinates. */
  hearths: THREE.Vector3[];
  /** The spout of the fountain on the plaza, or null when there is none. */
  spout: THREE.Vector3 | null;
  /** The river round the island: radius of its middle, usable width, level of the water. */
  river: { r: number; width: number; y: number };
}
const MOTES_PER_DISTRICT = 12;
const PUFFS_PER_HEARTH = 4;
const MOTE_OF: Record<string, { kind: Mote; color: number }> = {
  japan: { kind: 'petal', color: 0xf3b8c8 },
  kazakh: { kind: 'dust', color: 0xcdb78c },
  mongolia: { kind: 'dust', color: 0xcdb78c },
  russia: { kind: 'leaf', color: 0xc9983c },
  camelot: { kind: 'leaf', color: 0xa9b356 },
};

export class Details {
  readonly group = new THREE.Group();
  private smoke: THREE.InstancedMesh | null = null;
  private glints: THREE.InstancedMesh | null = null;
  private mist: THREE.InstancedMesh | null = null;
  private motes: THREE.InstancedMesh | null = null;
  private drops: THREE.InstancedMesh | null = null;
  private input: DetailsInput | null = null;
  private kinds: Mote[] = [];
  // Scratch objects of `update`.
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private spot: Spot = { x: 0, y: 0, z: 0, s: 0, turn: 0 };
  private puff: Puff = { dx: 0, y: 0, dz: 0, s: 0 };

  constructor(private on: boolean) {
    this.group.name = 'details';
  }

  /** Lay the details over a built city; whatever was there before is replaced. */
  populate(input: DetailsInput) {
    this.clear();
    this.input = input;
    if (!this.on) return;
    const add = (mesh: THREE.InstancedMesh, order: number) => {
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.group.add(mesh);
      return mesh;
    };
    if (input.hearths.length)
      this.smoke = add(
        new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xbdb7ac, roughness: 1, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false, envMapIntensity: 0.2 }), input.hearths.length * PUFFS_PER_HEARTH),
        3,
      );
    // Glints: small flat sparks on the water, added to what is under them.
    this.glints = add(
      new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 0.34).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xfff1cf, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), 44),
      2,
    );
    // Mist: flat patches with a soft edge, lying just over the water. A solid shape here reads as glass.
    this.mist = add(
      new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 0.9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: softSpot(), color: 0xeef2f4, transparent: true, opacity: 0.3, depthWrite: false }), 12),
      2,
    );
    if (input.districts.length) {
      const n = input.districts.length * MOTES_PER_DISTRICT;
      this.motes = add(new THREE.InstancedMesh(new THREE.PlaneGeometry(0.5, 0.34), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), n), 0);
      const c = new THREE.Color();
      this.kinds = [];
      input.districts.forEach((d, k) => {
        const mote = MOTE_OF[d.civ] ?? MOTE_OF.camelot!;
        this.kinds.push(mote.kind);
        for (let i = 0; i < MOTES_PER_DISTRICT; i++) this.motes!.setColorAt(k * MOTES_PER_DISTRICT + i, c.setHex(mote.color));
      });
      this.motes.instanceColor!.needsUpdate = true;
    }
    if (input.spout) this.drops = add(new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 0), new THREE.MeshBasicMaterial({ color: 0xd6ecf2, transparent: true, opacity: 0.85, depthWrite: false }), 18), 2);
  }

  /** The picture at time `t`; `moving` false = motion is off: what would hang in the air is hidden. */
  update(t: number, moving: boolean) {
    const input = this.input;
    if (!input || !this.on) return;
    this.q.identity();
    if (this.smoke) {
      let i = 0;
      for (let h = 0; h < input.hearths.length; h++) {
        const at = input.hearths[h]!;
        for (let k = 0; k < PUFFS_PER_HEARTH; k++) {
          // Every hearth has its own moment: neighbours do not puff in step.
          puffAt(k, PUFFS_PER_HEARTH, t + h * 3.7, this.puff);
          this.p.set(at.x + this.puff.dx * 0.6, at.y + this.puff.y * 0.6 - 0.6, at.z + this.puff.dz * 0.6);
          this.s.setScalar(this.puff.s * 0.62);
          this.smoke.setMatrixAt(i++, this.m.compose(this.p, this.q, this.s));
        }
      }
      this.smoke.instanceMatrix.needsUpdate = true;
    }
    if (this.mist) {
      for (let i = 0; i < this.mist.count; i++) {
        mistAt(i, this.mist.count, input.river.r, t, this.spot);
        this.q.setFromEuler(this.e.set(0, this.spot.turn, 0));
        this.p.set(this.spot.x, input.river.y + this.spot.y, this.spot.z);
        this.s.setScalar(30 * this.spot.s);
        this.mist.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
      }
      this.mist.instanceMatrix.needsUpdate = true;
    }
    if (this.glints) this.glints.visible = moving;
    if (this.motes) this.motes.visible = moving;
    if (this.drops) this.drops.visible = moving;
    if (!moving) return;
    if (this.glints) {
      for (let i = 0; i < this.glints.count; i++) {
        glintAt(i, this.glints.count, input.river.r, input.river.width, t, this.spot);
        this.q.setFromEuler(this.e.set(0, this.spot.turn, 0));
        this.p.set(this.spot.x, input.river.y + 0.08, this.spot.z);
        this.s.setScalar(this.spot.s * 2.4);
        this.glints.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
      }
      this.glints.instanceMatrix.needsUpdate = true;
    }
    if (this.motes) {
      let i = 0;
      for (let d = 0; d < input.districts.length; d++) {
        const at = input.districts[d]!;
        const kind = this.kinds[d]!;
        for (let k = 0; k < MOTES_PER_DISTRICT; k++) {
          moteAt(kind, d * 31 + k, t, this.spot);
          this.q.setFromEuler(this.e.set(this.spot.turn * 0.7, this.spot.turn, 0.4));
          this.p.set(at.x + this.spot.x, at.y + this.spot.y, at.z + this.spot.z);
          this.s.setScalar(this.spot.s * (kind === 'dust' ? 0.8 : 1.15));
          this.motes.setMatrixAt(i++, this.m.compose(this.p, this.q, this.s));
        }
      }
      this.motes.instanceMatrix.needsUpdate = true;
    }
    if (this.drops && input.spout) {
      this.q.identity();
      for (let i = 0; i < this.drops.count; i++) {
        dropAt(i, this.drops.count, t, this.spot);
        this.p.set(input.spout.x + this.spot.x, input.spout.y + this.spot.y, input.spout.z + this.spot.z);
        this.s.setScalar(this.spot.s);
        this.drops.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
      }
      this.drops.instanceMatrix.needsUpdate = true;
    }
  }

  /** For the scenarios: what is laid out, and where the first of each kind is now. */
  snapshot() {
    const first = (mesh: THREE.InstancedMesh | null) => {
      if (!mesh || !mesh.count) return null;
      mesh.getMatrixAt(0, this.m);
      this.p.setFromMatrixPosition(this.m);
      return { x: this.p.x, y: this.p.y, z: this.p.z, shown: mesh.visible };
    };
    return {
      hearths: this.input?.hearths.length ?? 0,
      smoke: this.smoke?.count ?? 0,
      glints: this.glints?.count ?? 0,
      mist: this.mist?.count ?? 0,
      motes: this.motes?.count ?? 0,
      drops: this.drops?.count ?? 0,
      reach: MOTE_REACH,
      mote: first(this.motes),
      drop: first(this.drops),
      puff: first(this.smoke),
    };
  }

  private clear() {
    for (const mesh of [this.smoke, this.glints, this.mist, this.motes, this.drops]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.MeshBasicMaterial).map?.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.smoke = this.glints = this.mist = this.motes = this.drops = null;
  }
  dispose() {
    this.clear();
    this.input = null;
  }
}

/** A white spot that fades to nothing at its edge: the texture of a patch of mist. */
function softSpot() {
  const S = 128;
  const el = document.createElement('canvas');
  el.width = S;
  el.height = S;
  const c = el.getContext('2d')!;
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(el);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
