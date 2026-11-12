import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as admin from '../../platform/modules/admin.ts';
import * as wf from '../../platform/modules/workflow.ts';
import * as pc from '../../platform/modules/project-context.ts';
import * as progress from '../../platform/modules/progress.ts';
import * as legacy from '../../platform/modules/legacy.ts';
import * as council from '../../platform/modules/council.ts';
import { getIdea } from '../../platform/modules/ideas.ts';
import { saveMyProfile } from '../../platform/modules/advisor.ts';
import { createDraft, publishDraft } from '../../platform/modules/lab.ts';
import { freshDatabase, fullDraft, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * Product refinement (ADR-0031): where the problem arose, other departments it touches, a measured
 * effect on the existing evidence, the way into the Library. Every rule that existed before stays.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let pnr: string; // «Пусконаладка» — an affected department with a head
let pnrHead: Awaited<ReturnType<typeof person>>;
let engineer: Awaited<ReturnType<typeof person>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  pnrHead = await person(db, w.acmeId, 'Руслан Наладчик', ['employee'], 'Пусконаладка');
  engineer = await person(db, w.acmeId, 'Дина Инженер', ['employee'], 'Пусконаладка');
  pnr = (await admin.createDepartment(db, w.admin.actor, { name: 'Пусконаладка', head: pnrHead.membershipId })).id;
  await saveMyProfile(db, engineer.actor, { skills: ['Сканеры', 'Контрольные списки'], weeklyHours: 4 });
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: { actor: typeof w.author.actor }, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(text, params));
const count = async (table: string, n: number) =>
  (await ownerQuery<{ c: number }>(db, `SELECT count(*)::int AS c FROM ${table} t JOIN ideas i ON i.id = t.idea_id WHERE i.number = $1`, [n]))[0]!.c;
/** An IT item: led by the maintainer, decided by the decision owner (routing rule of the fixture). */
const itItem = async (title: string, extra: Record<string, unknown> = {}) =>
  (
    await submit(db, w.author, {
      kind: 'idea',
      title,
      proposal: 'Ввести контрольный список подготовки оборудования к сдаче',
      successCriteria: 'Время подготовки к сдаче меньше 80 минут',
      categoryId: f.categories.it,
      ...extra,
    })
  ).body.item.number;

test('an ordinary item without any context is filed exactly as before', async () => {
  const n = (await submit(db, w.author, { title: 'Обычное обращение без проекта', departmentId: f.departments.sklad })).body.item.number;
  const item = await getIdea(db, w.author.actor, n);
  assert.deepEqual(item.context, { project: null, workStage: null, workStageName: null, setBy: null, setAt: null, affected: [] });
  assert.deepEqual([item.effect.measured, item.effect.lines, item.effect.approval], [false, [], null]);
  assert.equal(await count('idea_contexts', n), 0);
});

test('the context is saved with the item and shown; the responsible department stays apart from the affected ones', async () => {
  const key = 'ctx-submit-1';
  const input = {
    kind: 'problem' as const,
    title: 'Повторяющиеся ошибки при подготовке оборудования к сдаче',
    departmentId: f.departments.sklad,
    context: { project: 'Объект «Северный» (учебный пример)', workStage: 'commissioning' as const, affectedDepartmentIds: [pnr, f.departments.service] },
  };
  const first = await submit(db, w.author, input, key);
  const again = await submit(db, w.author, input, key);
  assert.deepEqual(again.body, first.body, 'a repeated request with the same key creates nothing new');
  const n = first.body.item.number;
  assert.deepEqual([await count('idea_contexts', n), await count('idea_affected_departments', n)], [1, 2]);
  const item = await getIdea(db, w.colleague.actor, n);
  assert.deepEqual([item.context.project, item.context.workStage, item.context.workStageName, item.context.setBy], ['Объект «Северный» (учебный пример)', 'commissioning', 'Пусконаладка', 'Кирилл Демо']);
  assert.deepEqual(item.context.affected.map((a) => a.name).sort(), ['Пусконаладка', 'Сервис']);
  assert.equal((item as unknown as { department: string }).department, 'Склад', 'the routing department is untouched');
  // The responsible department cannot be listed as «affected», in the service and in the database.
  await assert.rejects(pc.addAffected(db, w.author.actor, n, { departmentId: f.departments.sklad }), codes('validation_failed'));
  await assert.rejects(
    asUser(w.author, `INSERT INTO idea_affected_departments (organization_id, idea_id, department_id, added_by_membership_id) SELECT $1, id, $2, $3 FROM ideas WHERE number = $4`, [w.acmeId, f.departments.sklad, w.author.membershipId, n]),
    codes('validation_failed', 'conflict', 'forbidden'),
  );
  // Written once, append-only: no second context, no edits, no deletes.
  await assert.rejects(pc.setContext(db, w.author.actor, n, { workStage: 'operation' }), codes('conflict'));
  await assert.rejects(asUser(w.author, `UPDATE idea_contexts SET work_stage = 'design' WHERE idea_id = (SELECT id FROM ideas WHERE number = $1)`, [n]));
  await assert.rejects(asUser(f.head, `DELETE FROM idea_affected_departments WHERE idea_id = (SELECT id FROM ideas WHERE number = $1)`, [n]));
  // Adding the same department twice is harmless and adds no row.
  const before = await count('idea_affected_departments', n);
  assert.equal((await pc.addAffected(db, f.head.actor, n, { departmentId: pnr })).status, 200);
  assert.equal(await count('idea_affected_departments', n), before);
  // The audit log keeps the fact, not the project name.
  const log = await ownerQuery<{ data: Record<string, unknown> }>(db, `SELECT a.data FROM audit_events a JOIN ideas i ON i.id = a.entity_id WHERE i.number = $1 AND a.action = 'idea.context_set'`, [n]);
  assert.deepEqual(log[0]!.data, { project: true, workStage: 'commissioning', affected: 2 });
});

test('only the people of the item write its context; another organization sees and writes nothing', async () => {
  const n = await itItem('Контекст и права');
  await assert.rejects(pc.setContext(db, w.colleague.actor, n, { workStage: 'installation' }), codes('forbidden'));
  await assert.rejects(pc.addAffected(db, w.colleague.actor, n, { departmentId: pnr }), codes('forbidden'));
  await assert.rejects(
    asUser(w.colleague, `INSERT INTO idea_contexts (idea_id, organization_id, work_stage, created_by_membership_id) SELECT id, $1, 'design', $2 FROM ideas WHERE number = $3`, [w.acmeId, w.colleague.membershipId, n]),
    /row-level security|политик/,
  );
  await assert.rejects(pc.setContext(db, w.outsider.actor, n, { workStage: 'installation' }), codes('not_found'));
  // The lead may add it; then the other tenant still reads no row of either table.
  await pc.setContext(db, w.maintainer.actor, n, { project: 'Линия розлива (учебный пример)', workStage: 'installation', affectedDepartmentIds: [pnr] });
  assert.equal((await asUser(w.outsider, 'SELECT 1 FROM idea_contexts')).rowCount, 0);
  assert.equal((await asUser(w.outsider, 'SELECT 1 FROM idea_affected_departments')).rowCount, 0);
  assert.equal((await asUser(w.author, 'SELECT 1 FROM idea_contexts WHERE idea_id = (SELECT id FROM ideas WHERE number = $1)', [n])).rowCount, 1);
  await assert.rejects(pc.suggestSpecialists(db, w.outsider.actor, n), codes('not_found'));
});

test('an idea from the Warrior Hall gets its context after publication; private notes stay private', async () => {
  const d = await createDraft(db, w.author.userId, { ...fullDraft, title: 'Чек-лист перед сдачей объекта' });
  const n = (await publishDraft(db, w.author.userId, d.id, { organization: 'acme' })).body.idea.number;
  await pc.setContext(db, w.author.actor, n, { workStage: 'commissioning', affectedDepartmentIds: [pnr] });
  const item = await getIdea(db, w.colleague.actor, n);
  assert.equal(item.context.workStageName, 'Пусконаладка');
  const draft = await legacy.draftFromItem(db, w.colleague.actor, n);
  for (const view of [item, draft, await council.getCouncil(db, w.colleague.actor, n), await pc.suggestSpecialists(db, w.colleague.actor, n)]) {
    assert.ok(!JSON.stringify(view).includes('ЛИЧНОЕ'), 'nothing private of the draft reaches the item, the council, the suggestion or the knowledge draft');
  }
});

test('a suggestion of whom to invite: heads for everybody, matching skills for the lead only, nobody invited by it', async () => {
  const n = await itItem('Сканеры и контрольные списки при пусконаладке', { context: { workStage: 'commissioning', affectedDepartmentIds: [pnr] } });
  const forAuthor = await pc.suggestSpecialists(db, w.author.actor, n);
  assert.deepEqual([forAuthor.method, forAuthor.heads.map((h) => h.name), forAuthor.specialists, forAuthor.canSeeSkills], ['rules', ['Руслан Наладчик'], [], false]);
  const forLead = await pc.suggestSpecialists(db, w.maintainer.actor, n);
  assert.deepEqual(forLead.specialists.map((s) => [s.name, s.matched.sort()]), [['Дина Инженер', ['Контрольные списки', 'Сканеры']]]);
  assert.equal((await ownerQuery<{ c: number }>(db, 'SELECT count(*)::int AS c FROM meetings'))[0]!.c, 0, 'the suggestion creates no meeting');
  assert.equal((await ownerQuery<{ c: number }>(db, `SELECT count(*)::int AS c FROM notifications WHERE recipient_membership_id = $1`, [engineer.membershipId]))[0]!.c, 0, 'and notifies nobody');
  const none = await pc.suggestSpecialists(db, w.maintainer.actor, await itItem('Без затронутых подразделений'));
  assert.deepEqual([none.heads, none.specialists], [[], []]);
});

test('the effect: not measured without a pair, no false savings from incomparable numbers, measured from a comparable pair', async () => {
  const n = await itItem('Сокращение времени пусконаладки оборудования (учебный пример)');
  const start = { plan: 'Три сдачи с контрольным списком, замер времени подготовки', successCriteria: 'Подготовка к сдаче быстрее 80 минут', owner: w.colleague.membershipId };
  const v = (await wf.startVerification(db, w.maintainer.actor, n, start)).body.id;
  const effect = async () => (await getIdea(db, w.author.actor, n)).effect;
  assert.deepEqual([(await effect()).measured, (await effect()).lines], [false, []]);
  // «Before»: what, value, unit, period, source, and which direction is the improvement.
  await wf.recordEvidence(db, w.colleague.actor, n, v, {
    kind: 'baseline', body: 'Среднее по трём сдачам до изменения', metric: 'Время подготовки к сдаче', value: 96, unit: 'мин',
    period: 'три сдачи в октябре', source: 'журнал пусконаладки', goal: 'decrease',
  });
  let e = await effect();
  assert.deepEqual([e.measured, e.lines[0]!.state, e.lines[0]!.reason, e.lines[0]!.delta, e.lines[0]!.before!.period, e.lines[0]!.before!.source], [false, 'not_measured', 'no_result', null, 'три сдачи в октябре', 'журнал пусконаладки']);
  // A result in other units or without the statement that conditions match gives no number.
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Замер в часах', metric: 'Время подготовки к сдаче', value: 1.2, unit: 'ч', comparable: true });
  e = await effect();
  assert.deepEqual([e.measured, e.lines[0]!.state, e.lines[0]!.reason, e.lines[0]!.percent], [false, 'incomparable', 'units', null]);
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Одна сдача на другом объекте', metric: 'Время подготовки к сдаче', value: 60, unit: 'мин' });
  e = await effect();
  assert.deepEqual([e.measured, e.lines[0]!.state, e.lines[0]!.reason, e.lines[0]!.delta], [false, 'incomparable', 'conditions', null]);
  // Validation: the direction belongs to the baseline, comparability to a result with a number.
  await assert.rejects(async () => wf.recordEvidence(db, w.colleague.actor, n, v, wf.EvidenceInput.parse({ kind: 'result', body: 'x', metric: 'm', value: 1, goal: 'decrease' })));
  await assert.rejects(async () => wf.recordEvidence(db, w.colleague.actor, n, v, wf.EvidenceInput.parse({ kind: 'baseline', body: 'x', metric: 'm', value: 1, comparable: true })));
  await assert.rejects(async () => wf.recordEvidence(db, w.colleague.actor, n, v, wf.EvidenceInput.parse({ kind: 'result', body: 'x', comparable: true })));
  // The comparable «after».
  await wf.recordEvidence(db, w.colleague.actor, n, v, {
    kind: 'result', body: 'Среднее по трём сдачам с контрольным списком', metric: 'Время подготовки к сдаче', value: 72, unit: 'мин',
    period: 'три сдачи в ноябре, те же типы оборудования', source: 'журнал пусконаладки', comparable: true,
  });
  e = await effect();
  assert.deepEqual([e.measured, e.lines[0]!.state, e.lines[0]!.delta, e.lines[0]!.percent, e.lines[0]!.verdict, e.approval], [true, 'measured', -24, -25, 'improved', null]);
  // Evidence stays append-only: nothing recorded can be rewritten or removed.
  await assert.rejects(asUser(w.colleague, `UPDATE verification_evidence SET value = 10, comparable = true WHERE verification_id = $1`, [v]));
  await assert.rejects(asUser(w.maintainer, `DELETE FROM verification_evidence WHERE verification_id = $1`, [v]));
});

test('measuring after the decision: the lead starts it, it moves no stage, the effect is still approved only by the decision owner', async () => {
  const n = await itItem('Контрольный список для сдачи оборудования');
  await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Пробуем на ближайших сдачах', implementer: w.colleague.membershipId });
  const plan = { plan: 'Сравнить число повторных выездов до и после списка', successCriteria: 'Повторных выездов меньше', owner: w.colleague.membershipId };
  // Authority is unchanged: not the author, not a bystander, not the decision owner as the measurer.
  await assert.rejects(wf.startImpactVerification(db, w.author.actor, n, plan), codes('forbidden'));
  await assert.rejects(wf.startImpactVerification(db, w.colleague.actor, n, plan), codes('forbidden'));
  await assert.rejects(wf.startImpactVerification(db, w.maintainer.actor, n, { ...plan, owner: w.decider.membershipId }), codes('validation_failed'));
  await assert.rejects(wf.startImpactVerification(db, w.maintainer.actor, n, { ...plan, owner: w.author.membershipId }), codes('validation_failed'));
  const key = 'impact-1';
  const started = await wf.startImpactVerification(db, w.maintainer.actor, n, plan, key);
  assert.deepEqual((await wf.startImpactVerification(db, w.maintainer.actor, n, plan, key)).body, started.body, 'the same key starts nothing twice');
  await assert.rejects(wf.startImpactVerification(db, w.maintainer.actor, n, plan), codes('conflict'));
  const v = started.body.id;
  assert.equal(started.body.stage, 'adoption');
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'baseline', body: 'За сентябрь', metric: 'Повторные выезды', value: 6, unit: 'шт', period: 'сентябрь', source: 'журнал выездов', goal: 'decrease' });
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Список используется на всех сдачах с 1 ноября' });
  // The measurement continues after the implementation is confirmed.
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'За ноябрь', metric: 'Повторные выезды', value: 3, unit: 'шт', period: 'ноябрь, то же число сдач', source: 'журнал выездов', comparable: true });
  const concluded = await wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'positive', conclusion: 'Повторных выездов вдвое меньше при том же числе сдач' });
  assert.equal(concluded.body.stage, 'impact_verification', 'concluding a measurement changes no stage');
  let item = await getIdea(db, w.author.actor, n);
  assert.deepEqual([item.stage, item.effect.measured, item.effect.lines[0]!.delta, item.effect.lines[0]!.percent, item.effect.approval], ['impact_verification', true, -3, -50, null]);
  // A second measurement can be started after the implementation, too.
  const second = await wf.startImpactVerification(db, w.maintainer.actor, n, plan);
  assert.equal(second.body.stage, 'impact_verification');
  // Approval of the effect: the existing rule, nobody else.
  const approval = { xp: 20, rationale: 'Повторных выездов стало вдвое меньше, подтверждено журналом' };
  for (const p of [w.author, w.colleague, w.maintainer, w.admin]) await assert.rejects(progress.approveEffect(db, p.actor, n, approval), codes('forbidden'));
  await progress.approveEffect(db, w.decider.actor, n, approval);
  await assert.rejects(progress.approveEffect(db, w.decider.actor, n, approval), codes('conflict'));
  item = await getIdea(db, w.author.actor, n);
  assert.equal(item.effect.approval?.by, 'Олжас Решающий');
  assert.equal((await ownerQuery<{ c: number }>(db, `SELECT count(*)::int AS c FROM xp_awards a JOIN ideas i ON i.id = a.idea_id WHERE i.number = $1 AND a.kind = 'effect'`, [n]))[0]!.c, 1, 'XP for the effect exactly once');
  // The way into the Library: a draft with the measured line and a link to the item; nothing is saved by itself.
  const draft = await legacy.draftFromItem(db, w.author.actor, n);
  assert.match(draft.card.results ?? '', /Повторные выезды: было 6 шт, стало 3 шт \(−50%\)/);
  assert.deepEqual(draft.sources, [{ type: 'idea', number: n }]);
  assert.equal((await ownerQuery<{ c: number }>(db, 'SELECT count(*)::int AS c FROM knowledge_items'))[0]!.c, 0, 'no knowledge is created or accepted automatically');
});

test('an approved bonus without measurements is not shown as a measured effect', async () => {
  const n = await itItem('Внедрение без измерений');
  await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Небольшое и полезное изменение', implementer: w.colleague.membershipId });
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Сделано, работает с понедельника' });
  await progress.approveEffect(db, w.decider.actor, n, { xp: 10, rationale: 'Со слов склада стало удобнее работать' });
  const item = await getIdea(db, w.author.actor, n);
  assert.deepEqual([item.effect.measured, item.effect.lines, Boolean(item.effect.approval)], [false, [], true]);
  const draft = await legacy.draftFromItem(db, w.author.actor, n);
  assert.ok(!/было .* стало/.test(draft.card.results ?? ''), 'no invented numbers in the knowledge draft');
});
