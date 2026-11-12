import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withAdminTx, withTx, type Database } from '../../platform/db/pool.ts';
import * as admin from '../../platform/modules/admin.ts';
import * as wf from '../../platform/modules/workflow.ts';
import * as progress from '../../platform/modules/progress.ts';
import { kingdom } from '../../platform/modules/kingdom.ts';
import { listInbox } from '../../platform/modules/notifications.ts';
import { levelFor, per10, thresholdsValid } from '../../platform/domain/progress.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * Castle progress (owner brief 2026-11-11, ADR-0012): XP only from confirmed
 * events, never twice; levels by configurable thresholds; rating of departments,
 * not people.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const sklad = async () => (await kingdom(db, w.colleague.actor)).castles.find((c) => c.id === f.departments.sklad)!;
const sql = (p: { actor: typeof w.author.actor }, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(text, params));

/** An idea of the warehouse, decided by its head (hybrid powers) and implemented by a colleague. */
async function implemented(title: string) {
  const n = (
    await submit(db, w.author, { kind: 'idea', title, proposal: 'Сделать это небольшим изменением процесса на складе', departmentId: f.departments.sklad })
  ).body.item.number;
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Полезно и недорого для склада', implementer: w.colleague.membershipId });
  const done = await wf.completeImplementation(db, f.head.actor, n, { report: 'Внедрено, работает с понедельника' });
  return { n, done };
}

test('levels: thresholds, names and progress (pure)', () => {
  const cfg = { thresholds: [0, 100, 250, 500, 900], names: ['Поселение', 'Крепость', 'Цитадель', 'Королевский замок', 'Легендарная крепость'] };
  assert.deepEqual([0, 99, 100, 249, 250, 899, 900, 5000].map((x) => levelFor(x, cfg).level), [1, 1, 2, 2, 3, 4, 5, 5]);
  assert.equal(levelFor(175, cfg).progress, 0.5);
  assert.equal(levelFor(175, cfg).nextName, 'Цитадель');
  assert.equal(levelFor(950, cfg).next, null);
  assert.ok(thresholdsValid([0, 1, 2, 3, 4]));
  assert.ok(!thresholdsValid([10, 100, 250, 500, 900]));
  assert.ok(!thresholdsValid([0, 100, 100, 500, 900]));
  assert.equal(per10(150, 20), 75);
  assert.equal(per10(150, null), null);
});

test('nothing is awarded for submitting, reviewing or rejecting', async () => {
  const n = (await submit(db, w.author, { title: 'Купить ещё один стеллаж', departmentId: f.departments.sklad })).body.item.number;
  await wf.addReview(db, f.head.actor, n, { kind: 'comment', body: 'Посмотрю бюджет' });
  await wf.decide(db, f.head.actor, n, { outcome: 'reject', rationale: 'Места под стеллаж нет, вернёмся весной' });
  const c = await sklad();
  assert.equal(c.xp, 0);
  assert.equal(c.level, 1);
  assert.equal(c.levelName, 'Поселение');
});

test('a confirmed implementation awards XP exactly once', async () => {
  const { n } = await implemented('Разметка зон приёмки');
  let c = await sklad();
  assert.equal(c.xp, 100);
  assert.equal(c.level, 2);
  await assert.rejects(wf.completeImplementation(db, f.head.actor, n, { report: 'Ещё раз отмечаю внедрение' }));
  await sql(f.head, 'UPDATE ideas SET stage = stage WHERE number = $1 AND organization_id = app_org_id()', [n]);
  c = await sklad();
  assert.equal(c.xp, 100, 're-saving or repeating a step does not award again');
  const rows = await ownerQuery<{ n: number }>(db, 'SELECT count(*)::int AS n FROM xp_awards a JOIN ideas i ON i.id = a.idea_id WHERE i.number = $1', [n]);
  assert.equal(rows[0]!.n, 1);
});

test('the application cannot write or change XP directly', async () => {
  await assert.rejects(
    sql(w.admin, `INSERT INTO xp_awards (organization_id, department_id, idea_id, kind, xp)
                  SELECT organization_id, department_id, id, 'effect', 500 FROM ideas WHERE organization_id = app_org_id() LIMIT 1`),
  );
  await assert.rejects(sql(w.admin, 'UPDATE xp_awards SET xp = 900'));
  await assert.rejects(ownerQuery(db, 'DELETE FROM xp_awards'));
});

test('effect bonus: only the decision owner, not an originator, within the maximum, once', async () => {
  const { n } = await implemented('Таблички над зонами');
  const before = (await sklad()).xp;
  const input = { xp: 50, rationale: 'Пересортов за месяц ноль против шести раньше, акт инвентаризации приложен' };
  await assert.rejects(progress.approveEffect(db, w.colleague.actor, n, input), codes('forbidden'));
  await assert.rejects(progress.approveEffect(db, w.author.actor, n, input), codes('forbidden'));
  await assert.rejects(progress.approveEffect(db, f.head.actor, n, { ...input, xp: 60 }), codes('validation_failed'));
  const r = await progress.approveEffect(db, f.head.actor, n, input);
  assert.equal(r.body.xp, 50);
  assert.equal((await sklad()).xp, before + 50);
  await assert.rejects(progress.approveEffect(db, f.head.actor, n, input), codes('conflict'));
  assert.equal((await sklad()).effectXp, 50);
});

test('the database itself refuses an effect bonus from someone else or before implementation', async () => {
  const open = (await submit(db, w.author, { title: 'Неудобный проход у рампы', departmentId: f.departments.sklad })).body.item.number;
  await assert.rejects(
    sql(f.head, `INSERT INTO effect_approvals (organization_id, idea_id, approved_by_membership_id, xp, rationale)
                 SELECT organization_id, id, $2, 10, 'Эффект подтверждён документом' FROM ideas WHERE number = $1 AND organization_id = app_org_id()`, [open, f.head.membershipId]),
  );
  const { n } = await implemented('Новые таблички на воротах');
  await assert.rejects(
    sql(w.maintainer, `INSERT INTO effect_approvals (organization_id, idea_id, approved_by_membership_id, xp, rationale)
                       SELECT organization_id, id, $2, 10, 'Эффект подтверждён документом' FROM ideas WHERE number = $1 AND organization_id = app_org_id()`, [n, w.maintainer.membershipId]),
  );
});

test('crossing a threshold is a level-up: recorded with the item, the author is told', async () => {
  // Склад now has 100 + 100 + 50 + 100 = 350 XP → Цитадель since 250.
  const c = await sklad();
  assert.equal(c.level, 3);
  assert.equal(c.levelName, 'Цитадель');
  const { n, done } = await implemented('Стол упаковки у ворот №2');
  assert.equal(done.body.levelUp, null, '450 XP is still a citadel');
  const { n: n2, done: done2 } = await implemented('Сканеры на зарядке у каждой зоны');
  assert.equal(done2.body.levelUp?.to, 4);
  assert.equal(done2.body.levelUp?.name, 'Королевский замок');
  const log = await ownerQuery<{ data: { idea: number; level: number } }>(db, `SELECT data FROM audit_events WHERE action = 'castle.level_up' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(log[0]!.data.idea, n2);
  assert.equal(log[0]!.data.level, 4);
  const inbox = (await listInbox(db, w.author.actor)).filter((x) => x.event === 'castle_level_up');
  assert.ok(inbox.some((x) => x.ideaNumber === n2));
  assert.ok(!inbox.some((x) => x.ideaNumber === n));
});

test('castle history names each item and its author; achievements carry dates', async () => {
  const c = await progress.castle(db, w.colleague.actor, f.departments.sklad);
  assert.equal(c.level, 4);
  assert.ok(c.history.length >= 6);
  assert.ok(c.history.every((h) => h.number > 0 && h.credited && h.title));
  const ups = c.history.filter((h) => h.levelUp).map((h) => h.levelUp!.level).sort();
  assert.deepEqual(ups, [2, 3, 4]);
  const got = Object.fromEntries(c.achievements.map((a) => [a.key, !!a.earnedAt]));
  assert.equal(got.first_stone, true);
  assert.equal(got.proven_effect, true);
  assert.equal(got.five, true);
  assert.equal(got.level_5, false);
});

test('rating: departments only, period and all time, normalized only with a known size', async () => {
  await admin.updateDepartment(db, w.admin.actor, f.departments.sklad, { headcount: 20 });
  let r = await progress.rating(db, w.author.actor, { period: 'all' });
  const s = r.rows.find((x) => x.departmentId === f.departments.sklad)!;
  const svc = r.rows.find((x) => x.departmentId === f.departments.service)!;
  assert.equal(s.rank, 1);
  assert.equal(s.xpTotal, 550);
  assert.equal(s.implementedTotal, 5);
  assert.equal(s.effectXpTotal, 50);
  assert.equal(s.xpPer10, 275);
  assert.equal(svc.xpPer10, null, 'no headcount, no normalized value');
  for (const row of r.rows) {
    assert.deepEqual(Object.keys(row).filter((k) => /author|member|person|user/i.test(k)), [], 'no personal fields');
  }
  // Move one award out of the last 30 days: it counts for all time only.
  await withAdminTx(db, async (c) => {
    await c.query('SET LOCAL session_replication_role = replica'); // test data only: the ledger is append-only
    await c.query(
      `UPDATE xp_awards SET created_at = created_at - interval '60 days'
        WHERE id = (SELECT id FROM xp_awards WHERE department_id = $1 AND kind = 'implementation' ORDER BY created_at LIMIT 1)`,
      [f.departments.sklad],
    );
  });
  r = await progress.rating(db, w.author.actor, { period: '30' });
  const s30 = r.rows.find((x) => x.departmentId === f.departments.sklad)!;
  assert.equal(s30.xpPeriod, 450);
  assert.equal(s30.xpTotal, 550);
  assert.equal(s30.implementedPeriod, 4);
});

test('thresholds and amounts are configuration: admins change them, levels follow', async () => {
  await assert.rejects(progress.updateProgressSettings(db, f.head.actor, { xpEffectMax: 80 }), codes('forbidden'));
  assert.equal(progress.ProgressSettingsInput.safeParse({ levelThresholds: [10, 100, 250, 500, 900] }).success, false);
  await progress.updateProgressSettings(db, w.admin.actor, { levelThresholds: [0, 100, 250, 500, 550] });
  assert.equal((await sklad()).level, 5);
  await progress.updateProgressSettings(db, w.admin.actor, { levelThresholds: [0, 100, 250, 500, 900] });
  assert.equal((await sklad()).level, 4);
});

test('guests see neither the rating nor castle history', async () => {
  const guest = await person(db, w.acmeId, 'Гость Рейтинга', ['maintainer'], 'Внешний', 'guest');
  await assert.rejects(progress.rating(db, guest.actor, { period: 'all' }), codes('forbidden'));
  await assert.rejects(progress.castle(db, guest.actor, f.departments.sklad), codes('forbidden'));
});
