import test from 'node:test';
import assert from 'node:assert/strict';
import { FEEL, Feel, easeInOutCubic, easeOutBack, easeOutCubic } from '../../web/src/world3d/feel.ts';
import { BUDGET, read } from '../../web/src/world3d/budget.ts';
import { AMBIENT, MOTE_REACH, birdAt, cloudAt, cloudField, dropAt, flicker, flocks, glintAt, hash, mistAt, moteAt, puffAt, shadowShift } from '../../web/src/world3d/ambient.ts';

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

// ---------------------------------------------------------------------------
// The ambient life of the city (ADR-0044): weather is a function of time alone
// ---------------------------------------------------------------------------
test('the weather is a function of time: the same moment is the same picture, and nothing is random', () => {
  const field = cloudField(9);
  assert.deepEqual(field, cloudField(9), 'the cloud field is the same every time it is built');
  assert.equal(new Set(field.map((c) => `${Math.floor(c.x / (AMBIENT.tile / 3))}:${Math.floor(c.z / (AMBIENT.tile / 3))}`)).size, 9, 'one cloud a cell: clouds neither bunch up nor leave half the sky empty');
  assert.deepEqual(cloudField(5), field.slice(0, 5), 'a weaker tier draws fewer of the same clouds');
  const a = { x: 0, z: 0, size: 0 };
  const b = { x: 0, z: 0, size: 0 };
  for (const t of [0, 13.7, 600, 86_400]) {
    assert.deepEqual(cloudAt(field[3]!, t, a), cloudAt(field[3]!, t, b));
    assert.ok(Math.abs(a.x) <= AMBIENT.tile / 2 && Math.abs(a.z) <= AMBIENT.tile / 2, 'a cloud never leaves its square of sky');
    assert.ok(a.size >= 0 && a.size <= 1);
  }
  const f = flocks(300, 4);
  const p = { x: 0, y: 0, z: 0, heading: 0, flap: 0 };
  const q = { x: 0, y: 0, z: 0, heading: 0, flap: 0 };
  assert.deepEqual({ ...birdAt(f[1]!, 3, 42.5, p) }, { ...birdAt(f[1]!, 3, 42.5, q) });
  assert.ok(Math.abs(hash(7, 3) - hash(7, 3)) === 0 && hash(7, 3) >= 0 && hash(7, 3) < 1);
});

test('a cloud wraps unseen: it has shrunk to nothing where it jumps to the other side of the sky', () => {
  const c = cloudField(9)[0]!;
  const now = { x: 0, z: 0, size: 0 };
  const next = { x: 0, z: 0, size: 0 };
  let jumps = 0;
  for (let t = 0; t < 4000; t += 0.5) {
    cloudAt(c, t, now);
    cloudAt(c, t + 0.5, next);
    if (Math.abs(next.x - now.x) > 50 || Math.abs(next.z - now.z) > 50) {
      jumps++;
      assert.ok(now.size < 0.02 && next.size < 0.02, `a cloud of size ${now.size} must not jump across the sky`);
    } else assert.ok(Math.hypot(next.x - now.x, next.z - now.z) < 3, 'between two frames a cloud moves a step, never a leap');
  }
  assert.ok(jumps > 0, 'the walk was long enough to cross the edge');
});

test('the shadow of the clouds stays a small number however long the map is open', () => {
  const sun = { x: -0.58, y: 0.6, z: 0.55 };
  const out = { x: 0, z: 0 };
  for (const t of [0, 1, 3600, 86_400 * 30]) {
    shadowShift(t, sun, 22, out);
    assert.ok(out.x >= 0 && out.x < AMBIENT.tile && out.z >= 0 && out.z < AMBIENT.tile);
  }
  const a = { ...shadowShift(10, sun, 22, out) };
  const b = { ...shadowShift(11, sun, 22, out) };
  assert.ok(Math.abs(b.x - a.x - AMBIENT.wind.x) < 1e-6 && Math.abs(b.z - a.z - AMBIENT.wind.z) < 1e-6, 'the shadow moves with the wind, exactly as its cloud does');
});

test('birds fly over every roof, in a wedge, slowly, and their wings never fold through the body', () => {
  const p = { x: 0, y: 0, z: 0, heading: 0, flap: 0 };
  const n = { x: 0, y: 0, z: 0, heading: 0, flap: 0 };
  for (const ring of [290, 520]) {
    const all = flocks(ring, 4);
    assert.equal(flocks(ring, 1).length, 1);
    assert.equal(flocks(ring, 9).length, 4, 'never more than four flocks');
    for (const f of all)
      for (let k = 0; k < f.n; k++)
        for (let t = 0; t < 900; t += 1.3) {
          birdAt(f, k, t, p);
          // Measured on 2026-11-13 with every district at level 5: roofs end at 94 m, the donjon of the palace at 108 m.
          assert.ok(p.y >= AMBIENT.birdFloor, `bird at ${p.y} m is under the floor of flight`);
          assert.ok(Math.abs(p.flap) < 1.1, 'a wing stays a wing');
          birdAt(f, k, t + 1 / 60, n);
          const step = Math.hypot(n.x - p.x, n.z - p.z);
          assert.ok(step > 0.05 && step < 1.2, `a bird flies ${Math.round(step * 60)} m/s: it should glide, not dart`);
        }
    // The wedge: followers stay within a few wingspans of the leader.
    const lead = { ...birdAt(all[0]!, 0, 50, p) };
    for (let k = 1; k < all[0]!.n; k++) assert.ok(Math.hypot(birdAt(all[0]!, k, 50, p).x - lead.x, p.z - lead.z) < 40);
  }
});

test('smoke is born and dissolves at nothing, and the fire never flashes', () => {
  const p = { dx: 0, y: 0, dz: 0, s: 0 };
  let top = 0;
  for (let t = 0; t < 60; t += 0.05)
    for (let k = 0; k < 6; k++) {
      puffAt(k, 6, t, p);
      assert.ok(p.s >= 0 && p.s < 2.6 && p.y > 0 && p.y < 20);
      if (p.y < 1.5 || p.y > 17.9) assert.ok(p.s < 0.35, 'a puff appears and disappears small');
      top = Math.max(top, p.s);
    }
  assert.ok(top > 0.8, 'in between it is a visible puff');
  for (let t = 0; t < 30; t += 0.01) assert.ok(Math.abs(flicker(t) - 1) < 0.15, 'the fire flickers within 15%');
});

// ---------------------------------------------------------------------------
// Details of the living city (ADR-0045)
// ---------------------------------------------------------------------------
test('details are a function of time: glints stay on the river, mist in the gorge, motes inside their district', () => {
  const a = { x: 0, y: 0, z: 0, s: 0, turn: 0 };
  const b = { x: 0, y: 0, z: 0, s: 0, turn: 0 };
  let lit = 0;
  for (let t = 0; t < 120; t += 0.25)
    for (let i = 0; i < 44; i++) {
      glintAt(i, 44, 166, 18, t, a);
      assert.deepEqual({ ...a }, { ...glintAt(i, 44, 166, 18, t, b) });
      const r = Math.hypot(a.x, a.z);
      assert.ok(r >= 166 - 9.01 && r <= 166 + 9.01, 'a glint never leaves the water');
      assert.ok(a.s >= 0 && a.s < 1.7);
      if (a.s > 0.05) lit++;
    }
  assert.ok(lit / (480 * 44) < 0.35, 'glints are sparks, not a lit river: most of the time a glint is dark');
  assert.ok(lit > 0);
  for (let t = 0; t < 600; t += 7)
    for (let i = 0; i < 12; i++) {
      mistAt(i, 12, 166, t, a);
      assert.ok(Math.abs(Math.hypot(a.x, a.z) - 166) < 1e-6 && a.y > 1 && a.y < 7 && a.s > 0.5 && a.s < 1.5);
    }
  for (const kind of ['petal', 'leaf', 'dust'] as const)
    for (let t = 0; t < 300; t += 0.5)
      for (let i = 0; i < 12; i++) {
        moteAt(kind, i, t, a);
        assert.ok(Math.abs(a.x) <= MOTE_REACH + 6 && Math.abs(a.z) <= MOTE_REACH + 6, `${kind} stays in its district`);
        assert.ok(a.y > 0 && a.y < 19 && a.s >= 0 && a.s < 1.3);
        moteAt(kind, i, t + 1 / 60, b);
        // Where a mote starts again it is of no size: the jump back is never seen.
        if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 2) assert.ok(a.s < 0.2 || b.s < 0.2, `${kind} jumps only while unseen`);
      }
});

test('the fountain throws its drops up and into the bowl, never over the plaza', () => {
  const a = { x: 0, y: 0, z: 0, s: 0, turn: 0 };
  let top = -1e9;
  for (let t = 0; t < 30; t += 0.05)
    for (let i = 0; i < 18; i++) {
      dropAt(i, 18, t, a);
      assert.ok(Math.hypot(a.x, a.z) < 3.7, 'the bowl of the fountain is 5.8 m wide: a drop lands inside it');
      assert.ok(a.y < 2.8 && a.y > -5 && a.s > 0.2);
      top = Math.max(top, a.y);
    }
  assert.ok(top > 1, 'drops rise above the spout before they fall');
});
