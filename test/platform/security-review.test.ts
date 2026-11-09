import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { assertUnprivilegedConnection, createDatabase, withAdminTx, withTx, type Database } from '../../platform/db/pool.ts';
import { createDraft, publishDraft } from '../../platform/modules/lab.ts';
import { freshDatabase, fullDraft, world } from './support/db.ts';

/**
 * Regression tests for the independent security review of the foundation
 * (docs/audit/2026-11-09-security-review.md). Each test replays an attack that
 * succeeded before the fix.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let ideaId: string;
let reviewId: string;

const ctx = (p: { actor: { userId: string; orgId: string; membershipId: string } }) => ({
  userId: p.actor.userId,
  orgId: p.actor.orgId,
  membershipId: p.actor.membershipId,
});

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  const d = await createDraft(db, w.author.userId, fullDraft);
  ideaId = (await publishDraft(db, w.author.userId, d.id, { organization: 'acme' })).body.idea.id;
  await withAdminTx(db, (c) =>
    // Stage 'review' so each attack below reaches the policy layer it targets
    // rather than being stopped earlier by the Phase 2 stage guards.
    c.query(`UPDATE ideas SET maintainer_membership_id = $2, decision_owner_membership_id = $3, stage = 'review' WHERE id = $1`, [
      ideaId,
      w.maintainer.membershipId,
      w.decider.membershipId,
    ]),
  );
  reviewId = await withTx(db, ctx(w.maintainer), async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body)
       VALUES ($1, $2, 1, $3, 'request_changes', 'Уточните смены') RETURNING id`,
      [w.acmeId, ideaId, w.maintainer.membershipId],
    );
    await c.query(`UPDATE reviews SET state = 'resolved', resolved_by_membership_id = $2, resolved_at = now() WHERE id = $1`, [
      r.rows[0]!.id,
      w.maintainer.membershipId,
    ]);
    return r.rows[0]!.id;
  });
});
after(async () => drop());

test('#1 startup guard rejects privileged login roles', async () => {
  await assert.rejects(assertUnprivilegedConnection(db), /superuser/);
});

test('#1 an unprivileged login role cannot escape RLS with RESET ROLE', async () => {
  const admin = process.env.TEST_DATABASE_URL!;
  const role = `modus_api_t_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  const dbName = (await db.pool.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d;
  await db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' IN ROLE modus_app`);
  const url = new URL(admin);
  url.username = role;
  url.password = password;
  url.pathname = `/${dbName}`;
  const api = createDatabase(url.toString(), 2);
  try {
    await assertUnprivilegedConnection(api);
    const leaked = await withTx(api, ctx(w.author), async (c) => {
      await c.query('RESET ROLE');
      const ideas = await c.query('SELECT id FROM ideas WHERE organization_id = $1', [w.betaId]);
      await c.query(`SELECT set_config('app.user_id', '', true)`);
      const drafts = await c.query('SELECT 1 FROM lab_draft_versions');
      return ideas.rows.length + drafts.rows.length;
    });
    assert.equal(leaked, 0);
  } finally {
    await api.close();
    await db.pool.query(`DROP OWNED BY ${role}`);
    const root = new pg.Client({ connectionString: admin });
    await root.connect();
    await root.query(`DROP ROLE ${role}`);
    await root.end();
  }
});

test('#2 a membership id belonging to someone else cannot be borrowed', async () => {
  const borrowed = { userId: w.author.userId, orgId: w.acmeId, membershipId: w.maintainer.membershipId };
  await assert.rejects(
    withTx(db, borrowed, (c) =>
      c.query(`INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body)
               VALUES ($1, $2, 1, $3, 'approval', 'LGTM — Мария')`, [w.acmeId, ideaId, w.maintainer.membershipId]),
    ),
    { code: 'forbidden' },
  );
  const seen = await withTx(db, borrowed, async (c) => (await c.query('SELECT id FROM ideas')).rows.length);
  assert.equal(seen, 0);
});

test('#3 records cannot be inserted already confirmed, concluded or resolved', async () => {
  await assert.rejects(
    withTx(db, ctx(w.author), (c) =>
      c.query(`INSERT INTO contributions (organization_id, membership_id, idea_id, kind, source_type, source_id, status, confirmed_by_membership_id, confirmed_at)
               VALUES ($1, $2, $3, 'confirmed_impact', 'idea', $3, 'confirmed', $4, now())`,
        [w.acmeId, w.author.membershipId, ideaId, w.maintainer.membershipId]),
    ),
    { code: 'forbidden' },
  );
  await assert.rejects(
    withTx(db, ctx(w.maintainer), (c) =>
      c.query(`INSERT INTO verifications (organization_id, idea_id, revision_number, purpose, owner_membership_id, created_by_membership_id,
                 plan, success_criteria, status, outcome, conclusion, concluded_by_membership_id, started_at, completed_at)
               VALUES ($1, $2, 1, 'hypothesis', $3, $3, 'план', 'критерий', 'completed', 'positive', 'ok', $3, now(), now())`,
        [w.acmeId, ideaId, w.maintainer.membershipId]),
    ),
    { code: 'forbidden' },
  );
  await assert.rejects(
    withTx(db, ctx(w.colleague), (c) =>
      c.query(`INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body, state, resolved_by_membership_id, resolved_at)
               VALUES ($1, $2, 1, $3, 'request_changes', 'x', 'resolved', $3, now())`, [w.acmeId, ideaId, w.colleague.membershipId]),
    ),
    { code: 'forbidden' },
  );
});

test('#4 the author can neither assign themselves nor decide their own idea', async () => {
  await assert.rejects(
    withTx(db, ctx(w.author), (c) => c.query('UPDATE ideas SET decision_owner_membership_id = $2 WHERE id = $1', [ideaId, w.author.membershipId])),
    { code: 'validation_failed' },
  );
  await assert.rejects(
    withTx(db, ctx(w.author), (c) =>
      c.query(`INSERT INTO decisions (organization_id, idea_id, revision_number, decided_by_membership_id, outcome, rationale)
               VALUES ($1, $2, 1, $3, 'merge', 'Сам себе одобрил')`, [w.acmeId, ideaId, w.author.membershipId]),
    ),
    { code: 'forbidden' },
  );
  await assert.rejects(
    withTx(db, ctx(w.maintainer), (c) =>
      c.query(`INSERT INTO decisions (organization_id, idea_id, revision_number, decided_by_membership_id, outcome, rationale)
               VALUES ($1, $2, 1, $3, 'merge', 'Не назначен решающим')`, [w.acmeId, ideaId, w.maintainer.membershipId]),
    ),
    { code: 'forbidden' },
    'only the assigned decision owner decides',
  );
  await assert.rejects(
    withTx(db, ctx(w.maintainer), (c) => c.query('UPDATE ideas SET decision_owner_membership_id = $2 WHERE id = $1', [ideaId, w.colleague.membershipId])),
    { code: 'validation_failed' },
    'decision owner must hold the role',
  );
  await withTx(db, ctx(w.decider), (c) =>
    c.query(`INSERT INTO decisions (organization_id, idea_id, revision_number, decided_by_membership_id, outcome, rationale)
             VALUES ($1, $2, 1, $3, 'reject', 'Проверка допустимого пути')`, [w.acmeId, ideaId, w.decider.membershipId]),
  );
});

test('#4 the author cannot start verification or confirm contributions on their own idea', async () => {
  await assert.rejects(
    withTx(db, ctx(w.author), (c) =>
      c.query(`INSERT INTO verifications (organization_id, idea_id, revision_number, purpose, owner_membership_id, created_by_membership_id, plan, success_criteria)
               VALUES ($1, $2, 1, 'hypothesis', $3, $3, 'план', 'критерий')`, [w.acmeId, ideaId, w.author.membershipId]),
    ),
    { code: 'forbidden' },
  );
  // A legitimate review contribution of the maintainer (backed by their change request).
  const contrib = await withTx(db, ctx(w.maintainer), async (c) =>
    (await c.query<{ id: string }>(
      `INSERT INTO contributions (organization_id, membership_id, idea_id, kind, source_type, source_id)
       VALUES ($1, $2, $3, 'review', 'review', $4) RETURNING id`, [w.acmeId, w.maintainer.membershipId, ideaId, reviewId])).rows[0]!.id,
  );
  await assert.rejects(
    withTx(db, ctx(w.author), (c) =>
      c.query(`UPDATE contributions SET status = 'confirmed', confirmed_by_membership_id = $2, confirmed_at = now() WHERE id = $1`, [contrib, w.author.membershipId]),
    ),
    { code: 'forbidden' },
  );
});

test('#5 a resolved change request cannot be rewritten', async () => {
  await assert.rejects(
    withTx(db, ctx(w.author), (c) =>
      c.query(`UPDATE reviews SET state = 'withdrawn', resolution_note = 'переписано', resolved_by_membership_id = $2 WHERE id = $1`, [
        reviewId,
        w.author.membershipId,
      ]),
    ),
    (e: { code?: string }) => ['conflict', 'forbidden'].includes(e.code ?? ''),
  );
});

test('#6 versions cannot be squatted on another user\'s draft; foreign and missing ids look the same', async () => {
  const victim = await createDraft(db, w.maintainer.userId, { kind: 'idea', title: 'Черновик Марии', content: {} });
  const attempt = (draftId: string) =>
    withTx(db, { userId: w.author.userId }, (c) =>
      c.query(`INSERT INTO lab_draft_versions (draft_id, version, owner_user_id, title, content) VALUES ($1, 2, $2, 'захват', '{}')`, [
        draftId,
        w.author.userId,
      ]),
    );
  await assert.rejects(attempt(victim.id), { code: 'forbidden' });
  await assert.rejects(attempt('00000000-0000-4000-8000-000000000000'), { code: 'forbidden' });
});

test('#6 publication cannot be undone or relinked', async () => {
  const d = await createDraft(db, w.author.userId, fullDraft);
  await publishDraft(db, w.author.userId, d.id, { organization: 'acme' });
  await assert.rejects(
    withTx(db, { userId: w.author.userId }, (c) => c.query(`UPDATE lab_drafts SET state = 'private', published_idea_id = NULL, published_at = NULL WHERE id = $1`, [d.id])),
    { code: 'conflict' },
  );
  await assert.rejects(
    withTx(db, { userId: w.author.userId }, (c) => c.query('DELETE FROM lab_draft_versions WHERE draft_id = $1', [d.id])),
    { code: 'forbidden' },
  );
  const fresh = await createDraft(db, w.author.userId, fullDraft);
  const [foreign] = (await withAdminTx(db, (c) => c.query<{ id: string }>(`SELECT id FROM ideas WHERE author_membership_id <> $1 LIMIT 1`, [w.author.membershipId]))).rows;
  if (foreign) {
    await assert.rejects(
      withTx(db, { userId: w.author.userId }, (c) =>
        c.query(`UPDATE lab_drafts SET state = 'published', published_idea_id = $2, published_at = now() WHERE id = $1`, [fresh.id, foreign.id]),
      ),
      { code: 'forbidden' },
    );
  }
});

test('temporary tables are not available to the application role', async () => {
  await assert.rejects(
    withTx(db, ctx(w.author), (c) => c.query('CREATE TEMP TABLE memberships (id uuid)')),
    { code: 'forbidden' },
  );
});
