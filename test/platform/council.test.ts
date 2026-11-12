import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as wf from '../../platform/modules/workflow.ts';
import * as council from '../../platform/modules/council.ts';
import { getIdea } from '../../platform/modules/ideas.ts';
import { listInbox } from '../../platform/modules/notifications.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * «Совет королевства» (owner brief 2026-11-11, ADR-0012): arguments and
 * recommendations are advice and history; the decision stays with the person
 * the rules name; everything is append-only and timestamped.
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
const statusOf = async (n: number) => ((await getIdea(db, w.author.actor, n)) as unknown as { status: string }).status;
const sql = (p: { actor: typeof w.author.actor }, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(text, params));
/** IT items are led by the maintainer and decided by the decision owner (category rule). */
const itItem = async (title: string) =>
  (await submit(db, w.author, { kind: 'idea', title, proposal: 'Перевести печать этикеток на общий сервер печати', categoryId: f.categories.it, departmentId: f.departments.sklad }))
    .body.item.number;

test('members argue for and against; the table shows who said what and when', async () => {
  const n = await itItem('Общий сервер печати этикеток');
  await council.addEntry(db, w.colleague.actor, n, { kind: 'argument_for', body: 'Сократит очереди у принтера' });
  await council.addEntry(db, f.head.actor, n, { kind: 'argument_against', body: 'Один сервер — одна точка отказа' });
  await council.addEntry(db, w.author.actor, n, { kind: 'argument_for', body: 'Принтеры уже есть, нужен только сервер' });
  const t = await council.getCouncil(db, w.colleague.actor, n);
  assert.deepEqual(t.entries.map((e) => [e.kind, e.author]), [
    ['argument_for', 'Анна Коллега'],
    ['argument_against', 'Начальник Склада'],
    ['argument_for', 'Кирилл Демо'],
  ]);
  assert.ok(t.entries.every((e) => e.createdAt instanceof Date));
  const seat = (name: string) => t.seats.find((s) => s.name === name)!;
  assert.equal(seat('Анна Коллега').stance, 'for');
  assert.equal(seat('Начальник Склада').stance, 'against');
});

test('seats carry real roles: initiator highlighted, who leads, who decides, department heads', async () => {
  const n = (
    await submit(db, f.head, {
      title: 'Нет перчаток на второй смене',
      categoryId: f.categories.it,
      departmentId: f.departments.sklad,
      sourceChannel: 'meeting',
      raisedBy: w.colleague.membershipId,
    })
  ).body.item.number;
  const t = await council.getCouncil(db, w.author.actor, n);
  const roles = Object.fromEntries(t.seats.map((s) => [s.name, s.roles]));
  assert.deepEqual(roles['Анна Коллега'], ['initiator']);
  assert.ok(roles['Начальник Склада']!.includes('recorded'));
  assert.ok(roles['Начальник Склада']!.includes('department_head'));
  assert.deepEqual(roles['Мария Ведущая'], ['maintainer']);
  assert.deepEqual(roles['Олжас Решающий'], ['decision_owner']);
  assert.equal(t.seats[0]!.roles[0], 'initiator', 'the initiator comes first');
  assert.equal(t.item.decisionOwner, 'Олжас Решающий');
});

test('an originator argues but does not recommend — in the service and in the database', async () => {
  const n = await itItem('Сканеры с подставками');
  await assert.rejects(
    council.addEntry(db, w.author.actor, n, { kind: 'recommendation', recommendation: 'implement', body: 'Рекомендую внедрить моё' }),
    codes('forbidden'),
  );
  await assert.rejects(
    sql(w.author, `INSERT INTO council_entries (organization_id, idea_id, author_membership_id, kind, recommendation, body)
                   SELECT organization_id, id, $2, 'recommendation', 'implement', 'Рекомендую внедрить своё'
                     FROM ideas WHERE number = $1 AND organization_id = app_org_id()`, [n, w.author.membershipId]),
  );
  assert.equal((await council.getCouncil(db, w.author.actor, n)).can.recommend, false);
});

test('recommendations need a choice and a reason, and never change the status on their own', async () => {
  const n = await itItem('Отдельная линия для срочной приёмки');
  assert.equal(council.CouncilEntryInput.safeParse({ kind: 'recommendation', body: 'Без варианта, но с текстом' }).success, false);
  assert.equal(council.CouncilEntryInput.safeParse({ kind: 'recommendation', recommendation: 'reject', body: 'Нет' }).success, false);
  const before = await statusOf(n);
  await council.addEntry(db, w.colleague.actor, n, { kind: 'recommendation', recommendation: 'reject', body: 'Нет места под вторую линию' });
  await council.addEntry(db, f.head.actor, n, { kind: 'recommendation', recommendation: 'pilot', body: 'Проверить две недели на воротах №1' });
  assert.equal(await statusOf(n), before, 'advice, not a decision');
  const inbox = (await listInbox(db, w.decider.actor)).filter((x) => x.ideaNumber === n && x.event === 'council_recommendation');
  assert.equal(inbox.length, 2, 'the decision owner sees each recommendation');
  assert.equal((await listInbox(db, w.author.actor)).filter((x) => x.event === 'council_recommendation').length, 0);
});

test('dissent is recorded and reaches the people responsible', async () => {
  const n = await itItem('Ночная приёмка по пятницам');
  await council.addEntry(db, f.head.actor, n, { kind: 'dissent', body: 'Не согласен с пилотом: ночная смена без кладовщика' });
  const t = await council.getCouncil(db, w.decider.actor, n);
  assert.equal(t.seats.find((s) => s.name === 'Начальник Склада')!.stance, 'dissent');
  assert.ok((await listInbox(db, w.maintainer.actor)).some((x) => x.ideaNumber === n && x.event === 'council_recommendation'));
});

test('only the maintainer hands the item over; then only the decision owner decides', async () => {
  const n = await itItem('Резервный роутер на складе');
  await assert.rejects(council.handoff(db, w.colleague.actor, n, { summary: 'Обсудили, передаю на решение' }), codes('forbidden'));
  await assert.rejects(council.handoff(db, w.decider.actor, n, { summary: 'Обсудили, передаю на решение' }), codes('forbidden'));
  const r = await council.handoff(db, w.maintainer.actor, n, { summary: 'За: стабильная связь. Против: цена. Рекомендация: пилот' });
  assert.equal(r.body.stage, 'decision');
  assert.equal(await statusOf(n), 'decision');
  assert.ok((await listInbox(db, w.decider.actor)).some((x) => x.ideaNumber === n && x.event === 'council_handoff'));
  await assert.rejects(council.handoff(db, w.maintainer.actor, n, { summary: 'Повторно передаю на решение' }), codes('conflict'));
  await assert.rejects(
    wf.decide(db, w.maintainer.actor, n, { outcome: 'merge', rationale: 'Совет за, внедряем роутер' }),
    codes('forbidden'),
  );
  await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Совет за, внедряем роутер', implementer: w.maintainer.membershipId });
  assert.equal(await statusOf(n), 'in_progress');
  const t = await council.getCouncil(db, w.author.actor, n);
  assert.equal(t.decisions.length, 1);
  assert.equal(t.entries.find((e) => e.kind === 'handoff')!.author, 'Мария Ведущая');
});

test('the council closes with the item; history cannot be edited', async () => {
  const n = await itItem('Старая идея про тележки');
  await council.addEntry(db, w.colleague.actor, n, { kind: 'argument_for', body: 'Тележки быстрее' });
  await wf.decide(db, w.decider.actor, n, { outcome: 'reject', rationale: 'Тележки уже закуплены в прошлом месяце' });
  await assert.rejects(council.addEntry(db, w.colleague.actor, n, { kind: 'argument_for', body: 'Ещё аргумент' }), codes('conflict'));
  await assert.rejects(sql(w.colleague, `UPDATE council_entries SET body = 'Переписано' WHERE author_membership_id = $1`, [w.colleague.membershipId]));
  await assert.rejects(ownerQuery(db, 'DELETE FROM council_entries'));
});

test('the council list shows items under consideration with their counts', async () => {
  const waiting = await itItem('Камера на воротах №2');
  await council.handoff(db, w.maintainer.actor, waiting, { summary: 'Возражений нет, передаю на решение' });
  const list = await council.listCouncil(db, w.colleague.actor);
  const titles = list.map((x) => x.title as string);
  assert.ok(titles.includes('Общий сервер печати этикеток'));
  assert.ok(!titles.includes('Старая идея про тележки'), 'decided items leave the council');
  const row = list.find((x) => x.title === 'Общий сервер печати этикеток')!;
  assert.equal(row.for, 2);
  assert.equal(row.against, 1);
  assert.equal(list[0]!.status, 'decision', 'items waiting for a decision come first');
});

test('another organization sees nothing; a guest only what they are assigned to', async () => {
  const n = await itItem('Подписи на стеллажах');
  await assert.rejects(council.getCouncil(db, w.outsider.actor, n), codes('not_found'));
  const guest = await person(db, w.acmeId, 'Гость Совета', ['maintainer'], 'Внешний', 'guest');
  await assert.rejects(council.getCouncil(db, guest.actor, n), codes('not_found'));
  assert.equal((await council.listCouncil(db, guest.actor)).length, 0);
});
