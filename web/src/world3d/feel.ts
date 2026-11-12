/**
 * The response layer of the scene (ADR-0030): short eased movements that answer REAL data events —
 * an envoy moved to another stage, a castle grew, a district was selected. Only time and curves live
 * here: no rules, no rights, no randomness (never `Math.random`) and no three.js, so the module is
 * covered by a plain unit test.
 *
 * Rules of the layer:
 * - a response explains state and never blocks input: the camera and clicks work while it plays;
 * - every movement ends exactly at rest (`step(1, 1)`), so nothing drifts;
 * - two movements of one object never fight: a new one with the same `key` settles the old one first;
 * - time is the real frame delta; with reduced motion the layer does not start at all.
 */
export type Easing = (t: number) => number;

export const linear: Easing = (t) => t;
export const easeInQuad: Easing = (t) => t * t;
export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic: Easing = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Overshoots 1 and comes back: the small spring at the end of a movement. */
export const easeOutBack: Easing = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/**
 * Tiers: the rarer and more important the event, the stronger the answer. Routine actions stay
 * quiet, so the one real event — a castle that grew — cannot be mistaken for anything else.
 */
export const FEEL = {
  /** A district is selected: the ring settles into place. */
  select: { duration: 0.28 },
  /** A new envoy appeared. */
  arrive: { duration: 0.45 },
  /** An envoy left: the item is closed. */
  leave: { duration: 0.35 },
  /** An envoy walks to its new stage: seconds = base + perRoad × share of the road. */
  walk: { base: 1.4, perRoad: 2.4 },
  /** A castle grew: the building rises, a ring spreads over the ground. */
  grow: { duration: 0.9, pulse: 1.6, squash: 0.82 },
  /** Pause before showing what changed since the last visit: the person sees the city first. */
  sinceDelay: 1.1,
  /** Shift between envoys, so they do not march in step. */
  stagger: 0.12,
} as const;

export interface TweenSpec {
  /** One movement per key: a new one settles the previous and takes its place. */
  key?: string;
  /** Seconds before the start. */
  delay?: number;
  /** Take the starting pose at once and hold it through the delay (an envoy waits where it stood). */
  hold?: boolean;
  /** Seconds. */
  duration: number;
  easing?: Easing;
  /** `v` is the curve value (may leave 0…1), `t` the share of time 0…1. The last call is always `step(1, 1)`. */
  step: (v: number, t: number) => void;
  done?: () => void;
}
interface Active extends TweenSpec {
  elapsed: number;
  started: boolean;
}

export class Feel {
  private list: Active[] = [];

  /** Movements playing or waiting for their start. */
  get size() {
    return this.list.length;
  }
  has(key: string) {
    return this.list.some((t) => t.key === key);
  }

  play(spec: TweenSpec) {
    if (spec.key) this.settle(spec.key);
    const t: Active = { ...spec, elapsed: -(spec.delay ?? 0), started: false };
    this.list.push(t);
    // Without a delay the object takes its starting pose at once instead of waiting a frame at rest.
    if (t.elapsed >= 0 || t.hold) this.begin(t);
  }

  /** Real frame delta, seconds. A long frame (a sleeping tab) simply completes the movement. */
  update(dt: number) {
    if (!this.list.length || !(dt > 0)) return;
    // A copy: `done` may start new movements.
    for (const t of [...this.list]) {
      if (!this.list.includes(t)) continue;
      t.elapsed += dt;
      if (t.elapsed < 0) continue;
      if (!t.started) this.begin(t);
      const k = t.duration > 0 ? Math.min(1, t.elapsed / t.duration) : 1;
      if (k >= 1) this.end(t);
      else t.step((t.easing ?? easeOutCubic)(k), k);
    }
  }

  /** Bring the movements with this key (or all of them) to their end: rest state, `done` called. */
  settle(key?: string) {
    for (const t of [...this.list]) if (key === undefined || t.key === key) this.end(t);
  }

  /** Forget the movements with this key without finishing them (their object is gone). */
  drop(key: string) {
    this.list = this.list.filter((t) => t.key !== key);
  }

  private begin(t: Active) {
    t.started = true;
    t.step((t.easing ?? easeOutCubic)(0), 0);
  }
  private end(t: Active) {
    const i = this.list.indexOf(t);
    if (i < 0) return;
    this.list.splice(i, 1);
    t.step(1, 1);
    t.done?.();
  }
}
