import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as titles from '../../platform/modules/titles.ts';
import { listAudiences, requestAudience, acceptAudience } from '../../platform/modules/royal-audience.ts';
import { freshDatabase, ownerQuery, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * Real PostgreSQL regression for the envoy shortcut.
 * Audience acceptance is ceremonial: it cannot change business decisions, permissions or XP.
 * Tests use fictional people only and an isolated database.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let number: number;
let audienceId = '';
const codes = (...values: string[]) => (error: { code?: string }) => values.includes(error.code ?? '');

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  await titles.assignTitle(db, w.admin.actor, w.decider.membershipId, { rank: 'king' });
  const submitted = await submit(db, w.author, {
    title: 'Согласовать новый порядок учёта склада',
    categoryId: f.categories.it,
    departmentId: f.departments.sklad,
  });
  number = submitted.body.item.number;
});
after(async () => drop());

test('only the originator can request the royal audience; exactly one envoy per idea', async () => {
  const initial = await listAudiences(db, w.author.actor);
  assert.equal(initial.items.length, 0);
  assert.equal(initial.king?.membershipId, w.decider.membershipId);

  await assert.rejects(requestAudience(db, w.colleague.actor, number), codes('forbidden'));
  const first = await requestAudience(db, w.author.actor, number);
  audienceId = first.id;
  assert.equal(first.accepted, false);
  assert.equal(first.replayed, false);

  const replay = await requestAudience(db, w.author.actor, number);
  assert.equal(replay.id, first.id);
  assert.equal(replay.replayed, true);

  const rows = await ownerQuery<{ n: number }>(
    db, 'SELECT count(*)::int AS n FROM royal_audiences WHERE organization_id = $1', [w.acmeId],
  );
  assert.equal(rows[0]?.n, 1);
});

test('no guest, other organization or another employee can read or accept the envoy', async () => {
  assert.deepEqual((await listAudiences(db, w.outsider.actor)).items, []);
  await assert.rejects(requestAudience(db, w.outsider.actor, number), codes('not_found'));
  await assert.rejects(acceptAudience(db, w.colleague.actor, audienceId), codes('not_found'));
  await assert.rejects(acceptAudience(db, w.author.actor, audienceId), codes('not_found'));
  const authorUpdate = await withTx(db, {
    userId: w.author.userId,
    orgId: w.acmeId,
    membershipId: w.author.membershipId,
  }, c => c.query('UPDATE royal_audiences SET accepted_at = clock_timestamp(), accepted_by_membership_id = $2 WHERE id = $1', [audienceId, w.author.membershipId]));
  assert.equal(authorUpdate.rowCount, 0, 'RLS must reject acceptance directly in SQL');
});

test('king accepts once; sender can replay the faceless audience scene, with zero XP and decisions', async () => {
  const pending = (await listAudiences(db, w.decider.actor)).items.find(x => x.id === audienceId);
  assert.equal(pending?.role, 'king');
  assert.equal(pending?.status, 'requested');
  const first = await acceptAudience(db, w.decider.actor, audienceId);
  assert.equal(first.replayed, false);
  const second = await acceptAudience(db, w.decider.actor, audienceId);
  assert.equal(second.replayed, true);
  assert.equal(second.acceptedAt, first.acceptedAt);

  const sender = (await listAudiences(db, w.author.actor)).items.find(x => x.id === audienceId);
  assert.equal(sender?.status, 'accepted');
  assert.ok(sender?.acceptedAt);
  const king = (await listAudiences(db, w.decider.actor)).items.find(x => x.id === audienceId);
  assert.equal(king?.canDecide, true, 'decision link appears only for the actual decision owner');

  const sideEffects = await ownerQuery<{ decisions: number; xp: number; meetings: number }>(
    db, `SELECT
      (SELECT count(*)::int FROM decisions WHERE organization_id = $1) AS decisions,
      (SELECT count(*)::int FROM xp_awards WHERE organization_id = $1) AS xp,
      (SELECT count(*)::int FROM meetings WHERE organization_id = $1) AS meetings`,
    [w.acmeId],
  );
  assert.deepEqual(sideEffects[0], { decisions: 0, xp: 0, meetings: 0 });
});

test('king is a title, not authority: another appointed king cannot decide merely because of a crown', async () => {
  await titles.assignTitle(db, w.admin.actor, f.escalation.membershipId, { rank: 'king' });
  const newKingView = await listAudiences(db, f.escalation.actor);
  assert.equal(newKingView.king?.membershipId, f.escalation.membershipId);
  assert.equal(newKingView.items.length, 0, 'earlier audience belongs to its original recipient');
  const oldKing = (await listAudiences(db, w.decider.actor)).items.find(x => x.id === audienceId);
  assert.equal(oldKing?.canDecide, false);
  assert.equal(oldKing?.canConvene, false);
  assert.equal(oldKing?.canReview, false);
  // Accepted twice before title change is still read-only; no new acceptance.
});
