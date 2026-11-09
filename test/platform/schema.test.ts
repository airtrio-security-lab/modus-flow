import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withAdminTx, withTx, type Database } from '../../platform/db/pool.ts';
import { createDraft, publishDraft } from '../../platform/modules/lab.ts';
import { freshDatabase, fullDraft, ownerQuery, world } from './support/db.ts';

/**
 * Database-level guarantees. These hold even if a future service has a bug,
 * because they are enforced by PostgreSQL (RLS, composite FKs, triggers, grants).
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let ideaId: string;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  const d = await createDraft(db, w.author.userId, fullDraft);
  const r = await publishDraft(db, w.author.userId, d.id, { organization: 'acme' });
  ideaId = r.body.idea.id;
});
after(async () => drop());

const as = (p: { actor: { userId: string; orgId: string; membershipId: string } }) => ({
  userId: p.actor.userId,
  orgId: p.actor.orgId,
  membershipId: p.actor.membershipId,
});

test('RLS: another tenant cannot see ideas, even by id', async () => {
  const outsiderCtx = as(w.outsider);
  const rows = await withTx(db, outsiderCtx, async (c) => (await c.query('SELECT id FROM ideas WHERE id = $1', [ideaId])).rows);
  assert.equal(rows.length, 0);
});

test('RLS: claiming a foreign org id without membership yields nothing', async () => {
  // Outsider forges app.org_id = acme; membership check in policy still denies.
  const forged = { userId: w.outsider.userId, orgId: w.acmeId, membershipId: w.outsider.membershipId };
  const rows = await withTx(db, forged, async (c) => (await c.query('SELECT id FROM ideas')).rows);
  assert.equal(rows.length, 0);
  const revs = await withTx(db, forged, async (c) => (await c.query('SELECT id FROM idea_revisions')).rows);
  assert.equal(revs.length, 0);
});

test('RLS: no identity bound → nothing visible', async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE modus_app');
    for (const t of ['ideas', 'lab_drafts', 'lab_draft_versions', 'memberships', 'users', 'audit_events']) {
      const { rows } = await client.query(`SELECT 1 FROM ${t}`);
      assert.equal(rows.length, 0, t);
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('RLS: private drafts are invisible to every other user, including org admins and maintainers', async () => {
  for (const p of [w.admin, w.maintainer, w.decider, w.colleague]) {
    const rows = await withTx(db, as(p), async (c) => (await c.query('SELECT draft_id, content FROM lab_draft_versions')).rows);
    assert.equal(rows.length, 0, p.actor.membershipId);
  }
});

test('RLS: cannot insert rows into another tenant', async () => {
  await assert.rejects(
    withTx(db, as(w.outsider), (c) =>
      c.query(`INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body)
               VALUES ($1, $2, 1, $3, 'comment', 'x')`, [w.acmeId, ideaId, w.outsider.membershipId]),
    ),
    (e: { code?: string }) => e.code === 'forbidden' || e.code === 'validation_failed',
  );
});

test('RLS: authorship cannot be forged (review in someone else\'s name)', async () => {
  await assert.rejects(
    withTx(db, as(w.colleague), (c) =>
      c.query(`INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body)
               VALUES ($1, $2, 1, $3, 'request_changes', 'подделка')`, [w.acmeId, ideaId, w.maintainer.membershipId]),
    ),
    { code: 'forbidden' },
  );
});

test('composite FKs: rows of different tenants can never be linked, even by the owner', async () => {
  await assert.rejects(
    withAdminTx(db, (c) =>
      c.query(`INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body)
               VALUES ($1, $2, 1, $3, 'comment', 'cross-tenant')`, [w.betaId, ideaId, w.outsider.membershipId]),
    ),
    { code: 'validation_failed' },
  );
});

test('append-only: audit events cannot be updated or deleted by anyone', async () => {
  await assert.rejects(withAdminTx(db, (c) => c.query(`UPDATE audit_events SET action = 'x.y'`)), { code: 'conflict' });
  await assert.rejects(withAdminTx(db, (c) => c.query('DELETE FROM audit_events')), { code: 'conflict' });
});

test('revisions: authored content is frozen, only status may change', async () => {
  await assert.rejects(
    withAdminTx(db, (c) => c.query(`UPDATE idea_revisions SET proposal = 'переписано руководителем' WHERE idea_id = $1`, [ideaId])),
    { code: 'conflict' },
  );
  await assert.rejects(withAdminTx(db, (c) => c.query('DELETE FROM idea_revisions WHERE idea_id = $1', [ideaId])), { code: 'conflict' });
  // As the app role, even a status-unrelated column is not grantable:
  await assert.rejects(
    withTx(db, as(w.maintainer), (c) => c.query(`UPDATE idea_revisions SET title = 'новое' WHERE idea_id = $1`, [ideaId])),
    { code: 'forbidden' },
  );
});

test('ideas cannot be deleted; author cannot be reassigned by the app role', async () => {
  await assert.rejects(withAdminTx(db, (c) => c.query('DELETE FROM ideas WHERE id = $1', [ideaId])), { code: 'conflict' });
  await assert.rejects(
    withTx(db, as(w.maintainer), (c) => c.query('UPDATE ideas SET author_membership_id = $2 WHERE id = $1', [ideaId, w.maintainer.membershipId])),
    { code: 'forbidden' },
  );
});

test('contributions: self-confirmation is rejected by the schema', async () => {
  const [row] = await ownerQuery<{ id: string }>(db, `SELECT id FROM contributions WHERE idea_id = $1 AND kind = 'authorship'`, [ideaId]);
  await assert.rejects(
    withTx(db, as(w.author), (c) =>
      c.query(`UPDATE contributions SET status = 'confirmed', confirmed_by_membership_id = $2, confirmed_at = now() WHERE id = $1`, [row!.id, w.author.membershipId]),
    ),
    { code: 'validation_failed' },
  );
});

test('verifications: completed requires outcome, conclusion and reviewer', async () => {
  await assert.rejects(
    withTx(db, as(w.maintainer), (c) =>
      c.query(`INSERT INTO verifications (organization_id, idea_id, revision_number, purpose, owner_membership_id, created_by_membership_id,
                 plan, success_criteria, status, started_at)
               VALUES ($1, $2, 1, 'hypothesis', $3, $3, 'план', 'критерий', 'completed', now())`, [w.acmeId, ideaId, w.maintainer.membershipId]),
    ),
    { code: 'validation_failed' },
  );
});
