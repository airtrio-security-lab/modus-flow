import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../platform/db/pool.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { getIdea } from '../../platform/modules/ideas.ts';
import { freshDatabase, ownerQuery, world } from './support/db.ts';
import { ideaInReview, ideaInVerification, revisionText } from './support/flow.ts';

/**
 * Concurrency: history must never lose data, and racing workflow steps must
 * never produce a state the rules forbid. Each test fires real parallel
 * transactions at PostgreSQL.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
});
after(async () => drop());

const settled = async <T>(ps: Promise<T>[]) => {
  const r = await Promise.allSettled(ps);
  return {
    ok: r.filter((x) => x.status === 'fulfilled').length,
    codes: r.filter((x): x is PromiseRejectedResult => x.status === 'rejected').map((x) => (x.reason as { code?: string }).code),
  };
};

test('regression (prototype lost update): 20 parallel comments → 20 stored', async () => {
  const n = await ideaInReview(db, w);
  const people = [w.author, w.colleague, w.maintainer, w.decider, w.admin];
  const r = await settled(
    Array.from({ length: 20 }, (_, i) => wf.addReview(db, people[i % people.length]!.actor, n, { kind: 'comment', body: `Комментарий ${i}` })),
  );
  assert.equal(r.ok, 20);
  const full = await getIdea(db, w.author.actor, n);
  assert.equal(full.reviews.length, 20);
  assert.deepEqual(new Set(full.reviews.map((x: { body: string }) => x.body)).size, 20);
});

test('5 parallel revisions on the same base → exactly one wins, the rest get 409', async () => {
  const n = await ideaInReview(db, w);
  const r = await settled(
    Array.from({ length: 5 }, (_, i) => wf.revise(db, w.author.actor, n, { baseRevision: 1, ...revisionText, title: `Вариант ${i}` })),
  );
  assert.equal(r.ok, 1);
  assert.deepEqual(r.codes, ['conflict', 'conflict', 'conflict', 'conflict']);
  const full = await getIdea(db, w.author.actor, n);
  assert.equal(full.revisions.length, 2);
  assert.equal(full.revisions.filter((x: { status: string }) => x.status === 'current').length, 1);
});

test('parallel decisions → exactly one decision is recorded', async () => {
  const n = await ideaInReview(db, w);
  const r = await settled([
    wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Параллельное решение А' }),
    wf.decide(db, w.decider.actor, n, { outcome: 'reject', rationale: 'Параллельное решение Б' }),
    wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Параллельное решение В' }),
    wf.decide(db, w.decider.actor, n, { outcome: 'close', rationale: 'Параллельное решение Г' }),
  ]);
  assert.equal(r.ok, 1);
  const rows = await ownerQuery(db, 'SELECT d.id FROM decisions d JOIN ideas i ON i.id = d.idea_id WHERE i.number = $1', [n]);
  assert.equal(rows.length, 1);
});

test('change request racing a merge: never merged over an open change request', async () => {
  for (let round = 0; round < 5; round++) {
    const n = await ideaInReview(db, w);
    const r = await settled<unknown>([
      wf.addReview(db, w.maintainer.actor, n, { kind: 'request_changes', body: 'Срочно: риск для безопасности' }),
      wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Внедряем без ожидания' }),
    ]);
    const [state] = await ownerQuery<{ merged: boolean; open_cr: boolean }>(
      db,
      `SELECT EXISTS (SELECT 1 FROM decisions d WHERE d.idea_id = i.id AND d.outcome = 'merge') AS merged,
              EXISTS (SELECT 1 FROM reviews v WHERE v.idea_id = i.id AND v.kind = 'request_changes' AND v.state = 'open'
                        AND v.created_at < (SELECT min(created_at) FROM decisions WHERE idea_id = i.id)) AS open_cr
         FROM ideas i WHERE i.number = $1`,
      [n],
    );
    assert.equal(r.ok, 1, `round ${round}: exactly one of the two may succeed`);
    assert.equal(state!.merged && state!.open_cr, false, `round ${round}`);
  }
});

test('evidence racing the conclusion: nothing is attached after the verdict', async () => {
  const { n, v } = await ideaInVerification(db, w);
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Базовый результат', metric: 'ожидание', value: 35, unit: 'мин' });
  const r = await settled<unknown>([
    wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'positive', conclusion: 'Критерий достигнут на первой неделе' }),
    ...Array.from({ length: 6 }, (_, i) => wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'negative_observation', body: `Сбой ${i}` })),
  ]);
  assert.ok(r.codes.every((c) => c === 'conflict'), `only "too late" conflicts expected, got ${r.codes.join(',')}`);
  const late = await ownerQuery(
    db,
    `SELECT 1 FROM verification_evidence e JOIN verifications v ON v.id = e.verification_id
      WHERE v.id = $1 AND e.created_at > v.completed_at`,
    [v],
  );
  assert.equal(late.length, 0);
  const [summary] = await ownerQuery<{ outcome: string }>(db, 'SELECT outcome FROM verifications WHERE id = $1', [v]);
  assert.equal(summary!.outcome, 'positive');
});

test('parallel conclusions → one verdict, never overwritten', async () => {
  const { n, v } = await ideaInVerification(db, w);
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Итог замера', metric: 'ожидание', value: 52, unit: 'мин' });
  const r = await settled([
    wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'positive', conclusion: 'Считаю успехом: заметное снижение' }),
    wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'negative', conclusion: 'Критерий 40 минут не достигнут' }),
  ]);
  assert.equal(r.ok, 1);
  assert.deepEqual(r.codes, ['conflict']);
});

test('the same idempotency key in parallel → one effect, identical responses', async () => {
  const n = await ideaInReview(db, w);
  const input = { kind: 'approval' as const, body: 'Поддерживаю' };
  const results = await Promise.all(Array.from({ length: 6 }, () => wf.addReview(db, w.colleague.actor, n, input, 'same-key-parallel-01')));
  assert.equal(new Set(results.map((x) => x.body.id)).size, 1);
  assert.equal(results.filter((x) => !x.replayed).length, 1);
  const rows = await ownerQuery(db, `SELECT 1 FROM reviews v JOIN ideas i ON i.id = v.idea_id WHERE i.number = $1 AND v.kind = 'approval'`, [n]);
  assert.equal(rows.length, 1);
});
