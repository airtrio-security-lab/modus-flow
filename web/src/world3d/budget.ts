/**
 * Render budget of the 3D city (ADR-0030) and the reading of a measurement. Pure numbers, no three.js
 * and no DOM: the same function is used by the diagnostics panel, the browser check and the unit test.
 *
 * The budget is for the demo city (8 districts, about 30 envoys). Measured on 2026-11-12 in the kit
 * harness (8 districts, 21 envoys): 147 draw calls on every tier; 295 / 440 / 649 thousand triangles
 * on low / medium / high. An envoy costs one draw call. A larger organization needs its own numbers.
 */
export type Tier = 'high' | 'medium' | 'low';

export const BUDGET: Record<Tier, { calls: number; triangles: number }> = {
  low: { calls: 220, triangles: 450_000 },
  medium: { calls: 220, triangles: 650_000 },
  high: { calls: 220, triangles: 950_000 },
};
/** Median frame time, ms: 60 frames a second with a small reserve, and 30. */
export const FRAME = { smooth: 20, playable: 36 } as const;

export interface Measured {
  quality: Tier;
  calls: number;
  triangles: number;
  medianMs: number;
  p90Ms: number;
  /** The renderer string of the device, if the browser shows it. */
  gpu?: string;
}
export interface Reading {
  /** Frames a second from the median frame time; 0 = not measured yet. */
  fps: number;
  level: 'ok' | 'warn' | 'bad' | 'none';
  /** Plain-language findings, most important first. */
  notes: string[];
  overCalls: boolean;
  overTriangles: boolean;
  /** Software rendering: the numbers say nothing about a real GPU. */
  software: boolean;
}

const SOFTWARE = /swiftshader|llvmpipe|software|basic render/i;

export function read(m: Measured): Reading {
  const b = BUDGET[m.quality];
  const overCalls = m.calls > b.calls;
  const overTriangles = m.triangles > b.triangles;
  const software = SOFTWARE.test(m.gpu ?? '');
  const notes: string[] = [];
  const fps = m.medianMs > 0 ? Math.round(1000 / m.medianMs) : 0;
  let level: Reading['level'] = 'none';
  if (fps > 0) {
    if (m.medianMs <= FRAME.smooth) {
      level = 'ok';
      notes.push('Плавно: около 60 кадров в секунду.');
    } else if (m.medianMs <= FRAME.playable) {
      level = 'warn';
      notes.push('Около 30 кадров в секунду: для телефона приемлемо, на большом экране заметно.');
    } else {
      level = 'bad';
      notes.push(m.quality === 'low' ? 'Меньше 30 кадров в секунду даже на низком уровне: на этом устройстве показывайте «Схему».' : 'Меньше 30 кадров в секунду: закрепите уровень качества ниже.');
    }
    // Stutter that the median hides.
    if (m.p90Ms > m.medianMs * 2 && m.p90Ms > FRAME.playable) {
      notes.push('Есть рывки: каждый десятый кадр вдвое длиннее обычного.');
      if (level === 'ok') level = 'warn';
    }
  } else notes.push('Замер ещё не сделан.');
  if (overCalls) notes.push(`Вызовов отрисовки больше бюджета (${m.calls} из ${b.calls}).`);
  if (overTriangles) notes.push(`Треугольников больше бюджета (${m.triangles} из ${b.triangles}).`);
  if ((overCalls || overTriangles) && level === 'ok') level = 'warn';
  if (software) notes.unshift('Программная отрисовка без видеокарты: время кадра здесь не показатель.');
  return { fps, level, notes, overCalls, overTriangles, software };
}
