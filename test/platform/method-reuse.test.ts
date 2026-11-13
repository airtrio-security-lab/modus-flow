import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as legacy from '../../platform/modules/legacy.ts';
import * as meetings from '../../platform/modules/meetings.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { getIdea } from '../../platform/modules/ideas.ts';
import { LIMITS, assemblePath, ideaOutcome, useStatus, type IdeaFacts } from '../../platform/domain/knowledge-path.ts';
import { freshDatabase, ownerQuery, person, world, type Person } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * Living knowledge (ADR-0040, ADR-0041):
 *   «Путь решения»      — the path is laid out from recorded facts; a failed branch stays; a closed source says nothing;
 *   «Применить этот метод» — an ordinary item with a reference to the knowledge: no application, no XP, no new right;
 *   the catalogue       — pages with a total order, exact totals, the reader's rights in every number.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let archivist: Person;
let method: string;
let chronicle: string;
let source: number;
let failed: number;

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: { actor: typeof w.author.actor }, sql: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(sql, params));
const count = async (sql: string, params: unknown[] = []) => Number((await ownerQuery<{ n: string }>(db, `SELECT count(*) AS n FROM ${sql}`, params))[0]!.n);
const CARD = {
  problem: 'Бригада возвращалась на склад за инструментом: комплект перед выездом никто не сверял.',
  options: 'Собирать по памяти; закрепить ящик за бригадой; сверять комплект по списку перед выездом.',
  decision: 'Перед выездом бригадир сверяет комплект по единому контрольному списку.',
  reasons: 'Самый дешёвый способ убрать возвраты; список легко поправить под новый тип работ.',
};
const item = async (who: Person, title: string, extra: Record<string, unknown> = {}) =>
  (await submit(db, who, { kind: 'idea', title, proposal: 'Сверять комплект инструмента по списку перед каждым выездом', departmentId: f.departments.sklad, ...extra })).body.item;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  const a = await person(db, w.acmeId, 'Архивариус Демо', ['employee'], 'Канцелярия');
  await legacy.setArchivist(db, w.admin.actor, a.membershipId, true);
  archivist = { ...a, actor: { ...a.actor, roles: ['employee', 'archivist'] } };

  // One problem, two proposals: the first is rejected, the second is decided and becomes a method.
  failed = (await item(w.author, 'Общий ящик инструмента на все бригады')).number;
  source = (await item(w.author, 'Контрольный список перед выездом')).number;
  await wf.decide(db, f.head.actor, failed, { outcome: 'reject', rationale: 'Общий ящик не решает задачу: инструмент расходится по бригадам' });
  await wf.decide(db, f.head.actor, source, { outcome: 'merge', rationale: 'Список занимает три минуты и не требует закупок', implementer: w.colleague.membershipId });
  method = (await legacy.register(db, w.maintainer.actor, { kind: 'method', title: 'Контрольный список перед выездом бригады', card: CARD, sources: [{ type: 'idea', number: source }, { type: 'idea', number: failed }] })).id;
  await legacy.act(db, w.maintainer.actor, method, { action: 'library_proposed', reason: 'Решение принято, порядок описан' });
  await legacy.act(db, archivist.actor, method, { action: 'library_accepted', reason: 'Источники проверены' });
  await legacy.act(db, f.head.actor, method, { action: 'opened_to_organization', reason: 'Полезно всем подразделениям' });
  chronicle = (await legacy.register(db, w.maintainer.actor, { kind: 'method', title: 'Непроверенная запись летописи', card: CARD, sources: [{ type: 'idea', number: source }] })).id;
});
after(async () => drop());

// ---------------------------------------------------------------------------
// «Путь решения»
// ---------------------------------------------------------------------------
const facts = (over: Partial<IdeaFacts> = {}): IdeaFacts => ({ number: 126, title: 'Повторяющиеся ошибки при пусконаладке', statusLabel: 'На рассмотрении', publishedAt: '2026-10-01T08:00:00.000Z', council: [], meetings: [], decisions: [], verifications: [], implementedAt: null, effectAt: null, ...over });

test('pure: the outcome of a branch is read from facts and from nothing else', () => {
  assert.deepEqual(ideaOutcome(facts()), { tone: 'wait', label: 'решение не принято' });
  assert.equal(ideaOutcome(facts({ decisions: [{ outcome: 'reject', at: '2026-10-03T00:00:00Z' }] })).label, 'не внедрено');
  assert.equal(ideaOutcome(facts({ decisions: [{ outcome: 'merge', at: '2026-10-03T00:00:00Z' }] })).label, 'решено внедрять, внедрение не завершено');
  assert.equal(ideaOutcome(facts({ decisions: [{ outcome: 'merge', at: '2026-10-03T00:00:00Z' }], implementedAt: '2026-10-20T00:00:00Z' })).label, 'внедрено, результат ещё не подтверждён');
  assert.equal(ideaOutcome(facts({ implementedAt: '2026-10-20T00:00:00Z', effectAt: '2026-11-01T00:00:00Z' })).label, 'внедрено, результат подтверждён');
});

test('pure: a step that did not happen is absent; a closed source carries no title and no events', () => {
  const full = facts({
    council: [
      { kind: 'argument_for', recommendation: null, at: '2026-10-02T00:00:00Z' },
      { kind: 'recommendation', recommendation: 'pilot', at: '2026-10-02T10:00:00Z' },
    ],
    decisions: [{ outcome: 'merge', at: '2026-10-03T00:00:00Z' }],
    verifications: [{ purpose: 'hypothesis', status: 'completed', outcome: 'positive', evidence: 3, at: '2026-10-10T00:00:00Z' }],
    implementedAt: '2026-10-20T00:00:00Z',
    effectAt: '2026-11-01T00:00:00Z',
  });
  const p = assemblePath({
    sources: [{ type: 'idea', idea: null }, { type: 'idea', idea: full }, { type: 'idea', idea: facts({ number: 127, title: 'Другой вариант', decisions: [{ outcome: 'reject', at: '2026-10-04T00:00:00Z' }] }) }, { type: 'meeting', label: 'Закрытое заседание — доступно только участникам', link: null, available: false, at: null }],
    transitions: [
      { action: 'registered', title: 'Зарегистрировано в Летописи', at: '2026-11-02T00:00:00Z' },
      { action: 'source_added', title: 'Добавлен источник', at: '2026-11-02T01:00:00Z' },
      { action: 'library_accepted', title: 'Архивариус внёс в Библиотеку', at: '2026-11-03T00:00:00Z' },
    ],
    uses: [],
  });
  assert.deepEqual(p.branches.map((b) => [b.source.available, b.outcome.label]), [[true, 'внедрено, результат подтверждён'], [true, 'не внедрено'], [false, 'закрыт для вас'], [false, 'закрыт для вас']], 'both proposals are kept, the failed one too; closed sources last');
  assert.deepEqual(p.branches[0]!.nodes.map((n) => n.type), ['item', 'council', 'decision', 'verification', 'implementation', 'effect']);
  assert.equal(p.branches[0]!.nodes[1]!.detail, '1 рекомендация, 1 довод «за»; последняя рекомендация — провести пилот');
  assert.equal(p.branches[0]!.nodes[3]!.detail, 'сохранено: 3 доказательства');
  assert.deepEqual(p.branches[1]!.nodes.map((n) => n.type), ['item', 'decision'], 'no verification, no implementation: they did not happen');
  for (const closed of p.branches.slice(2)) {
    assert.deepEqual(closed.nodes, []);
    assert.equal(closed.source.link, null);
    assert.doesNotMatch(JSON.stringify(closed), /№|«/, 'neither a number nor a title of a closed source');
  }
  assert.deepEqual(p.trunk.map((n) => n.title), ['Зарегистрировано в Летописи', 'Архивариус внёс в Библиотеку']);
  assert.equal(p.foldedTrunk, 1, 'what is folded is counted');
});

test('pure: the visible depth is limited and the fold is counted; the beginning and the end stay', () => {
  const many = facts({ decisions: Array.from({ length: 14 }, (_, i) => ({ outcome: i === 13 ? 'merge' : 'close', at: `2026-10-${String(i + 2).padStart(2, '0')}T00:00:00Z` })) });
  const p = assemblePath({ sources: [...Array.from({ length: 9 }, (_, i) => ({ type: 'idea' as const, idea: facts({ number: 200 + i, publishedAt: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z` }) })), { type: 'idea', idea: many }], transitions: [], uses: Array.from({ length: 11 }, (_, i) => ({ number: 300 + i, title: 'x', startedAt: null, recorded: true, implemented: false, effectConfirmed: false, lastDecision: null })) });
  assert.equal(p.branches.length, LIMITS.branches);
  assert.equal(p.foldedBranches, 4);
  const big = assemblePath({ sources: [{ type: 'idea', idea: many }], transitions: [], uses: [] }).branches[0]!;
  assert.equal(big.nodes.length, LIMITS.nodes);
  assert.equal(big.folded, 15 - LIMITS.nodes);
  assert.equal(big.nodes[0]!.type, 'item');
  assert.equal(big.nodes.at(-1)!.status.label, 'внедрять', 'the last decision is shown');
  assert.equal(p.uses.length, LIMITS.uses);
  assert.equal(p.foldedUses, 3);
});

test('pure: a use is confirmed only by a recorded application of an implemented item', () => {
  const u = { number: 1, title: 't', startedAt: '2026-11-01T00:00:00Z', recorded: false, implemented: false, effectConfirmed: false, lastDecision: null };
  assert.equal(useStatus(u).label, 'Применение ещё не подтверждено');
  assert.equal(useStatus({ ...u, implemented: true }).label, 'Применение ещё не подтверждено', 'implemented but not recorded by a curator');
  assert.equal(useStatus({ ...u, recorded: true }).label, 'Применение ещё не подтверждено', 'recorded but not implemented');
  assert.equal(useStatus({ ...u, recorded: true, implemented: true }).label, 'Применение подтверждено: внедрено');
  assert.equal(useStatus({ ...u, lastDecision: 'reject' }).tone, 'no', 'a negative result is shown, not hidden');
});

test('the path of real knowledge: both proposals, the rejected one too, from the recorded decisions', async () => {
  const k = await legacy.get(db, w.colleague.actor, method);
  assert.deepEqual(k.path.branches.map((b) => [b.source.label, b.outcome.label]).sort(), [[`Обращение №${failed}`, 'не внедрено'], [`Обращение №${source}`, 'решено внедрять, внедрение не завершено']].sort());
  const ok = k.path.branches.find((b) => b.source.label === `Обращение №${source}`)!;
  assert.deepEqual(ok.nodes.map((n) => n.type), ['item', 'decision']);
  assert.equal(ok.nodes[1]!.link, `#/items/${source}`, 'every node leads to the real record');
  assert.deepEqual(k.path.trunk.map((n) => n.title), ['Зарегистрировано в Летописи', 'Архивариус внёс в Библиотеку', 'Открыто всей организации']);
  // The rationale and the card's words are in their own records, not copied into the path.
  assert.doesNotMatch(JSON.stringify(k.path), /три минуты|расходится по бригадам/);
});

test('a source the reader may not open: the branch is closed, nothing about it leaks through the path', async () => {
  // Knowledge opened to the whole organization that also rests on a meeting; the reader was not at that meeting.
  const mid = (await meetings.createMeeting(db, w.maintainer.actor, { title: 'Разбор возвратов бригад за инструментом', ideaNumber: source, participants: [w.author.membershipId, f.head.membershipId, archivist.membershipId], organizerConsent: true })).body.id;
  for (const p of [w.author, f.head, archivist]) await meetings.setConsent(db, p.actor, mid, 'given');
  await meetings.addTranscript(db, w.maintainer.actor, mid, { text: '[00:00] Мария Ведущая: Начинаем разбор. Запись идёт, все согласились.\n[00:09] Кирилл Демо: За неделю бригады четыре раза возвращались за инструментом.', source: 'manual' });
  const k2 = (await legacy.register(db, w.maintainer.actor, { kind: 'decision', title: 'Сверка комплекта перед выездом', card: CARD, sources: [{ type: 'idea', number: source }, { type: 'meeting', id: mid }] })).id;
  await legacy.act(db, w.maintainer.actor, k2, { action: 'library_proposed', reason: 'Решение принято' });
  await legacy.act(db, archivist.actor, k2, { action: 'library_accepted', reason: 'Источники проверены' });
  await legacy.act(db, f.head.actor, k2, { action: 'opened_to_organization', reason: 'Вывод полезен всем' });

  // A participant sees the meeting as a branch of its own, with a link.
  const inside = (await legacy.get(db, w.author.actor, k2)).path.branches.find((b) => b.source.type === 'meeting')!;
  assert.deepEqual([inside.source.available, inside.source.link, inside.nodes.length], [true, `#/meetings/${mid}`, 1]);
  assert.match(inside.source.label, /Разбор возвратов бригад/);
  // A colleague who was not there: the branch exists and is closed; not its title, not its link, not an event.
  const outside = await legacy.get(db, w.colleague.actor, k2);
  const closed = outside.path.branches.find((b) => b.source.type === 'meeting')!;
  assert.deepEqual([closed.source.available, closed.source.link, closed.nodes.length, closed.outcome.label], [false, null, 0, 'закрыт для вас']);
  assert.doesNotMatch(JSON.stringify(outside.path), new RegExp(`Разбор возвратов|${mid}|четыре раза`), 'nothing of the closed meeting is in the path');
  // The open source of the same knowledge is still shown in full.
  assert.ok(outside.path.branches.some((b) => b.source.label === `Обращение №${source}` && b.nodes.length >= 2));
});

// ---------------------------------------------------------------------------
// «Применить этот метод»
// ---------------------------------------------------------------------------
test('starting from a method creates an ordinary item with a reference — no application, no XP, no right', async () => {
  const before = { apps: await count('knowledge_applications'), xp: await count('xp_awards'), envoy: await count('envoy_xp_awards'), transitions: await count('knowledge_transitions WHERE knowledge_id = $1', [method]) };
  const lvl = (await legacy.get(db, w.colleague.actor, method)).level;
  assert.equal((await legacy.get(db, w.colleague.actor, method)).can.apply, true);
  const made = await item(w.colleague, 'Список перед выездом для сервисных бригад', { methodId: method });

  const row = (await ownerQuery<{ knowledge_id: string; knowledge_version: number; created_by_membership_id: string }>(db, 'SELECT knowledge_id, knowledge_version, created_by_membership_id FROM idea_method_links WHERE idea_id = $1', [made.id]))[0]!;
  assert.deepEqual(row, { knowledge_id: method, knowledge_version: 1, created_by_membership_id: w.colleague.membershipId });
  const card = await getIdea(db, w.colleague.actor, made.number);
  assert.equal((card as { author: { name: string } }).author.name, 'Анна Коллега', 'the person who applies the method is the author of the new item');
  assert.deepEqual({ id: card.method?.id, title: card.method?.title, hall: card.method?.hall }, { id: method, title: 'Контрольный список перед выездом бригады', hall: 'Библиотека решений' });

  // The click is not an application and earns nothing.
  assert.deepEqual({ apps: await count('knowledge_applications'), xp: await count('xp_awards'), envoy: await count('envoy_xp_awards'), transitions: await count('knowledge_transitions WHERE knowledge_id = $1', [method]) }, before);
  const k = await legacy.get(db, w.colleague.actor, method);
  assert.equal(k.level, lvl);
  assert.equal(k.applications.length, 0, 'the existing re-applications are untouched');
  assert.deepEqual(k.path.uses.map((u) => [u.number, u.started, u.recorded, u.status.label]), [[made.number, true, false, 'Применение ещё не подтверждено']]);
  // The audit keeps the fact without anybody's text.
  const audit = await ownerQuery<{ data: Record<string, unknown> }>(db, `SELECT data FROM audit_events WHERE entity_id = $1 AND action = 'idea.started_from_method'`, [made.id]);
  assert.deepEqual(audit.map((a) => a.data), [{ number: made.number, knowledge: method }]);
  // It is an ordinary item: the same routing and the same rule «nobody decides their own item».
  await assert.rejects(wf.decide(db, w.colleague.actor, made.number, { outcome: 'merge', rationale: 'Сам подал, сам решил — так нельзя' }), codes('forbidden'));

  // A curator records the re-application through the EXISTING mechanism; it is still not confirmed until implemented.
  await legacy.addApplication(db, w.maintainer.actor, method, { ideaNumber: made.number, note: 'Метод применяется в сервисных бригадах' });
  const after = await legacy.get(db, w.colleague.actor, method);
  assert.deepEqual(after.path.uses.map((u) => [u.recorded, u.status.label]), [[true, 'Применение ещё не подтверждено']]);
  assert.equal(after.applications[0]!.implemented, false);
  // A negative result is kept as such.
  await wf.decide(db, f.head.actor, made.number, { outcome: 'reject', rationale: 'В сервисных бригадах комплект собирает кладовщик' });
  assert.deepEqual((await legacy.get(db, w.colleague.actor, method)).path.uses.map((u) => u.status), [{ tone: 'no', label: 'Не применено: по обращению решено не внедрять' }]);
});

test('what may not be applied creates nothing at all', async () => {
  const items = await count('ideas');
  // Unverified knowledge of the chronicle.
  assert.equal((await legacy.get(db, w.maintainer.actor, chronicle)).can.apply, false);
  await assert.rejects(item(w.maintainer, 'Попытка применить непроверенную запись', { methodId: chronicle }), (e: { code?: string; message?: string }) => e.code === 'validation_failed' && /только проверенное знание/.test(e.message ?? ''));
  // Knowledge of another organization, and knowledge that does not exist: the same answer, nothing revealed.
  for (const id of [method, '00000000-0000-4000-8000-000000000000']) {
    await assert.rejects(submit(db, w.outsider, { kind: 'idea', title: 'Чужое знание', proposal: 'Попытка применить знание другой организации', methodId: id }), codes('forbidden'));
  }
  assert.equal(await count('ideas'), items, 'the submission and the reference are one transaction');
  assert.equal(await count('idea_method_links WHERE knowledge_id = $1', [chronicle]), 0);
});

test('the database itself: one write path, the author only, once, append-only, no cross-tenant reference', async () => {
  const priv = await ownerQuery<{ ins: boolean; upd: boolean; del: boolean }>(db, `SELECT has_table_privilege('modus_app', 'idea_method_links', 'INSERT') AS ins, has_table_privilege('modus_app', 'idea_method_links', 'UPDATE') AS upd, has_table_privilege('modus_app', 'idea_method_links', 'DELETE') AS del`);
  assert.deepEqual(priv[0], { ins: false, upd: false, del: false });
  const mine = await item(w.author, 'Список перед выездом для монтажников');
  // Somebody else's item.
  await assert.rejects(asUser(w.colleague, 'SELECT app_idea_link_method($1, $2)', [mine.id, method]), codes('forbidden', '42501'));
  await asUser(w.author, 'SELECT app_idea_link_method($1, $2)', [mine.id, method]);
  await assert.rejects(asUser(w.author, 'SELECT app_idea_link_method($1, $2)', [mine.id, method]), codes('validation_failed', '23514'));
  // The knowledge's own source is not a new use of it.
  const src = (await ownerQuery<{ id: string }>(db, 'SELECT id FROM ideas WHERE number = $1 AND organization_id = $2', [source, w.acmeId]))[0]!.id;
  await assert.rejects(asUser(w.author, 'SELECT app_idea_link_method($1, $2)', [src, method]), codes('validation_failed', '23514'));
  // Never rewritten, even by the owner of the database.
  await assert.rejects(ownerQuery(db, 'UPDATE idea_method_links SET knowledge_id = $2 WHERE idea_id = $1', [mine.id, chronicle]));
  await assert.rejects(ownerQuery(db, 'DELETE FROM idea_method_links WHERE idea_id = $1', [mine.id]));
  // Another organization sees neither the row nor a way to point at it.
  assert.equal((await asUser(w.outsider, 'SELECT 1 FROM idea_method_links')).rowCount, 0);
  await assert.rejects(ownerQuery(db, `INSERT INTO idea_method_links (idea_id, organization_id, knowledge_id, knowledge_version, created_by_membership_id) VALUES ($1, $2, $3, 1, $4)`, [mine.id, w.betaId, method, w.outsider.membershipId]));
});

// ---------------------------------------------------------------------------
// The catalogue: pages, exact totals, the reader's rights
// ---------------------------------------------------------------------------
test('pages: a total order, no row twice or missing, exact totals that agree with the halls', async () => {
  for (let i = 0; i < 7; i++) await legacy.register(db, w.maintainer.actor, { kind: i % 2 ? 'lesson' : 'problem', title: `Запись каталога ${i + 1}`, card: CARD, sources: [{ type: 'idea', number: source }] });
  const all = await legacy.list(db, w.maintainer.actor, { limit: 60 });
  assert.equal(all.total, all.items.length);
  assert.equal(all.page.next, null);
  assert.equal(all.counts.chronicle + all.counts.library + all.counts.archive, all.total);
  assert.equal(all.allHalls, all.total);

  const seen: string[] = [];
  let offset: number | null = 0;
  let pages = 0;
  while (offset !== null) {
    const p = await legacy.list(db, w.maintainer.actor, { limit: 3, offset });
    assert.ok(p.items.length <= 3);
    assert.equal(p.total, all.total, 'the total does not depend on the page');
    seen.push(...p.items.map((i) => i.id));
    offset = p.page.next;
    assert.ok(++pages < 20);
  }
  assert.deepEqual(seen, all.items.map((i) => i.id), 'the pages are the same list in the same order');
  assert.equal(new Set(seen).size, all.total);

  // One hall: its own total; the counters of the halls stay those of the whole search.
  const lib = await legacy.list(db, w.maintainer.actor, { level: 'library', limit: 2 });
  assert.equal(lib.total, all.counts.library);
  assert.deepEqual(lib.counts, all.counts, '«во всех залах» and one hall show the same counters');
  assert.ok(lib.items.every((i) => i.level === 'library'));
  // A search together with a hall.
  const q = await legacy.list(db, w.maintainer.actor, { q: 'каталога', level: 'chronicle', limit: 4 });
  assert.equal(q.total, 7);
  assert.equal(q.counts.chronicle, 7);
  assert.equal(q.counts.library, 0);
  assert.equal(q.items.length, 4);
  assert.equal(q.page.next, 4);
  const kinds = await legacy.list(db, w.maintainer.actor, { kind: 'lesson' });
  assert.equal(kinds.total, 3);
  // Limits are checked at the border.
  assert.throws(() => legacy.ListQuery.parse({ limit: '500' }));
  assert.throws(() => legacy.ListQuery.parse({ offset: '-1' }));
  assert.deepEqual(legacy.ListQuery.parse({ limit: '12', offset: '24' }), { limit: 12, offset: 24 });
});

test('search by the number of a source item — only through items the reader may open', async () => {
  const hit = await legacy.list(db, w.maintainer.actor, { q: `№${failed}` });
  assert.ok(hit.items.some((i) => i.id === method), 'the knowledge that rests on the rejected proposal');
  assert.ok(!hit.items.some((i) => i.id === chronicle), 'knowledge that does not rest on it is not found by the number');
  assert.ok((await legacy.list(db, w.maintainer.actor, { q: String(source) })).items.some((i) => i.id === method));
  assert.equal((await legacy.list(db, w.maintainer.actor, { q: '999999' })).total, 0);
});

test('the numbers are the reader\'s own: another organization gets zero, a guest gets zero', async () => {
  const other = await legacy.list(db, w.outsider.actor, { q: 'каталога' });
  assert.deepEqual([other.items.length, other.total, other.allHalls, other.counts], [0, 0, 0, { chronicle: 0, library: 0, archive: 0 }]);
  // Knowledge visible «to those who can open every source» is not counted for somebody who cannot.
  const mine = await legacy.list(db, w.colleague.actor, {});
  const lead = await legacy.list(db, w.maintainer.actor, {});
  assert.ok(mine.total <= lead.total);
  assert.equal(mine.total, mine.counts.chronicle + mine.counts.library + mine.counts.archive);
  assert.equal(mine.items.length, Math.min(mine.total, legacy.PAGE_DEFAULT));
});
