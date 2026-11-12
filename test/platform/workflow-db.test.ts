import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withAdminTx, withTx, type Database } from '../../platform/db/pool.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { freshDatabase, ownerQuery, world } from './support/db.ts';
import { ideaInReview, ideaInVerification, publishIdea } from './support/flow.ts';

/**
 * Phase 2 invariants enforced by PostgreSQL itself (migration 0002). Each test
 * bypasses the service and issues SQL as the application role, i.e. simulates
 * a buggy or compromised service layer.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
});
after(async () => drop());

type P = typeof w.author;
const sql = (p: P, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(text, params));
const ideaId = async (n: number) => (await ownerQuery<{ id: string }>(db, 'SELECT id FROM ideas WHERE number = $1', [n]))[0]!.id;
const rejected = (code: string | string[]) => (e: { code?: string }) => ([] as string[]).concat(code).includes(e.code ?? '');

test('stage: no skipping, no unauthorized movers, the author only hands back to review', async () => {
  const n = await ideaInReview(db, w);
  const id = await ideaId(n);
  await assert.rejects(sql(w.maintainer, `UPDATE ideas SET stage = 'impact_verification' WHERE id = $1`, [id]), rejected('validation_failed'));
  await assert.rejects(sql(w.colleague, `UPDATE ideas SET stage = 'closed' WHERE id = $1`, [id]), rejected(['forbidden', 'validation_failed']));
  await assert.rejects(sql(w.author, `UPDATE ideas SET stage = 'decision' WHERE id = $1`, [id]), rejected('forbidden'));
  await assert.rejects(sql(w.decider, `UPDATE ideas SET stage = 'verification' WHERE id = $1`, [id]), rejected('validation_failed'), 'needs a running verification');
  await assert.rejects(sql(w.decider, `UPDATE ideas SET stage = 'development' WHERE id = $1`, [id]), rejected('validation_failed'), 'needs an open change request');
});

test('stage: adoption needs a merge decision; closing needs a reject/close decision', async () => {
  const n = await ideaInReview(db, w);
  const id = await ideaId(n);
  await sql(w.decider, `UPDATE ideas SET stage = 'decision' WHERE id = $1`, [id]);
  await assert.rejects(sql(w.decider, `UPDATE ideas SET stage = 'adoption' WHERE id = $1`, [id]), rejected('validation_failed'));
  await assert.rejects(sql(w.decider, `UPDATE ideas SET stage = 'closed' WHERE id = $1`, [id]), rejected('validation_failed'));
});

test('assignment cannot be changed by the author or by plain members', async () => {
  const n = await publishIdea(db, w);
  const id = await ideaId(n);
  await assert.rejects(sql(w.author, 'UPDATE ideas SET maintainer_membership_id = $2 WHERE id = $1', [id, w.maintainer.membershipId]), rejected('forbidden'));
  await assert.rejects(sql(w.colleague, 'UPDATE ideas SET decision_owner_membership_id = $2 WHERE id = $1', [id, w.decider.membershipId]), rejected('forbidden'));
});

test('revisions: only the author writes author updates; suggestions never by the author', async () => {
  const n = await ideaInReview(db, w);
  const id = await ideaId(n);
  const insert = (p: P, origin: string, status: string) =>
    sql(p, `INSERT INTO idea_revisions (organization_id, idea_id, number, author_membership_id, origin, based_on_number, title, problem, proposal, rationale, status)
            VALUES ($1, $2, 2, $3, $4, 1, 'Переписано', 'проблема', 'предложение', 'причина', $5)`, [w.acmeId, id, p.membershipId, origin, status]);
  await assert.rejects(insert(w.maintainer, 'author_update', 'current'), rejected('forbidden'));
  await assert.rejects(insert(w.author, 'suggestion', 'proposed'), rejected('forbidden'));
  await assert.rejects(insert(w.colleague, 'suggestion', 'current'), rejected('forbidden'), 'a suggestion cannot enter as current');
  await assert.rejects(sql(w.maintainer, 'UPDATE ideas SET current_revision_number = 2 WHERE id = $1', [id]), rejected('forbidden'), 'only the author switches the current text');
});

test('revisions: accepting a suggestion is the author\'s act; history cannot be revived', async () => {
  const n = await ideaInReview(db, w);
  const s = await wf.suggest(db, w.colleague.actor, n, {
    baseRevision: 1,
    title: 'Версия коллеги',
    problem: 'Фуры ждут у рампы около двух часов каждое утро',
    proposal: 'Слоты разгрузки с резервным окном для опоздавших',
    rationale: 'Добавлено резервное окно',
  });
  const id = await ideaId(n);
  await assert.rejects(sql(w.maintainer, `UPDATE idea_revisions SET status = 'current' WHERE idea_id = $1 AND number = $2`, [id, s.body.revision]), rejected(['forbidden', 'validation_failed']));
  await wf.decideSuggestion(db, w.author.actor, n, s.body.revision, { accept: true });
  await assert.rejects(withAdminTx(db, (c) => c.query(`UPDATE idea_revisions SET status = 'current' WHERE idea_id = $1 AND number = 1`, [id])), rejected('conflict'), 'superseded is final, even for the owner');
});

test('reviews: authors cannot request changes on their own idea; objections only by the author', async () => {
  const n = await ideaInReview(db, w);
  const id = await ideaId(n);
  const review = (p: P, kind: string, parent: string | null = null) =>
    sql(p, `INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, parent_review_id, body)
            VALUES ($1, $2, 1, $3, $4, $5, 'текст') RETURNING id`, [w.acmeId, id, p.membershipId, kind, parent]);
  await assert.rejects(review(w.author, 'request_changes'), rejected('forbidden'));
  await assert.rejects(review(w.author, 'approval'), rejected('forbidden'));
  const cr = (await review(w.maintainer, 'request_changes')).rows[0]!.id as string;
  await assert.rejects(review(w.colleague, 'objection', cr), rejected('forbidden'));
  const comment = (await review(w.colleague, 'comment')).rows[0]!.id as string;
  await assert.rejects(review(w.author, 'objection', comment), rejected('forbidden'), 'objections answer change requests only');
  await review(w.author, 'objection', cr);
});

test('verification: no verdict without evidence, no evidence after the verdict — even for the owner', async () => {
  const { v } = await ideaInVerification(db, w);
  const conclude = (outcome: string) =>
    withAdminTx(db, (c) =>
      c.query(`UPDATE verifications SET status = 'completed', outcome = $2, conclusion = 'вывод без данных',
               concluded_by_membership_id = $3, completed_at = now() WHERE id = $1`, [v, outcome, w.maintainer.membershipId]));
  await assert.rejects(conclude('positive'), rejected('validation_failed'));
  await assert.rejects(conclude('negative'), rejected('validation_failed'));
  await conclude('inconclusive');
  await assert.rejects(
    withAdminTx(db, (c) => c.query(`INSERT INTO verification_evidence (organization_id, verification_id, kind, body, recorded_by_membership_id)
                                    VALUES ($1, $2, 'positive_observation', 'задним числом', $3)`, [w.acmeId, v, w.colleague.membershipId])),
    rejected('validation_failed'),
  );
  await assert.rejects(withAdminTx(db, (c) => c.query(`UPDATE verifications SET outcome = 'positive' WHERE id = $1`, [v])), rejected('conflict'));
});

test('decisions: snapshot is server-computed; one per idea; merge never over open change requests', async () => {
  const { n, v } = await ideaInVerification(db, w);
  const id = await ideaId(n);
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'negative_observation', body: 'Сбой записи в пятницу' });
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Ожидание 36 минут', metric: 'ожидание', value: 36, unit: 'мин' });
  await wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'positive', conclusion: 'Критерий достигнут, сбой записи нужно исправить' });

  const forged = JSON.stringify([{ outcome: 'positive', negativeObservations: 0 }]);
  const row = await sql(w.decider, `INSERT INTO decisions (organization_id, idea_id, revision_number, decided_by_membership_id, outcome, rationale, verification_summary)
                                    VALUES ($1, $2, 1, $3, 'merge', 'Внедряем с исправлением записи', $4) RETURNING verification_summary`,
    [w.acmeId, id, w.decider.membershipId, forged]);
  const summary = row.rows[0]!.verification_summary as { negativeObservations: number }[];
  assert.equal(Number(summary[0]!.negativeObservations), 1, 'the client cannot hide negative evidence from the decision record');

  await assert.rejects(
    withAdminTx(db, (c) => c.query(`INSERT INTO decisions (organization_id, idea_id, revision_number, decided_by_membership_id, outcome, rationale)
                                    VALUES ($1, $2, 1, $3, 'reject', 'Второе решение поверх первого')`, [w.acmeId, id, w.decider.membershipId])),
    rejected(['conflict', 'validation_failed']),
  );

  const n2 = await ideaInReview(db, w);
  const id2 = await ideaId(n2);
  await wf.addReview(db, w.maintainer.actor, n2, { kind: 'request_changes', body: 'Нет оценки рисков' });
  await assert.rejects(
    withAdminTx(db, (c) => c.query(`INSERT INTO decisions (organization_id, idea_id, revision_number, decided_by_membership_id, outcome, rationale)
                                    VALUES ($1, $2, 1, $3, 'merge', 'Владелец схемы пытается обойти')`, [w.acmeId, id2, w.decider.membershipId])),
    rejected('validation_failed'),
  );
});

test('guest scope holds at the database level', async () => {
  const { person } = await import('./support/db.ts');
  const guest = await person(db, w.acmeId, 'Гость SQL', ['maintainer'], 'Внешний', 'guest');
  const n = await publishIdea(db, w);
  const seen = await sql(guest, 'SELECT id FROM ideas');
  assert.equal(seen.rows.length, 0);
  const revs = await sql(guest, 'SELECT id FROM idea_revisions');
  assert.equal(revs.rows.length, 0);
  void n;
});

test('history timestamps follow write order under contention', async () => {
  const rows = await ownerQuery<{ d: string }>(
    db,
    `SELECT column_default AS d FROM information_schema.columns
      WHERE table_name IN ('reviews','verification_evidence','decisions','idea_revisions','audit_events') AND column_name = 'created_at'`,
  );
  assert.ok(rows.length === 5 && rows.every((r) => r.d.includes('clock_timestamp')));
});
