import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as admin from '../../platform/modules/admin.ts';
import * as council from '../../platform/modules/council.ts';
import * as district from '../../platform/modules/district.ts';
import * as meetings from '../../platform/modules/meetings.ts';
import * as progress from '../../platform/modules/progress.ts';
import * as titles from '../../platform/modules/titles.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { listInbox, savePreferences } from '../../platform/modules/notifications.ts';
import { freshDatabase, ownerQuery, person, world, type Person } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * «Цивилизации и советы» (ADR-0020): titles from the civilization registry by real function or the
 * person's own choice, never a right; small councils speak the words of their civilization; the
 * Great Round Table belongs to none; passing an item there needs authority over it, happens once,
 * keeps the department history and changes nothing in the workflow.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let master: Person;
let salesHead: Person;
let guest: Person;
let sales: string;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  master = await person(db, w.acmeId, 'Арман Мастер', ['employee'], 'Склад');
  salesHead = await person(db, w.acmeId, 'Глава Продаж', ['employee', 'maintainer'], 'Продажи');
  guest = await person(db, w.acmeId, 'Гость Подрядчик', ['maintainer'], 'Склад', 'guest');
  sales = (await admin.createDepartment(db, w.admin.actor, { name: 'Продажи', head: salesHead.membershipId })).id;
  // A confirmed result makes «Арман» a master specialist.
  const n = await item('Подписать ячейки для мелочи', w.author);
  await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Ячейки есть, нужна маркировка', implementer: master.membershipId });
  await wf.completeImplementation(db, master.actor, n, { report: 'Ячейки подписаны и проверены' });
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: { actor: typeof w.author.actor }, sql: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(sql, params));
async function item(title: string, who: Person) {
  return (await submit(db, who, { kind: 'idea', title, proposal: 'Сделать это на складе в ближайший месяц', categoryId: f.categories.it, departmentId: f.departments.sklad })).body.item.number;
}
const titleOf = async (p: Person) => (await titles.listTitles(db, w.author.actor)).titles.find((t) => t.membershipId === p.membershipId);
const setCiv = (civ: string) => district.setCivilization(db, f.head.actor, f.departments.sklad, civ);

test('titles come from the civilization of the district and real functions; none of them is a right', async () => {
  const xp = (await progress.castle(db, f.head.actor, f.departments.sklad)).xp;
  const roles = await ownerQuery(db, 'SELECT id, roles FROM memberships ORDER BY id');
  await setCiv('japan');
  // Only an admin names a deputy.
  await assert.rejects(titles.assignTitle(db, f.head.actor, w.colleague.membershipId, { rank: 'deputy' }), codes('forbidden'));
  await titles.assignTitle(db, w.admin.actor, w.colleague.membershipId, { rank: 'deputy' });
  const japan = Object.fromEntries(await Promise.all([f.head, w.colleague, master, w.author].map(async (p) => [p.actor.membershipId, (await titleOf(p))?.title])));
  assert.deepEqual(Object.values(japan), ['Даймё', 'Каро', 'Такуми', 'Житель сёгуната']);
  await setCiv('kazakh');
  assert.deepEqual(await Promise.all([f.head, w.colleague, master, w.author].map(async (p) => (await titleOf(p))?.title)), ['Хан', 'Султан', 'Шебер', 'Житель Орды']);
  await setCiv('mongolia');
  assert.deepEqual(await Promise.all([f.head, w.colleague, master, w.author].map(async (p) => (await titleOf(p))?.title)), ['Хан', 'Нойон', 'Дархан', 'Житель державы']);
  await setCiv('russia');
  assert.deepEqual(await Promise.all([f.head, w.colleague, master, w.author].map(async (p) => (await titleOf(p))?.title)), ['Воевода', 'Думный дьяк', 'Мастеровой', 'Житель царства']);
  await setCiv('camelot');
  assert.deepEqual(await Promise.all([f.head, w.colleague, master, w.author].map(async (p) => (await titleOf(p))?.title)), ['Лорд / Леди', 'Сенешаль', 'Мастер гильдии', 'Житель Камелота']);
  // Камелот's head title takes the form the person chose for it, never a guess; the private address form is not used.
  await savePreferences(db, f.head.actor, { style: 'royal', addressForm: 'milady', groupRepeats: true, muted: [] });
  assert.equal((await titleOf(f.head))?.title, 'Лорд / Леди');
  await titles.saveTitleChoices(db, f.head.actor, { neutral: false, novice: false, showHonor: false, headForm: 'lady' });
  assert.equal((await titleOf(f.head))?.title, 'Леди');
  await titles.saveTitleChoices(db, f.head.actor, { neutral: false, novice: false, showHonor: false, headForm: null });
  // The maintainer of another district is an authorized participant there (Рыцарь in Камелот).
  assert.equal((await titleOf(salesHead))?.title, 'Лорд / Леди', 'a head is a head, whatever their other roles');
  // Nothing about rights or XP changed with any of it.
  assert.deepEqual(await ownerQuery(db, 'SELECT id, roles FROM memberships ORDER BY id'), roles);
  assert.equal((await progress.castle(db, f.head.actor, f.departments.sklad)).xp, xp);
  // A «Каро» / «Сенешаль» still cannot call a meeting or decide: the title is words.
  await assert.rejects(meetings.createMeeting(db, w.colleague.actor, { title: 'Указ заместителя', participants: [w.author.membershipId], organizerConsent: true }), codes('forbidden'));
});

test('the person chooses: neutral title, the novice title only voluntarily, an earned honor only if shown', async () => {
  await setCiv('camelot');
  assert.equal((await titleOf(w.author))?.title, 'Житель Камелота', 'nobody is made a novice by default');
  await titles.saveTitleChoices(db, w.author.actor, { neutral: false, novice: true, showHonor: false, headForm: null });
  assert.equal((await titleOf(w.author))?.title, 'Оруженосец');
  // Other civilizations have no novice title: the choice simply does not apply.
  await setCiv('kazakh');
  assert.equal((await titleOf(w.author))?.title, 'Житель Орды');
  // Honor: only with confirmed achievements and only when the person shows it.
  assert.equal((await titleOf(master))?.honor, null);
  await titles.saveTitleChoices(db, master.actor, { neutral: false, novice: false, showHonor: true, headForm: null });
  assert.deepEqual([(await titleOf(master))?.title, (await titleOf(master))?.honor], ['Шебер', 'Батыр']);
  await titles.saveTitleChoices(db, w.author.actor, { neutral: false, novice: false, showHonor: true, headForm: null });
  assert.equal((await titleOf(w.author))?.honor, null, 'no confirmed achievements — no honor');
  // Neutral switches game titles off for that person, honor included.
  await titles.saveTitleChoices(db, master.actor, { neutral: true, novice: false, showHonor: true, headForm: null });
  assert.deepEqual([(await titleOf(master))?.title, (await titleOf(master))?.honor], ['Сотрудник', null]);
  // Nobody writes someone else's choices; guests have none.
  await assert.rejects(asUser(w.author, `INSERT INTO title_choices (organization_id, membership_id, neutral) VALUES ($1, $2, true)`, [w.acmeId, w.colleague.membershipId]));
  const r = await asUser(w.author, `UPDATE title_choices SET neutral = false WHERE membership_id = $1`, [master.membershipId]);
  assert.equal(r.rowCount, 0);
  await assert.rejects(titles.saveTitleChoices(db, guest.actor, { neutral: true, novice: false, showHonor: false, headForm: null }), codes('forbidden'));
  await titles.saveTitleChoices(db, master.actor, { neutral: false, novice: false, showHonor: true, headForm: null });
});

test('small councils: the invitation speaks the words of the district, the facts never change with the style', async () => {
  await setCiv('japan');
  const n = await item('Печать этикеток у ворот', w.author);
  const id = (
    await meetings.createMeeting(db, f.head.actor, {
      title: 'Малый совет склада',
      departmentId: f.departments.sklad,
      agenda: [n],
      scheduledAt: '2026-11-20T10:00:00+05:00',
      participants: [w.author.membershipId, master.membershipId],
      organizerConsent: true,
    })
  ).body.id;
  const read = async (p: Person) => (await listInbox(db, p.actor)).find((x) => x.meetingId === id && x.event === 'meeting_called')!;
  const facts = (m: Awaited<ReturnType<typeof read>>) => [m.message, m.meeting?.title, m.meeting?.organizer, m.meeting?.scheduledAt, m.meeting?.agenda.map((a) => a.number)];
  const japan = await read(master);
  assert.equal(japan.headline, 'Созван малый совет: Зал даймё');
  assert.match(japan.royal!, /^Такуми, вас ожидают в зале совета: Зал даймё замка «Склад»\. Вопрос: «Малый совет склада»\./);
  assert.deepEqual(japan.meeting?.agenda.map((a) => a.number), [n]);
  const expected: Record<string, RegExp> = {
    kazakh: /^Шебер, в Орде созывается совет: Ханская юрта замка «Склад»/,
    camelot: /^Мастер гильдии, вас призывают в зал Камелота: Зал рыцарей замка «Склад»/,
    mongolia: /^Дархан, вас приглашают на совет: Совет нойонов замка «Склад»/,
    russia: /^Мастеровой, вас приглашают в Боярскую думу: Боярская дума замка «Склад»/,
  };
  for (const [civ, re] of Object.entries(expected)) {
    await setCiv(civ);
    const m = await read(master);
    assert.match(m.royal!, re);
    assert.deepEqual(facts(m), facts(japan), `business facts unchanged after the style became ${civ}`);
  }
  // Business style: no game wording at all, the same facts.
  await savePreferences(db, master.actor, { style: 'business', addressForm: 'neutral', groupRepeats: true, muted: [] });
  const plain = await read(master);
  assert.deepEqual([plain.royal, plain.headline], [null, 'Приглашение на заседание']);
  await savePreferences(db, master.actor, { style: 'royal', addressForm: 'title', groupRepeats: true, muted: [] });
  // The agenda is visible to participants only.
  assert.equal((await asUser(master, 'SELECT * FROM meeting_agenda WHERE meeting_id = $1', [id])).rowCount, 1);
  assert.equal((await asUser(w.colleague, 'SELECT * FROM meeting_agenda WHERE meeting_id = $1', [id])).rowCount, 0);
  const view = await meetings.getMeeting(db, f.head.actor, id, { model: null, engine: null });
  assert.deepEqual([view.place.council, view.place.hall], ['small', 'Совет нойонов']);
  await setCiv('japan');
});

test('Great Round Table: passed once, with a reason, by those with authority; history kept; the decision stays with its owner', async () => {
  await setCiv('japan');
  const n = await item('Общий сервер печати для склада и продаж', w.author);
  await council.addEntry(db, w.colleague.actor, n, { kind: 'argument_for', body: 'Склад печатает быстрее' });
  const reason = { reasonKind: 'cross_department' as const, reason: 'Сервер печати нужен и складу, и продажам — решать вместе' };
  // Not allowed: the author, a colleague, the head of another district, a guest, another organization.
  for (const p of [w.author, w.colleague, salesHead]) await assert.rejects(council.escalate(db, p.actor, n, reason), codes('forbidden'));
  await assert.rejects(council.escalate(db, guest.actor, n, reason), codes('forbidden', 'not_found'));
  await assert.rejects(council.escalate(db, w.outsider.actor, n, reason), codes('not_found', 'forbidden'));
  assert.equal((await council.getCouncil(db, f.head.actor, n)).can.escalate, true);
  assert.equal((await council.getCouncil(db, w.colleague.actor, n)).can.escalate, false);
  // The head of the item's district passes it (idempotent on retry), exactly once.
  const key = 'escalation-key-1';
  const first = await council.escalate(db, f.head.actor, n, reason, key);
  const again = await council.escalate(db, f.head.actor, n, reason, key);
  assert.deepEqual(again.body, first.body);
  await assert.rejects(council.escalate(db, w.maintainer.actor, n, reason), codes('conflict'));
  // Direct writes are impossible.
  await assert.rejects(asUser(f.head, `INSERT INTO council_escalations (organization_id, idea_id, escalated_by_membership_id, reason_kind, reason) SELECT $1, id, $2, 'other', 'Подделка эскалации' FROM ideas WHERE number = $3`, [w.acmeId, f.head.membershipId, n]));
  await assert.rejects(asUser(w.colleague, `SELECT app_notify_escalation($1, $2::uuid[])`, [first.body.id, [w.author.membershipId]]), /not backed|запрещена политикой доступа/);
  // Entries remember where they were made.
  await council.addEntry(db, salesHead.actor, n, { kind: 'argument_against', body: 'Продажам нужен свой принтер' });
  const c = await council.getCouncil(db, w.author.actor, n);
  assert.deepEqual(c.entries.map((e) => [e.author, e.council]), [['Анна Коллега', 'small'], ['Глава Продаж', 'great']]);
  assert.equal(c.place.level, 'great');
  assert.equal(c.place.hall, 'Большой Круглый стол');
  assert.deepEqual([c.place.escalation?.by, c.place.escalation?.reasonTitle, c.place.escalation?.from?.name, c.place.escalation?.from?.hall], [
    'Начальник Склада', 'Межотдельский вопрос: затрагивает несколько подразделений', 'Склад', 'Зал даймё',
  ]);
  // Every civilization is called equally: the heads of all districts, plus the people of the item — one message each.
  const sent = await ownerQuery<{ r: string; n: number }>(db, `SELECT recipient_membership_id AS r, count(*)::int AS n FROM notifications WHERE event_type = 'council_escalated' GROUP BY 1`);
  assert.ok(sent.every((x) => x.n === 1), 'no duplicates');
  const to = new Set(sent.map((x) => x.r));
  for (const p of [salesHead, w.maintainer, w.decider, w.author, f.escalation]) assert.ok(to.has(p.membershipId), p.actor.membershipId);
  assert.ok(!to.has(f.head.membershipId), 'the sender is not notified');
  const msg = (await listInbox(db, salesHead.actor)).find((x) => x.event === 'council_escalated')!;
  assert.equal(msg.royal, 'Главы владений, вас созывают к Большому Круглому столу: вопрос «Общий сервер печати для склада и продаж» передан из малого совета «Склад».');
  assert.match(msg.message, /передаёт «Общий сервер печати для склада и продаж» из малого совета подразделения в Большой совет/);
  const row = (await council.listCouncil(db, w.colleague.actor)).find((x) => x.number === n)!;
  assert.deepEqual([row.council, row.hall], ['great', 'Большой Круглый стол']);
  // The decision stays with its owner: the head who escalated cannot decide this item.
  await assert.rejects(wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Решаю как глава склада' }), codes('forbidden'));
  await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Общий сервер для двух подразделений', implementer: w.maintainer.membershipId });
  // Closed or decided items do not go to a council.
  const m = await item('Уже решённое', w.author);
  await wf.decide(db, w.decider.actor, m, { outcome: 'reject', rationale: 'Не актуально после переезда' });
  await assert.rejects(council.escalate(db, f.head.actor, m, reason), codes('conflict'));
});

test('changing the style keeps XP, tasks, history, meetings and rights', async () => {
  const before = await district.district(db, f.head.actor, f.departments.sklad);
  const meetingsBefore = await meetings.listMeetings(db, f.head.actor);
  for (const civ of ['camelot', 'kazakh', 'mongolia', 'russia', 'japan']) await setCiv(civ);
  const afterD = await district.district(db, f.head.actor, f.departments.sklad);
  assert.deepEqual([afterD.xp, afterD.level, afterD.implemented, afterD.tasks.length, afterD.initiatives.length], [before.xp, before.level, before.implemented, before.tasks.length, before.initiatives.length]);
  assert.deepEqual(afterD.development.history, before.development.history);
  const meetingsAfter = await meetings.listMeetings(db, f.head.actor);
  assert.deepEqual(meetingsAfter.map((m) => [m.id, m.title, m.council]), meetingsBefore.map((m) => [m.id, m.title, m.council]));
  assert.equal(afterD.civilization.hall, 'Зал даймё');
  assert.equal(afterD.staff.find((s) => s.name === 'Начальник Склада')?.title, 'Даймё');
  void sales;
});
