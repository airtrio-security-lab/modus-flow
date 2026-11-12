import type { Envoy, Kingdom } from './types';

/**
 * What this person saw in the city last time (ADR-0030): department levels and where each envoy
 * stood. Kept on this device only, per organization and person. The city compares it with the
 * server's answer and shows what really changed — a castle that grew, an envoy that moved on.
 * Nothing here is a source of truth: without it the city simply opens still.
 */
export interface CitySeen {
  /** Department id → level. */
  levels: Record<string, number>;
  /** Item number → department, place on the road (0…1) and the item's publication time. */
  envoys: Record<string, { d: string | null; t: number; at: string }>;
}

const key = (org: string, member: string) => `modus.city.seen.${org}.${member}`;

export function readCitySeen(org: string, member: string): CitySeen | null {
  try {
    const raw = localStorage.getItem(key(org, member));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CitySeen>;
    return v && typeof v.levels === 'object' && v.levels && typeof v.envoys === 'object' && v.envoys ? { levels: v.levels, envoys: v.envoys } : null;
  } catch {
    return null;
  }
}

export function writeCitySeen(org: string, member: string, k: Kingdom, placeOf: (e: Envoy) => number) {
  try {
    const seen: CitySeen = {
      levels: Object.fromEntries(k.castles.map((c) => [c.id, c.level])),
      envoys: Object.fromEntries(k.envoys.map((e) => [String(e.number), { d: e.departmentId, t: placeOf(e), at: e.publishedAt }])),
    };
    localStorage.setItem(key(org, member), JSON.stringify(seen));
  } catch {
    /* not remembered: the city opens still next time */
  }
}

/**
 * The part of the memory that is about the items on the road now. A number that belongs to another
 * item (the demo database was seeded again) is not «the same envoy that moved».
 */
export function seenFor(seen: CitySeen | null, k: Kingdom): { levels: Record<string, number>; envoys: Record<string, { d: string | null; t: number }> } | null {
  if (!seen) return null;
  const envoys: Record<string, { d: string | null; t: number }> = {};
  for (const e of k.envoys) {
    const was = seen.envoys[String(e.number)];
    if (was && was.at === e.publishedAt) envoys[`e${e.number}`] = { d: was.d, t: was.t };
  }
  return { levels: seen.levels, envoys };
}
