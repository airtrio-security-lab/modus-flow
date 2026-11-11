import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as district from '../../platform/modules/district.ts';
import * as progress from '../../platform/modules/progress.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { saveMyProfile } from '../../platform/modules/advisor.ts';
import { kingdom } from '../../platform/modules/kingdom.ts';
import { CivilizationInput } from '../../platform/modules/district.ts';
import { freshDatabase, ownerQuery, person, world, type Person } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * «Живое Королевство» (ADR-0019): the district screen and the person card read existing facts under
 * the caller's rights; the civilization is a picture chosen by the head or an admin, logged, and
 * changes no XP, level or right. Questionnaires: skills and hours for the person and leads,
 * preferences for the person only. Unknown figures are null («нет данных»), never 0.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let picker: Person;
let loader: Person;
let guest: Person;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  picker = await person(db, w.acmeId, 'Пётр Комплектовщик', ['employee'], 'Склад');
  loader = await person(db, w.acmeId, 'Олжас Грузчик', ['employee'], 'Склад');
  guest = await person(db, w.acmeId, 'Гость Подрядчик', ['maintainer'], 'Склад', 'guest');
  await saveMyProfile(db, picker.actor, { skills: ['Сканеры ТСД', 'Адресное хранение'], preferences: 'Не ставить в ночную смену', weeklyHours: 6 });
  await saveMyProfile(db, loader.actor, { skills: ['Погрузчик'], preferences: 'Хочу учиться на кладовщика', weeklyHours: 2 });
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: { actor: typeof w.author.actor }, sql: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(sql, params));

test('civilization: head or admin only, from the catalog, logged; no XP, level or right changes', async () => {
  const sklad = f.departments.sklad;
  const xpBefore = (await progress.castle(db, f.head.actor, sklad)).xp;
  const rolesBefore = await ownerQuery(db, 'SELECT id, roles FROM memberships ORDER BY id');
  for (const p of [picker, w.maintainer, w.decider]) await assert.rejects(district.setCivilization(db, p.actor, sklad, 'japan'), codes('forbidden'));
  await assert.rejects(district.setCivilization(db, guest.actor, sklad, 'japan'), codes('forbidden'));
  await assert.rejects(district.setCivilization(db, w.outsider.actor, sklad, 'japan'), codes('forbidden'));
  await assert.rejects(asUser(picker, `SELECT app_set_civilization($1, 'japan')`, [sklad]), codes('forbidden', '42501'));
  assert.throws(() => CivilizationInput.parse({ civilization: 'atlantis' }));
  await assert.rejects(asUser(f.head, `SELECT app_set_civilization($1, 'atlantis')`, [sklad]), codes('validation_failed', '23514'));
  assert.deepEqual(await district.setCivilization(db, f.head.actor, sklad, 'japan'), { civilization: { id: 'japan', name: 'Японский сёгунат' } });
  await district.setCivilization(db, w.admin.actor, f.departments.service, 'mongolia');
  // The head of one department does not choose for another.
  await assert.rejects(district.setCivilization(db, f.head.actor, f.departments.service, 'kazakh'), codes('forbidden'));
  const log = await ownerQuery<{ data: { from: string; to: string } }>(db, `SELECT data FROM audit_events WHERE action = 'castle.civilization_changed' AND entity_id = $1`, [sklad]);
  assert.deepEqual(log.map((l) => l.data), [{ from: 'camelot', to: 'japan' }]);
  assert.equal((await progress.castle(db, f.head.actor, sklad)).xp, xpBefore);
  assert.deepEqual(await ownerQuery(db, 'SELECT id, roles FROM memberships ORDER BY id'), rolesBefore);
  const k = await kingdom(db, picker.actor);
  assert.deepEqual(k.castles.map((c) => [c.name, c.civilization]).sort(), [['Сервис', 'mongolia'], ['Склад', 'japan']]);
  const d = await district.district(db, picker.actor, sklad);
  assert.equal(d.development.civilizationHistory[0]!.to, 'Японский сёгунат');
  assert.equal(d.canChooseCivilization, false);
  assert.equal((await district.district(db, f.head.actor, sklad)).canChooseCivilization, true);
});

test('district: header from recorded facts; groups by role and confirmed results; XP once per event', async () => {
  const sklad = f.departments.sklad;
  const n = (await submit(db, picker, { kind: 'idea', title: 'Адресное хранение мелочи', proposal: 'Подписать ячейки для мелких позиций', departmentId: sklad })).body.item.number;
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Ячейки есть, нужна только маркировка', implementer: loader.membershipId });
  const d1 = await district.district(db, f.head.actor, sklad);
  assert.equal(d1.activeTasks, 1);
  assert.deepEqual(d1.assignable.map((a) => a.number), [n], 'the head may name an implementer for its item');
  assert.equal((await district.district(db, picker.actor, sklad)).assignable.length, 0);
  await wf.completeImplementation(db, loader.actor, n, { report: 'Ячейки подписаны' });
  // Re-delivery of the same event awards nothing more.
  await assert.rejects(wf.completeImplementation(db, loader.actor, n, { report: 'Повтор' }));
  const d = await district.district(db, picker.actor, sklad);
  const awards = await ownerQuery<{ n: number; xp: number }>(db, `SELECT count(*)::int AS n, coalesce(sum(xp),0)::int AS xp FROM xp_awards WHERE department_id = $1`, [sklad]);
  assert.deepEqual([d.xp, awards[0]!.n], [awards[0]!.xp, 1]);
  const inDept = (await ownerQuery<{ n: number }>(db, `SELECT count(*)::int AS n FROM employees WHERE department = 'Склад' AND status = 'active' AND access = 'member' AND organization_id = $1`, [w.acmeId]))[0]!.n;
  assert.deepEqual([d.implemented, d.activeTasks, d.people, d.rank], [1, 0, inDept, 1]);
  assert.equal(d.head?.name, 'Начальник Склада');
  const mine = ['Начальник Склада', 'Олжас Грузчик', 'Пётр Комплектовщик'];
  const g = Object.fromEntries(d.staff.filter((s) => mine.includes(s.name)).map((s) => [s.name, s.group]));
  assert.deepEqual(g, { 'Начальник Склада': 'command', 'Олжас Грузчик': 'specialist', 'Пётр Комплектовщик': 'member' });
  const olzhas = d.staff.find((s) => s.name === 'Олжас Грузчик')!;
  assert.deepEqual(olzhas.achievements, { implemented: 1, ideasImplemented: 0, effectsConfirmed: 0, confirmedAsExecutor: 0 });
  assert.equal(olzhas.loadHours, null, 'load is unknown, not zero');
  assert.equal(d.needs.vacancies, null);
  assert.ok(d.initiatives.some((i) => i.number === n && i.status === 'implemented'));
  assert.deepEqual(d.lastAchievements.map((a) => a.title).sort(), ['Крепость', 'Первый камень']);
  // The achievements plaza counts the same achievements as the castle page.
  const earned = (await progress.castle(db, picker.actor, sklad)).achievements.filter((a) => a.earnedAt).length;
  assert.equal((await kingdom(db, picker.actor)).castles.find((c) => c.id === sklad)!.achievements, earned);
  assert.equal(typeof d.colorIndex, 'number');
});

test('privacy of cards: skills and hours to the person and leads, preferences to the person only, nothing for other orgs or guests', async () => {
  const sklad = f.departments.sklad;
  const byLoader = await district.district(db, loader.actor, sklad);
  const petr = byLoader.staff.find((s) => s.name === 'Пётр Комплектовщик')!;
  assert.deepEqual([petr.questionnaire, petr.skills, petr.capacityHours, petr.specialization], ['hidden', null, null, null]);
  const own = byLoader.staff.find((s) => s.name === 'Олжас Грузчик')!;
  assert.deepEqual([own.questionnaire, own.skills, own.capacityHours], ['filled', ['Погрузчик'], 2]);
  const blob = JSON.stringify(byLoader);
  for (const secret of ['Сканеры ТСД', 'ночную смену', 'учиться на кладовщика']) assert.ok(!blob.includes(secret), secret);
  const byHead = await district.district(db, f.head.actor, sklad);
  assert.deepEqual(byHead.staff.find((s) => s.name === 'Пётр Комплектовщик')!.skills, ['Сканеры ТСД', 'Адресное хранение']);
  assert.ok(!JSON.stringify(byHead).includes('ночную смену'), 'preferences never appear on cards');
  // The person card.
  const self = await district.person(db, picker.actor, picker.membershipId);
  assert.deepEqual([self.preferences, self.weeklyHours, self.loadHours], ['Не ставить в ночную смену', 6, null]);
  const lead = await district.person(db, f.head.actor, picker.membershipId);
  assert.deepEqual([lead.preferences, lead.weeklyHours, lead.skills?.length], [null, 6, 2]);
  const peer = await district.person(db, loader.actor, picker.membershipId);
  assert.deepEqual([peer.preferences, peer.weeklyHours, peer.skills, peer.questionnaire], [null, null, null, 'hidden']);
  assert.equal(peer.initiatives.length, 1, 'initiatives are readable by every member, as on «Все обращения»');
  // Other organizations and guests get nothing.
  await assert.rejects(district.district(db, w.outsider.actor, sklad), codes('not_found'));
  await assert.rejects(district.person(db, w.outsider.actor, picker.membershipId), codes('not_found'));
  await assert.rejects(district.district(db, guest.actor, sklad), codes('forbidden'));
  await assert.rejects(district.person(db, guest.actor, picker.membershipId), codes('forbidden'));
});

test('council tab: meetings only for their participants; assignment through the existing rule', async () => {
  const sklad = f.departments.sklad;
  const { createMeeting } = await import('../../platform/modules/meetings.ts');
  await createMeeting(db, f.head.actor, { title: 'Закрытый разбор склада', departmentId: sklad, participants: [picker.membershipId], organizerConsent: true });
  assert.ok((await district.district(db, picker.actor, sklad)).council.meetings.some((m) => m.title === 'Закрытый разбор склада'));
  assert.equal((await district.district(db, loader.actor, sklad)).council.meetings.length, 0);
  assert.ok(!JSON.stringify(await district.district(db, loader.actor, sklad)).includes('Закрытый разбор'));
  // «Назначить задачу» uses the existing implementer rule: only the maintainer / decision owner after «внедрять».
  const n = (await submit(db, loader, { kind: 'idea', title: 'Стеллаж для возвратов', proposal: 'Отдельный стеллаж для возвратов', departmentId: sklad })).body.item.number;
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Возвраты мешают приёмке, стеллаж есть', implementer: f.head.membershipId });
  await assert.rejects(wf.assignImplementer(db, picker.actor, n, { implementer: picker.membershipId }), codes('forbidden'));
  await wf.assignImplementer(db, f.head.actor, n, { implementer: picker.membershipId });
  const card = (await district.district(db, f.head.actor, sklad)).staff.find((s) => s.name === 'Пётр Комплектовщик')!;
  assert.equal(card.assigned, 1);
});
