import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withAdminTx, withTx, type Database } from '../../platform/db/pool.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { listIdeas } from '../../platform/modules/ideas.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { ideaInReview, ideaInVerification, publishIdea, revisionText } from './support/flow.ts';

/**
 * Regression tests for the independent adversarial review of Phase 2
 * (docs/audit/2026-11-10-phase2-review.md). Numbers match the findings.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
});
after(async () => drop());

type P = { actor: { userId: string; orgId: string; membershipId: string }; membershipId: string };
const sql = (p: P, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(text, params));
const ideaId = async (n: number) => (await ownerQuery<{ id: string }>(db, 'SELECT id FROM ideas WHERE number = $1', [n]))[0]!.id;
const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');

test('#1 (hybrid, owner decision 2026-11-10) one head may lead and decide, but never verify alone', async () => {
  const both = await person(db, w.acmeId, 'Двойная Роль', ['employee', 'maintainer', 'decision_owner'], 'Склад');
  const n = await publishIdea(db, w);
  await wf.assign(db, both.actor, n, { maintainer: both.membershipId, decisionOwner: both.membershipId });
  const plan = { plan: 'Пилот две недели на рампе', successCriteria: 'Ожидание меньше 40 минут', owner: w.colleague.membershipId };
  await assert.rejects(wf.startVerification(db, both.actor, n, plan), codes('validation_failed'));
  await assert.rejects(
    sql(both, `INSERT INTO verifications (organization_id, idea_id, revision_number, purpose, owner_membership_id, created_by_membership_id, plan, success_criteria)
               VALUES ($1, $2, 1, 'hypothesis', $3, $4, 'план пилота', 'критерий успеха')`, [w.acmeId, await ideaId(n), w.colleague.membershipId, both.membershipId]),
    codes('forbidden'),
    'the database also refuses a one-person verification',
  );
  const d = await wf.decide(db, both.actor, n, { outcome: 'reject', rationale: 'Простое обращение: решено без пилота' });
  assert.equal(d.body.stage, 'closed');
});

test('#1 the decision owner neither runs nor owns the verification they judge', async () => {
  const n = await ideaInReview(db, w);
  await assert.rejects(
    wf.startVerification(db, w.decider.actor, n, { plan: 'Пилот две недели на рампе', successCriteria: 'Ожидание меньше 40 минут', owner: w.colleague.membershipId }),
    codes('forbidden'),
  );
  await assert.rejects(
    wf.startVerification(db, w.maintainer.actor, n, { plan: 'Пилот две недели на рампе', successCriteria: 'Ожидание меньше 40 минут', owner: w.decider.membershipId }),
    codes('validation_failed'),
  );
});

test('#2 the author is never the verification owner and never records evidence', async () => {
  const n = await ideaInReview(db, w);
  await assert.rejects(
    wf.startVerification(db, w.maintainer.actor, n, { plan: 'Пилот две недели на рампе', successCriteria: 'Ожидание меньше 40 минут', owner: w.author.membershipId }),
    codes('validation_failed'),
  );
  await assert.rejects(
    sql(w.maintainer, `INSERT INTO verifications (organization_id, idea_id, revision_number, purpose, owner_membership_id, created_by_membership_id, plan, success_criteria)
                       VALUES ($1, $2, 1, 'hypothesis', $3, $4, 'план пилота', 'критерий успеха')`, [w.acmeId, await ideaId(n), w.author.membershipId, w.maintainer.membershipId]),
    codes('forbidden'),
  );
  const { n: n2, v } = await ideaInVerification(db, w);
  await assert.rejects(wf.recordEvidence(db, w.author.actor, n2, v, { kind: 'positive_observation', body: 'Автор доволен' }), codes('forbidden'));
  await assert.rejects(
    sql(w.author, `INSERT INTO verification_evidence (organization_id, verification_id, kind, body, recorded_by_membership_id)
                   VALUES ($1, $2, 'positive_observation', 'Автор доволен', $3)`, [w.acmeId, v, w.author.membershipId]),
    codes('forbidden'),
  );
});

test('#3 contributions cannot be revoked, forged or claimed without a backing record', async () => {
  const { n, v } = await ideaInVerification(db, w);
  const id = await ideaId(n);
  await assert.rejects(sql(w.colleague, `UPDATE contributions SET status = 'revoked', revoked_reason = 'просто так убираю' WHERE idea_id = $1 AND kind = 'authorship'`, [id]), codes('conflict'));
  await assert.rejects(sql(w.author, `UPDATE contributions SET status = 'revoked', revoked_reason = 'убираю чужой вклад' WHERE idea_id = $1 AND kind = 'verification'`, [id]), codes('conflict'));
  await assert.rejects(
    sql(w.colleague, `INSERT INTO contributions (organization_id, membership_id, idea_id, kind, source_type, source_id)
                      VALUES ($1, $2, $3, 'confirmed_impact', 'idea', $3)`, [w.acmeId, w.colleague.membershipId, id]),
    codes('forbidden'),
  );
  await assert.rejects(
    sql(w.colleague, `INSERT INTO contributions (organization_id, membership_id, idea_id, kind, source_type, source_id)
                      VALUES ($1, $2, $3, 'negative_result', 'verification', $4)`, [w.acmeId, w.colleague.membershipId, id, v]),
    codes('forbidden'),
    'a negative_result needs a completed negative verdict',
  );
});

test('#3 a running verification cannot be rewritten or silently cancelled', async () => {
  const { n, v } = await ideaInVerification(db, w);
  await assert.rejects(sql(w.maintainer, `UPDATE verifications SET success_criteria = 'любое улучшение' WHERE id = $1`, [v]), codes('conflict'));
  await assert.rejects(sql(w.colleague, `UPDATE verifications SET owner_membership_id = $2 WHERE id = $1`, [v, w.maintainer.membershipId]), codes('conflict'));
  await assert.rejects(sql(w.author, `UPDATE verifications SET status = 'cancelled', conclusion = 'отменяю свою проверку' WHERE id = $1`, [v]), codes('forbidden'));
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'negative_observation', body: 'Сбой записи' });
  await assert.rejects(sql(w.maintainer, `UPDATE verifications SET status = 'cancelled', conclusion = 'отменяем пилот целиком' WHERE id = $1`, [v]), codes('validation_failed'),
    'evidence must end in a verdict, never in a cancellation');
});

test('#4 leaving verification requires a verdict on the current text', async () => {
  const { n } = await ideaInVerification(db, w);
  const id = await ideaId(n);
  await assert.rejects(sql(w.decider, `UPDATE ideas SET stage = 'decision' WHERE id = $1`, [id]), codes('validation_failed'));
  await assert.rejects(sql(w.decider, `UPDATE ideas SET stage = 'review' WHERE id = $1`, [id]), codes('validation_failed'));
  await assert.rejects(wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'В обход проверки' }), codes('conflict'));
});

test('#5 the text cannot be swapped after verification', async () => {
  const { n, v } = await ideaInVerification(db, w);
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Ожидание 30 минут', metric: 'ожидание', value: 30, unit: 'мин' });
  await wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'positive', conclusion: 'Критерий достигнут по замеру' });
  await assert.rejects(wf.revise(db, w.author.actor, n, { baseRevision: 1, ...revisionText }), codes('conflict'));
  const id = await ideaId(n);
  await assert.rejects(
    sql(w.author, `INSERT INTO idea_revisions (organization_id, idea_id, number, author_membership_id, origin, based_on_number, title, problem, proposal, status)
                   VALUES ($1, $2, 2, $3, 'author_update', 1, 'Подмена', 'другая проблема', 'другое предложение', 'current')`, [w.acmeId, id, w.author.membershipId]),
    codes('validation_failed'),
  );
  const lead = await person(db, w.acmeId, 'Посторонний Лид', ['employee', 'maintainer'], 'Склад');
  await assert.rejects(sql(lead, `UPDATE ideas SET stage = 'review' WHERE id = $1`, [id]), codes('forbidden'), 'only assigned leads move an idea');
});

test('#6 nobody but the author retires the current text; an idea always has one current text', async () => {
  const n = await ideaInReview(db, w);
  const id = await ideaId(n);
  await assert.rejects(sql(w.colleague, `UPDATE idea_revisions SET status = 'superseded' WHERE idea_id = $1 AND status = 'current'`, [id]), codes('forbidden'));
  await assert.rejects(sql(w.author, `UPDATE idea_revisions SET status = 'superseded' WHERE idea_id = $1 AND status = 'current'`, [id]), codes('validation_failed'),
    'even the author cannot leave the idea without a current text (checked at commit)');
});

test('#7 only the requester or the assigned maintainer closes a change request', async () => {
  const n = await ideaInReview(db, w);
  const cr = await wf.addReview(db, w.decider.actor, n, { kind: 'request_changes', body: 'Не хватает оценки рисков' });
  await assert.rejects(
    sql(w.colleague, `UPDATE reviews SET state = 'withdrawn', resolution_note = 'закрываю чужое', resolved_by_membership_id = $2, resolved_at = now() WHERE id = $1`, [cr.body.id, w.colleague.membershipId]),
    codes('forbidden'),
  );
  await wf.resolveReview(db, w.maintainer.actor, n, cr.body.id, { outcome: 'resolved', note: 'Риски описаны в версии 1' });
});

test('#8 database-level race: an uncommitted change request blocks a concurrent merge', async () => {
  const n = await ideaInReview(db, w);
  const id = await ideaId(n);
  const open = async (p: P) => {
    const c = await db.pool.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true), set_config('app.membership_id', $3, true)`,
      [p.actor.userId, p.actor.orgId, p.actor.membershipId]);
    await c.query('SET LOCAL ROLE modus_app');
    return c;
  };
  const t1 = await open(w.maintainer);
  const t2 = await open(w.decider);
  try {
    await t1.query(`INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body)
                    VALUES ($1, $2, 1, $3, 'request_changes', 'Срочный риск')`, [w.acmeId, id, w.maintainer.membershipId]);
    const merge = t2.query(`INSERT INTO decisions (organization_id, idea_id, revision_number, decided_by_membership_id, outcome, rationale)
                            VALUES ($1, $2, 1, $3, 'merge', 'Внедряем немедленно')`, [w.acmeId, id, w.decider.membershipId]);
    const blocked = merge.then(() => 'merged', (e: { message: string }) => e.message);
    await new Promise((r) => setTimeout(r, 150));
    await t1.query('COMMIT');
    assert.match(await blocked, /blocked by open change requests/);
  } finally {
    await t2.query('ROLLBACK').catch(() => {});
    t1.release();
    t2.release();
  }
});

test('#9 a suspended maintainer does not brick the idea; revision numbers cannot be squatted', async () => {
  const temp = await person(db, w.acmeId, 'Временный Ведущий', ['employee', 'maintainer'], 'Склад');
  const n = await publishIdea(db, w);
  await wf.assign(db, w.maintainer.actor, n, { maintainer: temp.membershipId, decisionOwner: w.decider.membershipId });
  await withAdminTx(db, (c) => c.query(`UPDATE memberships SET status = 'suspended' WHERE id = $1`, [temp.membershipId]));
  await wf.addReview(db, w.colleague.actor, n, { kind: 'comment', body: 'Идея по-прежнему работает' });
  await wf.revise(db, w.author.actor, n, { baseRevision: 1, ...revisionText });
  await wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId });

  await assert.rejects(
    sql(w.colleague, `INSERT INTO idea_revisions (organization_id, idea_id, number, author_membership_id, origin, based_on_number, title, problem, proposal, rationale, status)
                      VALUES ($1, $2, 2147483647, $3, 'suggestion', 2, 'Захват номера', 'проблема', 'предложение', 'причина', 'proposed')`, [w.acmeId, await ideaId(n), w.colleague.membershipId]),
    codes('validation_failed'),
  );
});

test('#10 guests see only people connected to their ideas and no organization counters', async () => {
  const guest = await person(db, w.acmeId, 'Гость Наблюдатель', ['decision_owner'], 'Внешний', 'guest');
  const hidden = await publishIdea(db, w, 'Скрытая от гостя');
  const n = await publishIdea(db, w, 'Для гостя');
  await wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId, decisionOwner: guest.membershipId });
  const people = (await sql(guest, 'SELECT display_name FROM employees ORDER BY display_name')).rows.map((r) => r.display_name);
  assert.deepEqual(people.sort(), ['Гость Наблюдатель', 'Кирилл Демо', 'Мария Ведущая'].sort());
  await assert.rejects(sql(guest, 'SELECT next_idea_number FROM organizations'), codes('forbidden'));
  await assert.rejects(
    sql(guest, `INSERT INTO notification_subscriptions (organization_id, membership_id, event_type, idea_id, enabled) VALUES ($1, $2, 'comment_added', $3, true)`,
      [w.acmeId, guest.membershipId, await ideaId(hidden)]),
    codes('forbidden'),
  );
  assert.deepEqual((await listIdeas(db, guest.actor)).map((i) => i.number), [n]);
});

test('#10 notifications cannot be written directly or spoofed', async () => {
  const n = await ideaInReview(db, w);
  const id = await ideaId(n);
  await assert.rejects(
    sql(w.colleague, `INSERT INTO notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
                      VALUES ($1, $2, $3, 'idea_merged', $4, 'spoof')`, [w.acmeId, w.author.membershipId, w.colleague.membershipId, id]),
    codes('forbidden'),
  );
  await assert.rejects(sql(w.colleague, `SELECT app_notify('idea_merged', $1, ARRAY[$2]::uuid[], 'spoof')`, [id, w.author.membershipId]), codes('forbidden'));
  const guest = await person(db, w.acmeId, 'Гость Владелец', ['maintainer'], 'Внешний', 'guest');
  await assert.rejects(
    wf.startVerification(db, w.maintainer.actor, n, { plan: 'Пилот две недели на рампе', successCriteria: 'Ожидание меньше 40 минут', owner: guest.membershipId }),
    codes('validation_failed'),
    'an unassigned guest cannot own a verification they cannot see',
  );
});

test('minor: the decision snapshot counts evidence by kind', async () => {
  const { n, v } = await ideaInVerification(db, w);
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Ожидание выросло до 90 минут', metric: 'ожидание', value: 90, unit: 'мин' });
  await wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'negative', conclusion: 'Гипотеза не подтвердилась замером' });
  const d = await wf.decide(db, w.decider.actor, n, { outcome: 'reject', rationale: 'Замер показал ухудшение' });
  const [s] = d.body.verificationSummary as { outcome: string; results: number; positiveObservations: number; negativeObservations: number }[];
  assert.deepEqual([s!.outcome, Number(s!.results), Number(s!.positiveObservations), Number(s!.negativeObservations)], ['negative', 1, 0, 0]);
});
