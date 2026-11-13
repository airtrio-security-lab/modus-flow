import test from 'node:test';
import assert from 'node:assert/strict';
import { TTL_MS, mergeWorldContext, parseWorldContext, reconcile, returnLabel, worldRoute } from '../../web/src/lib/worldReturn.ts';

/**
 * Seamless world (ADR-0038) without a browser or a database: what is remembered when a person enters
 * a building, and — more important — what is refused when they come back: another organization's
 * context, an expired one, a route that is not a world screen, a department that no longer exists.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const DEPT = '33333333-3333-4333-8333-333333333333';
const GONE = '44444444-4444-4444-8444-444444444444';
const who = { org: ORG, member: ME };
const NOW = 1_800_000_000_000;
const view = { x: 12, z: -40, dist: 205, az: 0.42, pol: 1.08 };
const stored = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...mergeWorldContext(null, who, { from: '#/kingdom', mode: '3d', view, selected: DEPT, place: 'library' }, NOW), ...patch });

test('only world screens are routes to come back to', () => {
  assert.equal(worldRoute('#/kingdom'), '#/kingdom');
  assert.equal(worldRoute('#/kingdom?diag=1'), '#/kingdom', 'the query is not part of the place');
  assert.equal(worldRoute(`#/castles/${DEPT}`), `#/castles/${DEPT}`);
  assert.equal(worldRoute(`#/castles/${DEPT}/warriors`), `#/castles/${DEPT}/warriors`);
  for (const no of ['#/library', '#/items/12', '#/', '', '#/castles/not-an-id', `#/castles/${DEPT}/../settings`, 'javascript:alert(1)', 'https://example.com/#/kingdom', `#/kingdom/../settings`])
    assert.equal(worldRoute(no), null, no);
});

test('the context comes back whole for the reader it was written for', () => {
  const c = parseWorldContext(stored(), who, NOW + 60_000);
  assert.deepEqual(c, { v: 1, org: ORG, member: ME, from: '#/kingdom', mode: '3d', view, selected: DEPT, place: 'library', at: NOW });
});

test('another organization, another person and an expired context are refused', () => {
  assert.equal(parseWorldContext(stored(), { org: GONE, member: ME }, NOW), null, 'switching the organization starts from the ordinary view');
  assert.equal(parseWorldContext(stored(), { org: ORG, member: GONE }, NOW), null, 'the next person on this device does not inherit the place');
  assert.equal(parseWorldContext(stored(), who, NOW + TTL_MS + 1), null);
  assert.equal(parseWorldContext(stored({ at: NOW + 3_600_000 }), who, NOW), null, 'a time from the future is not trusted');
  assert.equal(parseWorldContext(stored({ v: 2 }), who, NOW), null);
});

test('malformed storage never throws and never restores a half-read place', () => {
  for (const raw of [null, '', 'null', '[]', '{', '"x"', '42']) assert.equal(parseWorldContext(raw, who, NOW), null);
  const c = parseWorldContext(stored({ view: { ...view, dist: 'far' }, from: '#/settings', selected: '<script>', place: { id: 1 }, mode: 'god' }), who, NOW)!;
  assert.deepEqual([c.view, c.from, c.selected, c.place, c.mode], [null, null, null, null, null]);
  assert.equal(parseWorldContext(stored({ view: { ...view, x: Number.NaN } }), who, NOW)!.view, null);
  assert.equal(parseWorldContext(stored({ view: { ...view, dist: -5 } }), who, NOW)!.view, null);
});

test('a department that no longer exists is neither selected nor returned to', () => {
  const c = parseWorldContext(stored({ from: `#/castles/${GONE}/warriors`, selected: GONE }), who, NOW)!;
  const r = reconcile(c, [DEPT]);
  assert.equal(r.selected, null);
  assert.equal(r.from, '#/kingdom', 'the city is always there');
  assert.deepEqual(r.view, view, 'the camera is still valid: it shows the city, not the department');
  const kept = reconcile(parseWorldContext(stored({ from: `#/castles/${DEPT}/warriors` }), who, NOW)!, [DEPT]);
  assert.deepEqual([kept.selected, kept.from], [DEPT, `#/castles/${DEPT}/warriors`]);
});

test('nothing but ids, a route and camera numbers is ever stored', () => {
  const keys = Object.keys(JSON.parse(stored()) as object).sort();
  assert.deepEqual(keys, ['at', 'from', 'member', 'mode', 'org', 'place', 'selected', 'v', 'view']);
});

test('a patch keeps what it does not mention and re-stamps the time', () => {
  const a = mergeWorldContext(null, who, { view, selected: DEPT, place: 'library', mode: '3d' }, NOW);
  const b = mergeWorldContext(a, who, { from: '#/kingdom' }, NOW + 5);
  assert.deepEqual([b.view, b.selected, b.place, b.from, b.at], [view, DEPT, 'library', '#/kingdom', NOW + 5]);
});

test('the link says where it leads', () => {
  assert.equal(returnLabel('#/kingdom', []), 'Вернуться в Содружество');
  assert.equal(returnLabel(`#/castles/${DEPT}/warriors`, [{ id: DEPT, name: 'Монтаж' }]), 'Вернуться в город отдела «Монтаж»');
  assert.equal(returnLabel(`#/castles/${DEPT}`, []), 'Вернуться в город отдела');
});
