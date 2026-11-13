import type { World } from './world';

/**
 * The built 3D city kept between two visits of the map (ADR-0039). Building it is the most expensive
 * thing the map does (terrain, textures, every district); going to a working screen and back used to
 * pay for it every time. One world is kept, parked: no frames, no listeners. It is thrown away after
 * `KEEP_MS`, when the person or the quality tier changes, when the graphics context is lost, and on
 * sign-out — so a device never holds the city's memory for long behind a working screen.
 *
 * No three.js import here (type only): the module stays in the main bundle, three.js stays lazy.
 */
export const KEEP_MS = 120_000;

interface Kept {
  key: string;
  world: World;
  canvas: HTMLCanvasElement;
  timer: number;
}
let kept: Kept | null = null;

/** Park the world of a screen that is being left. */
export function keepWorld(key: string, world: World, canvas: HTMLCanvasElement): void {
  dropWorld();
  world.park();
  canvas.remove();
  kept = { key, world, canvas, timer: window.setTimeout(dropWorld, KEEP_MS) };
}

/** The world kept for this very person, organization and quality tier — or nothing. */
export function takeWorld(key: string): { world: World; canvas: HTMLCanvasElement } | null {
  const k = kept;
  if (!k) return null;
  if (k.key !== key || k.world.lost) {
    dropWorld();
    return null;
  }
  window.clearTimeout(k.timer);
  kept = null;
  return { world: k.world, canvas: k.canvas };
}

export function dropWorld(): void {
  const k = kept;
  if (!k) return;
  kept = null;
  window.clearTimeout(k.timer);
  k.world.dispose();
}

export const hasKeptWorld = (): boolean => kept !== null;
