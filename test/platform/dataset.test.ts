import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Database } from '../../platform/db/pool.ts';
import type { OrgActor, OrgRole } from '../../platform/domain/model.ts';
import { analytics } from '../../platform/modules/analytics.ts';
import { uploadAttachment } from '../../platform/modules/attachments.ts';
import { DatasetFile, datasetOfItem, importDataset, listDataset, type DatasetFileT } from '../../platform/modules/dataset.ts';
import { searchPeople } from '../../platform/modules/district.ts';
import { getIdea } from '../../platform/modules/ideas.ts';
import { kingdom } from '../../platform/modules/kingdom.ts';
import { addMember, createUser } from '../../platform/modules/provisioning.ts';
import { searchItems, SearchQuery } from '../../platform/modules/search.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * The organizer's official synthetic set (0017, ADR-0026): 20 rows A-001—A-020 imported through the
 * real services into their own namespace, and the organizer's six scenarios checked on the same APIs
 * the product uses. No XP comes from the set by itself.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let file: DatasetFileT;
let itLead: OrgActor;
const DS = 'official-synthetic';
const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const staff = async (name: string, jobTitle: string, roles: OrgRole[], department: string): Promise<OrgActor> => {
  const userId = await createUser(db, name);
  const membershipId = await addMember(db, w.acmeId, userId, roles, { department, jobTitle });
  return { userId, orgId: w.acmeId, membershipId, roles, access: 'member' };
};
const count = async (sql: string) => Number((await ownerQuery<{ n: string }>(db, sql))[0]!.n);

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  itLead = await staff('Игорь Айтишный', 'ИТ-специалист', ['employee', 'maintainer'], 'ИТ');
  await staff('Жанна Продажная', 'Руководитель отдела продаж', ['employee', 'maintainer', 'decision_owner'], 'Продажи');
  await staff('Павел Менеджер', 'Менеджер по продажам', ['employee'], 'Продажи');
  file = DatasetFile.parse(JSON.parse(await readFile(new URL('../../platform/data/official-synthetic-dataset.json', import.meta.url), 'utf8')));
});
after(async () => drop());

test('the set is 20 rows A-001—A-020 with the organizer\'s types and conditional statuses', () => {
  assert.equal(file.items.length, 20);
  assert.deepEqual(file.items.map((r) => r.id), Array.from({ length: 20 }, (_, i) => `A-${String(i + 1).padStart(3, '0')}`));
  assert.deepEqual([...new Set(file.items.map((r) => r.type))].sort(), ['Положительный отзыв', 'Предложение', 'Проблема']);
  assert.deepEqual([...new Set(file.items.map((r) => r.status))].sort(), ['В работе', 'Закрыто', 'На рассмотрении', 'Новое', 'Ожидает уточнения', 'Отклонено', 'Реализовано']);
});

test('only an organization admin imports; all 20 rows become real items and keep their original fields', async () => {
  await assert.rejects(importDataset(db, w.maintainer.actor, file), codes('forbidden'));
  const before = await count('SELECT count(*) AS n FROM ideas');
  const r = await importDataset(db, w.admin.actor, file);
  assert.equal(r.imported.length, 20);
  assert.equal(r.skipped.length, 0);
  assert.equal((await count('SELECT count(*) AS n FROM ideas')) - before, 20);
  const rows = (await listDataset(db, w.admin.actor, DS)) as { externalId: string; originalType: string; originalCategory: string; originalPriority: string; originalStatus: string; status: string; xp: number }[];
  assert.equal(rows.length, 20);
  for (const src of file.items) {
    const row = rows.find((x) => x.externalId === src.id)!;
    assert.deepEqual([row.originalType, row.originalCategory, row.originalPriority, row.originalStatus], [src.type, src.category, src.priority, src.status], src.id);
  }
  // Conditional statuses are carried by the real workflow as far as it goes without confirming anything.
  const real = Object.fromEntries(rows.map((x) => [x.externalId, x.status]));
  assert.equal(real['A-007'], 'in_review');
  assert.equal(real['A-005'], 'needs_info');
  assert.equal(real['A-003'], 'in_progress');
  assert.equal(real['A-017'], 'rejected');
  assert.equal(real['A-018'], 'closed');
  assert.equal(real['A-004'], 'in_progress', '«Реализовано» in the set is not a confirmed implementation here');
});

test('re-import is idempotent: nothing is duplicated', async () => {
  const ideas = await count('SELECT count(*) AS n FROM ideas');
  const reviews = await count('SELECT count(*) AS n FROM reviews');
  const r = await importDataset(db, w.admin.actor, file);
  assert.equal(r.imported.length, 0);
  assert.equal(r.skipped.length, 20);
  assert.equal(await count('SELECT count(*) AS n FROM ideas'), ideas);
  assert.equal(await count('SELECT count(*) AS n FROM reviews'), reviews);
  assert.equal(await count(`SELECT count(*) AS n FROM dataset_items WHERE dataset = '${DS}'`), 20);
});

test('the set gives no XP by itself; a demo confirmation is explicit, labelled and only for rows marked «Реализовано»', async () => {
  assert.equal(await count(`SELECT coalesce(sum(a.xp), 0) AS n FROM xp_awards a JOIN dataset_items d ON d.idea_id = a.idea_id`), 0);
  await assert.rejects(importDataset(db, w.admin.actor, file, { demoConfirm: ['A-007'] }), codes('validation_failed'));
  const r = await importDataset(db, w.admin.actor, file, { demoConfirm: ['A-004'] });
  assert.deepEqual(r.demoConfirmed, ['A-004']);
  const rows = (await listDataset(db, w.admin.actor, DS)) as { externalId: string; xp: number; demoConfirmedAt: string | null; status: string }[];
  const a4 = rows.find((x) => x.externalId === 'A-004')!;
  assert.equal(a4.xp, 100);
  assert.ok(a4.demoConfirmedAt, 'the confirmation is labelled as a demo one');
  assert.equal(a4.status, 'implemented');
  const a8 = rows.find((x) => x.externalId === 'A-008')!;
  assert.deepEqual([a8.xp, a8.demoConfirmedAt, a8.status], [0, null, 'in_progress'], 'the other «Реализовано» row is untouched');
  // Repeating the confirmation adds nothing.
  assert.deepEqual((await importDataset(db, w.admin.actor, file, { demoConfirm: ['A-004'] })).demoConfirmed, []);
  assert.equal(await count(`SELECT coalesce(sum(a.xp), 0) AS n FROM xp_awards a JOIN dataset_items d ON d.idea_id = a.idea_id`), 100);
  // The city shows the growth only from that confirmed row.
  const k = await kingdom(db, w.admin.actor);
  assert.equal(k.castles.reduce((n, c) => n + c.xp, 0) >= 100, true);
});

// ---- the organizer's six scenarios, on the product's own services -----------------------------
const numberOf = async (id: string) => ((await listDataset(db, w.admin.actor, DS)) as { externalId: string; number: number }[]).find((x) => x.externalId === id)!.number;

test('scenario 1: an item is created with type, category, description and an attachment', async () => {
  const n = (await submit(db, w.author, { title: 'Сканер не читает новые этикетки', kind: 'problem', categoryId: f.categories.it })).body.item.number;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await uploadAttachment(db, w.author.actor, n, { fileName: 'этикетка.png', contentType: 'image/png', data: png });
  const item = (await getIdea(db, w.author.actor, n)) as unknown as { kind: string; attachments: unknown[] };
  assert.equal(item.kind, 'problem');
  assert.equal(item.attachments.length, 1);
});

test('scenario 2: the owner is assigned by category, with a fallback when the category has no rule', async () => {
  const a7 = (await datasetOfItem(db, w.admin.actor, await numberOf('A-007'))) as { routedBy: string; originalOwner: string };
  assert.deepEqual([a7.routedBy, a7.originalOwner], ['category_rule', 'IT-специалист']);
  const lead = await ownerQuery<{ m: string }>(db, `SELECT maintainer_membership_id AS m FROM ideas WHERE number = ${await numberOf('A-007')}`);
  assert.equal(lead[0]!.m, itLead.membershipId, 'the IT category rule sends it to the IT specialist');
  const a5 = (await datasetOfItem(db, w.admin.actor, await numberOf('A-005'))) as { routedBy: string };
  assert.equal(a5.routedBy, 'fallback', 'nobody answers for «Документооборот»: the fallback owner takes it');
  assert.equal(await count(`SELECT count(*) AS n FROM dataset_items d JOIN ideas i ON i.id = d.idea_id WHERE i.maintainer_membership_id IS NULL`), 0, 'no row is left without an owner');
});

test('scenario 3: status changes, a clarification is requested and the comment history is kept', async () => {
  const n = await numberOf('A-005');
  const item = (await getIdea(db, w.admin.actor, n)) as unknown as { reviews: { kind: string; body: string }[] };
  assert.ok(item.reviews.some((r) => r.kind === 'request_changes' && /уточнение/i.test(r.body)));
  const n3 = await numberOf('A-003');
  const worked = (await getIdea(db, w.admin.actor, n3)) as unknown as { reviews: { kind: string }[] };
  assert.ok(worked.reviews.some((r) => r.kind === 'comment'), 'the comment before the decision stays in the history');
});

test('scenario 4: the author sees the state and the outcome, including a reasoned refusal', async () => {
  const n = await numberOf('A-017');
  const author = await ownerQuery<{ user_id: string; id: string; roles: OrgRole[] }>(db, `SELECT m.user_id, m.id, m.roles FROM ideas i JOIN memberships m ON m.id = i.author_membership_id WHERE i.number = ${n}`);
  const a = author[0]!;
  const mine = (await searchItems(db, { userId: a.user_id, orgId: w.acmeId, membershipId: a.id, roles: a.roles, access: 'member' }, SearchQuery.parse({ mine: 'true', status: 'rejected' }))) as { number: number; status: string }[];
  assert.ok(mine.some((i) => i.number === n && i.status === 'rejected'));
  const why = await ownerQuery<{ rationale: string }>(db, `SELECT d.rationale FROM decisions d JOIN ideas i ON i.id = d.idea_id WHERE i.number = ${n}`);
  assert.match(why[0]!.rationale, /Отклонено с объяснением/);
});

test('scenario 5: items are filtered by department, category and status, and overdue ones are found', async () => {
  const cat = await ownerQuery<{ id: string }>(db, `SELECT id FROM categories WHERE name = 'Обучение'`);
  const byCategory = (await searchItems(db, w.admin.actor, SearchQuery.parse({ category: cat[0]!.id }))) as { number: number }[];
  assert.deepEqual(byCategory.map((i) => i.number).sort(), [await numberOf('A-004'), await numberOf('A-016')].sort());
  const waiting = (await searchItems(db, w.admin.actor, SearchQuery.parse({ status: 'needs_info' }))) as { number: number }[];
  const n5 = await numberOf('A-005');
  assert.ok(waiting.some((i) => i.number === n5));
  // Overdue: shift one new row three weeks back; the same filter the product uses finds it.
  const n7 = await numberOf('A-007');
  await ownerQuery(db, `UPDATE ideas SET published_at = published_at - interval '21 days', first_response_due_at = first_response_due_at - interval '21 days' WHERE number = ${n7}`);
  const overdue = (await searchItems(db, w.admin.actor, SearchQuery.parse({ overdue: 'true' }))) as { number: number }[];
  assert.ok(overdue.some((i) => i.number === n7));
  const byDept = (await searchItems(db, w.admin.actor, SearchQuery.parse({ department: f.departments.sklad }))) as { number: number }[];
  assert.ok(Array.isArray(byDept));
});

test('scenario 6: the summary counts items by status, the share closed and the first-response time', async () => {
  const s = (await analytics(db, w.admin.actor, {})) as { totals: Record<string, unknown>; byStatus: { status: string; count: number }[]; byCategory: { category: string; total: number }[] };
  const by = Object.fromEntries(s.byStatus.map((x) => [x.status, x.count]));
  assert.ok((by.rejected ?? 0) >= 1 && (by.closed ?? 0) >= 1 && (by.needs_info ?? 0) >= 2);
  assert.ok(s.byCategory.some((c) => c.category === 'Интеграции и IT'));
  // Share with a result and the first-response time come from the same summary the «Обзор» screen shows.
  const t = s.totals as { total: number; withResult: number; medianFirstResponseHours: unknown };
  assert.ok(t.total >= 20 && t.withResult >= 3 && 'medianFirstResponseHours' in t);
  // By type: the product's two kinds; the set's own three types stay on the rows of the set.
  const problems = (await searchItems(db, w.admin.actor, SearchQuery.parse({ kind: 'problem', limit: 200 }))) as unknown[];
  const ideas = (await searchItems(db, w.admin.actor, SearchQuery.parse({ kind: 'idea', limit: 200 }))) as unknown[];
  assert.ok(problems.length >= file.items.filter((r) => r.type === 'Проблема').length && ideas.length >= 11);
});

test('city search finds colleagues by name for members only, and never across organizations', async () => {
  const hits = await searchPeople(db, w.author.actor, 'айтиш');
  assert.deepEqual(hits.map((h) => h.name), ['Игорь Айтишный']);
  assert.deepEqual(await searchPeople(db, w.outsider.actor, 'айтиш'), []);
  const guest = await person(db, w.acmeId, 'Гость Демо', ['maintainer'], 'Склад', 'guest');
  await assert.rejects(searchPeople(db, guest.actor, 'айтиш'), codes('forbidden'));
  assert.deepEqual(await searchPeople(db, w.author.actor, '%'), [], 'wildcards are not patterns');
});
