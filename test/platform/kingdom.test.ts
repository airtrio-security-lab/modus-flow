import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../platform/db/pool.ts';
import * as admin from '../../platform/modules/admin.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { kingdom } from '../../platform/modules/kingdom.ts';
import { freshDatabase, person, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * «Королевство» (owner decision 2026-11-11): castles of departments grow only
 * from implemented items; open items are envoys; no personal scores.
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

const castle = async (id: string) => (await kingdom(db, w.colleague.actor)).castles.find((c) => c.id === id)!;
const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');

test('every active department has a castle, even with no items yet', async () => {
  const k = await kingdom(db, w.author.actor);
  assert.deepEqual(k.castles.map((c) => c.name).sort(), ['Сервис', 'Склад']);
  for (const c of k.castles) assert.deepEqual([c.towers, c.building, c.envoys, c.returned], [0, 0, 0, 0]);
});

test('submitting many items sends envoys but builds no towers', async () => {
  for (const t of ['Нет тележек у рампы', 'Темно в проходе Б', 'Сканер на кассе 3 не видит коды']) {
    await submit(db, w.author, { title: t, departmentId: f.departments.sklad });
  }
  const c = await castle(f.departments.sklad);
  assert.equal(c.envoys, 3);
  assert.equal(c.towers, 0);
});

test('a castle gains a tower only when an item is implemented; work in progress shows as building', async () => {
  const n = (
    await submit(db, w.author, {
      kind: 'idea',
      title: 'Разметка зон приёмки',
      proposal: 'Нанести разметку зон приёмки и отгрузки',
      departmentId: f.departments.sklad,
    })
  ).body.item.number;
  const before = await castle(f.departments.sklad);
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Дёшево и полезно', implementer: w.colleague.membershipId });
  const building = await castle(f.departments.sklad);
  assert.equal(building.building, before.building + 1);
  assert.equal(building.towers, before.towers);
  await wf.completeImplementation(db, f.head.actor, n, { report: 'Разметка нанесена' });
  const after = await castle(f.departments.sklad);
  assert.equal(after.towers, before.towers + 1);
  assert.equal(after.building, before.building);
  assert.equal(after.envoys, before.envoys - 1, 'the envoy came home: implemented items are not on the road');
});

test('rejected items return home and never count as towers', async () => {
  const n = (await submit(db, w.author, { title: 'Купить второй погрузчик', departmentId: f.departments.sklad })).body.item.number;
  const before = await castle(f.departments.sklad);
  await wf.decide(db, f.head.actor, n, { outcome: 'reject', rationale: 'Загрузка погрузчика 40 %, второй не нужен' });
  const after = await castle(f.departments.sklad);
  assert.equal(after.returned, before.returned + 1);
  assert.equal(after.towers, before.towers);
  assert.equal(after.envoys, before.envoys - 1);
});

test('envoys are marked as mine for the author and the person credited, not for others', async () => {
  const n = (
    await submit(db, f.head, {
      title: 'Нет перчаток на второй смене',
      departmentId: f.departments.sklad,
      sourceChannel: 'meeting',
      raisedBy: w.colleague.membershipId,
    })
  ).body.item.number;
  const mineFor = async (p: { actor: typeof w.author.actor }) => (await kingdom(db, p.actor)).envoys.find((e) => e.number === n)!.mine;
  assert.equal(await mineFor(f.head), true);
  assert.equal(await mineFor(w.colleague), true);
  assert.equal(await mineFor(w.author), false);
});

test('items without a department wait in the wildlands', async () => {
  const before = (await kingdom(db, w.author.actor)).wildlands;
  await submit(db, w.author, { title: 'Общий вопрос без подразделения' });
  assert.equal((await kingdom(db, w.author.actor)).wildlands, before + 1);
});

test('inactive departments have no castle; other organizations are invisible', async () => {
  const old = (await admin.createDepartment(db, w.admin.actor, { name: 'Старый цех' })).id;
  await admin.updateDepartment(db, w.admin.actor, old, { active: false });
  const k = await kingdom(db, w.author.actor);
  assert.ok(!k.castles.some((c) => c.id === old));
  const beta = await kingdom(db, w.outsider.actor);
  assert.equal(beta.castles.length, 0);
  assert.equal(beta.envoys.length, 0);
});

test('guests do not see the kingdom', async () => {
  const guest = await person(db, w.acmeId, 'Гость Демо', ['maintainer'], 'Подрядчик', 'guest');
  await assert.rejects(kingdom(db, guest.actor), codes('forbidden'));
});
