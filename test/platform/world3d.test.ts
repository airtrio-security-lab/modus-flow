import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEL, Feel, easeInOutCubic, easeOutBack, easeOutCubic } from '../../web/src/world3d/feel.ts';
import { BUDGET, read } from '../../web/src/world3d/budget.ts';

/**
 * The 3D city (ADR-0030) without a browser or a database. The response layer: every movement ends
 * exactly at rest, two movements of one object never fight, switching motion off settles everything.
 * The render budget: a measurement is read the same way by the diagnostics panel and the browser check.
 */
const run = (feel: Feel, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) feel.update(dt);
};

test('a movement ends exactly at rest and reports it once', () => {
  const feel = new Feel();
  const seen: number[] = [];
  let done = 0;
  feel.play({ duration: 0.3, easing: easeOutBack, step: (v) => seen.push(v), done: () => done++ });
  run(feel, 1);
  assert.equal(seen.at(-1), 1, 'the last value is exactly 1, not an approximation');
  assert.ok(seen.some((v) => v > 1), 'easeOutBack overshoots before it settles');
  assert.equal(done, 1);
  assert.equal(feel.size, 0);
  run(feel, 1);
  assert.equal(done, 1, 'a finished movement is never called again');
});

test('a new movement with the same key settles the old one first', () => {
  const feel = new Feel();
  const log: string[] = [];
  feel.play({ key: 'castle', duration: 1, step: (_, t) => log.push(`a${t === 1 ? ':rest' : ''}`), done: () => log.push('a:done') });
  run(feel, 0.03);
  feel.play({ key: 'castle', duration: 0.2, step: (_, t) => log.push(`b${t === 1 ? ':rest' : ''}`), done: () => log.push('b:done') });
  const restOfA = log.indexOf('a:rest');
  assert.ok(restOfA > 0 && log[restOfA + 1] === 'a:done' && log[restOfA + 2] === 'b', 'the old movement reached rest before the new one started');
  run(feel, 1);
  assert.deepEqual(log.slice(-2), ['b:rest', 'b:done']);
  assert.equal(feel.size, 0);
});

test('a delayed movement waits; with hold it takes the starting pose at once', () => {
  const feel = new Feel();
  let plain = -1;
  let held = -1;
  feel.play({ delay: 0.5, duration: 0.2, easing: easeOutCubic, step: (v) => (plain = v) });
  feel.play({ delay: 0.5, hold: true, duration: 0.2, easing: easeOutCubic, step: (v) => (held = v) });
  assert.equal(plain, -1, 'nothing moves before the delay');
  assert.equal(held, 0, 'the held object stands at its start');
  run(feel, 0.4);
  assert.equal(plain, -1);
  assert.equal(held, 0);
  run(feel, 1);
  assert.equal(plain, 1);
  assert.equal(held, 1);
});

test('settle brings everything to rest at once (reduced motion, screenshots)', () => {
  const feel = new Feel();
  const values = [0, 0, 0];
  let done = 0;
  values.forEach((_, i) => feel.play({ key: `e${i}`, delay: i, duration: 2, step: (v) => (values[i] = v), done: () => done++ }));
  run(feel, 0.1);
  feel.settle();
  assert.deepEqual(values, [1, 1, 1]);
  assert.equal(done, 3);
  assert.equal(feel.size, 0);
});

test('drop forgets a movement without touching its object', () => {
  const feel = new Feel();
  let calls = 0;
  feel.play({ key: 'gone', delay: 0.1, duration: 1, step: () => calls++, done: () => calls++ });
  feel.drop('gone');
  run(feel, 2);
  assert.equal(calls, 0);
  assert.equal(feel.size, 0);
});

test('a very long frame completes the movement instead of breaking it', () => {
  const feel = new Feel();
  let last = Number.NaN;
  feel.play({ duration: 0.4, easing: easeInOutCubic, step: (v) => (last = v) });
  feel.update(30);
  assert.equal(last, 1);
  feel.update(Number.NaN);
  feel.update(-1);
  assert.equal(feel.size, 0);
});

test('a movement started from `done` runs on the following frames', () => {
  const feel = new Feel();
  let second = -1;
  feel.play({ duration: 0.1, step: () => undefined, done: () => feel.play({ duration: 0.1, step: (v) => (second = v) }) });
  run(feel, 1);
  assert.equal(second, 1);
  assert.equal(feel.size, 0);
});

test('tiers stay proportional: routine answers are shorter than the castle growing', () => {
  assert.ok(FEEL.select.duration < FEEL.arrive.duration && FEEL.arrive.duration < FEEL.grow.duration);
  assert.ok(FEEL.grow.squash > 0.5 && FEEL.grow.squash < 1, 'the building is pressed, never flattened');
  assert.ok(FEEL.walk.base + FEEL.walk.perRoad <= 4, 'the longest walk does not make the person wait');
  for (const ease of [easeOutCubic, easeOutBack, easeInOutCubic]) {
    assert.ok(Math.abs(ease(0)) < 1e-9, 'curves start at 0');
    assert.ok(Math.abs(ease(1) - 1) < 1e-9, 'curves end at 1');
  }
});

test('a measurement is read against the budget of its tier', () => {
  const base = { quality: 'high' as const, calls: 150, triangles: 600_000, medianMs: 16.7, p90Ms: 18, gpu: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' };
  const smooth = read(base);
  assert.equal(smooth.level, 'ok');
  assert.equal(smooth.fps, 60);
  assert.equal(smooth.software, false);

  assert.equal(read({ ...base, medianMs: 30, p90Ms: 34 }).level, 'warn', '30 frames a second is a warning');
  const slow = read({ ...base, medianMs: 50, p90Ms: 60 });
  assert.equal(slow.level, 'bad');
  assert.match(slow.notes[0]!, /закрепите уровень качества ниже/);
  assert.match(read({ ...base, quality: 'low', medianMs: 50, p90Ms: 60 }).notes[0]!, /Схему/, 'on the lowest tier the advice is the schematic city');

  const jerky = read({ ...base, p90Ms: 80 });
  assert.equal(jerky.level, 'warn', 'stutter hidden by the median is still reported');

  const heavy = read({ ...base, calls: BUDGET.high.calls + 1, triangles: BUDGET.high.triangles + 1 });
  assert.ok(heavy.overCalls && heavy.overTriangles);
  assert.equal(heavy.level, 'warn');
  assert.equal(heavy.notes.length, 3);

  const software = read({ ...base, medianMs: 1600, p90Ms: 4000, gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' });
  assert.ok(software.software);
  assert.match(software.notes[0]!, /Программная отрисовка/, 'software rendering is said first: its frame time is not evidence');

  const none = read({ ...base, medianMs: 0, p90Ms: 0 });
  assert.equal(none.level, 'none');
  assert.equal(none.fps, 0);
  assert.ok(BUDGET.low.triangles < BUDGET.medium.triangles && BUDGET.medium.triangles < BUDGET.high.triangles);
});
