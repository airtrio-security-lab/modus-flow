import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CIV_STYLES, ENVOY_RANK_NAMES, MAP_MOTION_BUDGET, OUTFIT_CIVS, envoyMotion, outfit, outfitSignature } from '../../web/src/lib/envoy-outfits.ts';
import { CIVILIZATION_IDS } from '../../platform/domain/civilizations.ts';
import { ENVOY_RANKS } from '../../platform/domain/envoy.ts';

/**
 * «Путь Посла» (ADR-0032): attire as data, checked without a browser. Every civilization of the registry
 * has its own attire for all seven ranks; every next rank adds new pieces, not only a colour.
 */
test('every civilization of the registry has attire, and only those (no Rome made up for the feature)', () => {
  assert.deepEqual([...OUTFIT_CIVS].sort(), [...CIVILIZATION_IDS].sort());
  assert.equal(ENVOY_RANKS.length, 7);
  assert.deepEqual([...ENVOY_RANK_NAMES], ENVOY_RANKS.map((r) => r.name), 'the web mirrors the server rank names');
});

test('all seven ranks look different in every civilization; each next rank adds a piece', () => {
  for (const civ of OUTFIT_CIVS) {
    const looks = ENVOY_RANKS.map((r) => outfit(civ, r.rank));
    assert.equal(new Set(looks.map(outfitSignature)).size, 7, `${civ}: seven distinct outfits`);
    for (let i = 1; i < 7; i++) {
      const added = looks[i]!.pieces.filter((p) => !looks[i - 1]!.pieces.includes(p));
      const changed = looks[i]!.cloak !== looks[i - 1]!.cloak;
      assert.ok(added.length > 0 && changed, `${civ}: rank ${i + 1} adds pieces and a new cloak, not only a colour`);
    }
    assert.deepEqual(looks.map((o) => o.mapTier), ['simple', 'simple', 'insignia', 'insignia', 'ceremonial', 'ceremonial', 'commonwealth']);
    assert.ok(looks[6]!.pieces.includes('commonwealth-ring'), 'rank VII carries the symbol of the Great Commonwealth');
    assert.ok(!looks[0]!.pieces.includes('crest') && !looks[0]!.pieces.includes('chain'), 'rank I is a plain traveller');
  }
});

test('the same rank differs between civilizations by the garment and the headwear, not by a palette', () => {
  for (let rank = 1; rank <= 7; rank++) {
    const garments = new Set(OUTFIT_CIVS.map((c) => CIV_STYLES[c].garment[outfit(c, rank).garment]));
    const hats = new Set(OUTFIT_CIVS.map((c) => CIV_STYLES[c].headwear[outfit(c, rank).headwear]));
    assert.equal(garments.size, OUTFIT_CIVS.length, `rank ${rank}: every civilization has its own garment`);
    assert.equal(hats.size, OUTFIT_CIVS.length, `rank ${rank}: and its own headwear`);
  }
});

test('an unknown style falls back to Камелот; the rank is clamped to I..VII', () => {
  assert.equal(outfit('rome', 3).civ, 'camelot');
  assert.equal(outfit('japan', 99).rank, 7);
  assert.equal(outfit('japan', 0).rank, 1);
});

test('map states come only from server facts: «принят» only after a recorded answer', () => {
  const e = (x: Partial<Parameters<typeof envoyMotion>[0]>) => envoyMotion({ status: 'in_review', responded: false, overdueFirstResponse: false, deferredUntil: null, ...x });
  assert.equal(e({ status: 'unrouted' }), 'travel');
  assert.equal(e({}), 'travel', 'no answer yet — on the road, not «received»');
  assert.equal(e({ responded: true }), 'received');
  assert.equal(e({ responded: true, status: 'in_verification' }), 'received');
  assert.equal(e({ responded: true, status: 'in_progress' }), 'received');
  assert.equal(e({ overdueFirstResponse: true }), 'waiting');
  assert.equal(e({ responded: true, status: 'decision' }), 'waiting', 'the decision is awaited, not taken');
  assert.equal(e({ responded: true, deferredUntil: '2026-12-01' }), 'waiting');
  assert.equal(e({ status: 'needs_info', responded: true }), 'waiting');
  assert.ok(MAP_MOTION_BUDGET <= 10, 'never dozens of walking envoys at once');
});
