import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as wf from '../../platform/modules/workflow.ts';
import * as progress from '../../platform/modules/progress.ts';
import * as envoy from '../../platform/modules/envoy.ts';
import * as titles from '../../platform/modules/titles.ts';
import { setCivilization, person as personCard } from '../../platform/modules/district.ts';
import { kingdom } from '../../platform/modules/kingdom.ts';
import { listInbox, markRead } from '../../platform/modules/notifications.ts';
import { acceptAudience, requestAudience } from '../../platform/modules/royal-audience.ts';
import { createDraft } from '../../platform/modules/lab.ts';
import { envoyRankFor, rankUpText, awardText, ENVOY_EVENTS } from '../../platform/domain/envoy.ts';
import { freshDatabase, fullDraft, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * «Путь Посла» (ADR-0032): personal envoy XP only from confirmed events, once, to the person whose
 * question it is; seven ranks computed by the server; a rank-up is a recorded event announced through
 * the shared notifications; the rank grants nothing; the castle ledger is untouched.
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

type P = { actor: typeof w.author.actor; membershipId: string };
const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: P, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(text, params));
const envoyXp = async (p: P) => (await ownerQuery<{ xp: number }>(db, 'SELECT coalesce(sum(xp), 0)::int AS xp FROM envoy_xp_awards WHERE membership_id = $1', [p.membershipId]))[0]!.xp;
const awardsOf = async (n: number) =>
  ownerQuery<{ kind: string; xp: number; membership_id: string }>(
    db,
    'SELECT a.event_kind AS kind, a.xp, a.membership_id FROM envoy_xp_awards a JOIN ideas i ON i.id = a.idea_id WHERE i.number = $1 ORDER BY a.created_at',
    [n],
  );
const castleXp = async (n: number) =>
  (await ownerQuery<{ xp: number }>(db, 'SELECT coalesce(sum(a.xp), 0)::int AS xp FROM xp_awards a JOIN ideas i ON i.id = a.idea_id WHERE i.number = $1', [n]))[0]!.xp;

/** A warehouse item decided by its head (hybrid powers) and implemented by a colleague. */
async function warehouseItem(who: P, title: string, extra: Record<string, unknown> = {}) {
  return (
    await submit(db, who, { kind: 'idea', title, proposal: 'Небольшое изменение процесса на складе без затрат', departmentId: f.departments.sklad, ...extra })
  ).body.item.number;
}
async function implemented(who: P, title: string, key?: string) {
  const n = await warehouseItem(who, title);
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Полезно и недорого для склада', implementer: w.colleague.membershipId });
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Внедрено, работает с понедельника' }, key);
  return n;
}
/**
 * An IT item (routing rule: the maintainer leads, the decision owner decides — two different people, as a
 * field measurement requires), implemented by the colleague.
 */
async function itImplemented(title: string) {
  const n = (
    await submit(db, w.author, { kind: 'idea', title, proposal: 'Небольшое изменение процесса приёмки без затрат', categoryId: f.categories.it })
  ).body.item.number;
  await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Полезно и недорого', implementer: w.colleague.membershipId });
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Внедрено, работает с понедельника' });
  return n;
}
/** Impact measurement by the colleague, started and concluded by the lead: before 40 → after `after`, lower is better. */
async function measure(n: number, after: number, conclude = true) {
  const plan = { plan: 'Сравнить время приёмки до и после', successCriteria: 'Приёмка быстрее', owner: w.colleague.membershipId };
  const v = (await wf.startImpactVerification(db, w.maintainer.actor, n, plan)).body.id;
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'baseline', body: 'Октябрь', metric: 'Время приёмки', value: 40, unit: 'мин', goal: 'decrease' });
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Ноябрь', metric: 'Время приёмки', value: after, unit: 'мин', comparable: true });
  if (conclude) await wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: after < 40 ? 'positive' : 'negative', conclusion: 'Замер окончен, результат записан' });
  return v;
}
const approval = { xp: 20, rationale: 'Время приёмки сократилось, подтверждено замером' };

test('rank table: I at 0, thresholds 20/60/140/280/500/800, VII is the top, the text names the rank reached (pure)', () => {
  assert.deepEqual([0, 19, 20, 59, 60, 139, 140, 279, 280, 499, 500, 799, 800, 5000].map((x) => envoyRankFor(x).rank), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
  assert.equal(envoyRankFor(0).name, 'Гонец');
  assert.equal(envoyRankFor(100).progress, 0.5);
  assert.deepEqual([envoyRankFor(900).next, envoyRankFor(900).progress, envoyRankFor(900).name], [null, 1, 'Посол Великого Содружества']);
  assert.equal(rankUpText(4), 'Ваш посол достиг ранга Герольда!');
  assert.equal(awardText('implementation', 20, 126), '+20 XP — подтверждено внедрение обращения №126');
  assert.equal(ENVOY_EVENTS.resolution.enabled, true, '+5 «problem resolved»: confirmed by the author (owner decision, ADR-0035)');
  assert.equal(awardText('resolution', 5, 7), '+5 XP — автор подтвердил, что проблема по обращению №7 решена');
});

test('the starting rank is always I «Гонец», with no invented history', async () => {
  const me = await envoy.myEnvoy(db, w.author.actor);
  assert.deepEqual([me.rank, me.name, me.xp, me.history, me.pending, me.ranks[0]!.reachedAt], [1, 'Гонец', 0, [], null, null]);
  const card = await personCard(db, w.colleague.actor, w.author.membershipId);
  assert.deepEqual([card.envoy.rank, card.envoy.self], [1, false]);
});

test('100 unprocessed complaints, comments, rejection, closing and withdrawn requests give 0 XP', async () => {
  const sender = await person(db, w.acmeId, 'Пётр Жалобщик', ['employee'], 'Склад');
  for (let i = 0; i < 100; i++) {
    await submit(db, sender, { kind: 'problem', title: `Жалоба на сканер номер ${i + 1}`, departmentId: f.departments.sklad });
  }
  const rejected = await warehouseItem(sender, 'Купить ещё один стеллаж');
  await wf.addReview(db, f.head.actor, rejected, { kind: 'comment', body: 'Посмотрю бюджет' });
  await wf.decide(db, f.head.actor, rejected, { outcome: 'reject', rationale: 'Места под стеллаж нет, вернёмся весной' });
  const closed = await warehouseItem(sender, 'Дубликат: стеллаж');
  await wf.decide(db, f.head.actor, closed, { outcome: 'close', rationale: 'Дубликат обращения про стеллаж' });
  const asked = await warehouseItem(sender, 'Разметка у ворот');
  const rc = await wf.addReview(db, f.head.actor, asked, { kind: 'request_changes', body: 'Уточните, какие ворота' });
  await wf.resolveReview(db, f.head.actor, asked, rc.body.id, { outcome: 'withdrawn', note: 'Уже понятно из фото' });
  assert.equal(await envoyXp(sender), 0);
  assert.equal((await envoy.myEnvoy(db, sender.actor)).rank, 1);
});

test('the King accepting the envoy at an audience brings no XP', async () => {
  await titles.assignTitle(db, w.admin.actor, w.decider.membershipId, { rank: 'king' });
  const n = await warehouseItem(w.author, 'На аудиенцию к Королю');
  const a = await requestAudience(db, w.author.actor, n);
  await acceptAudience(db, w.decider.actor, a.id);
  assert.deepEqual(await awardsOf(n), []);
  assert.equal(await envoyXp(w.author), 0);
});

test('a confirmed implementation: +20 once, to the sender, with its basis; replays and repeats add nothing', async () => {
  const key = 'complete-1';
  const n = await implemented(w.author, 'Разметка зон приёмки', key);
  await assert.rejects(wf.completeImplementation(db, w.colleague.actor, n, { report: 'Ещё раз отмечаю внедрение' }));
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Внедрено, работает с понедельника' }, key); // same key: replay
  await asUser(f.head, 'UPDATE ideas SET stage = stage WHERE number = $1 AND organization_id = app_org_id()', [n]);
  assert.deepEqual((await awardsOf(n)).map((a) => [a.kind, a.xp, a.membership_id]), [['implementation', 20, w.author.membershipId]]);
  const me = await envoy.myEnvoy(db, w.author.actor);
  assert.equal(me.xp, 20);
  assert.equal(me.history[0]!.text, `+20 XP — подтверждено внедрение обращения №${n}`);
  assert.equal(await envoyXp(w.colleague), 0, 'the implementer gets the castle its XP, not the sender’s personal award');
});

test('the castle ledger is untouched: its XP follows only its own rule, personal XP is not counted twice', async () => {
  const before = (await ownerQuery<{ n: number; xp: number }>(db, 'SELECT count(*)::int AS n, coalesce(sum(xp), 0)::int AS xp FROM xp_awards'))[0]!;
  const n = await implemented(w.author, 'Подписи на стеллажах');
  const after = (await ownerQuery<{ n: number; xp: number }>(db, 'SELECT count(*)::int AS n, coalesce(sum(xp), 0)::int AS xp FROM xp_awards'))[0]!;
  assert.deepEqual([after.n - before.n, after.xp - before.xp, await castleXp(n)], [1, 100, 100], 'one castle award of xp_per_implementation, nothing more');
  const castle = (await kingdom(db, w.colleague.actor)).castles.find((c) => c.id === f.departments.sklad)!;
  const own = (await ownerQuery<{ xp: number }>(db, 'SELECT coalesce(sum(xp), 0)::int AS xp FROM xp_awards WHERE department_id = $1', [f.departments.sklad]))[0]!.xp;
  assert.equal(castle.xp, own);
});

test('a measured positive effect: +30 once, whichever comes second — the approval or the concluded measurement', async () => {
  // Approval first, measurement concluded afterwards.
  const a = await itImplemented('Слоты для поставщиков');
  const v = await measure(a, 25, false);
  await progress.approveEffect(db, w.decider.actor, a, approval);
  assert.deepEqual((await awardsOf(a)).map((x) => x.kind), ['implementation'], 'no award before the measurement is concluded');
  await wf.concludeVerification(db, w.maintainer.actor, a, v, { outcome: 'positive', conclusion: 'Приёмка стала быстрее на 15 минут' });
  assert.deepEqual((await awardsOf(a)).map((x) => [x.kind, x.xp]), [['implementation', 20], ['effect', 30]]);
  // Measurement first, approval afterwards; a second approval is refused and adds nothing.
  const b = await itImplemented('Сканеры на зарядке у ворот');
  await measure(b, 30);
  await progress.approveEffect(db, w.decider.actor, b, approval);
  await assert.rejects(progress.approveEffect(db, w.decider.actor, b, approval), codes('conflict'));
  assert.deepEqual((await awardsOf(b)).map((x) => [x.kind, x.xp]), [['implementation', 20], ['effect', 30]]);
});

test('no personal effect XP without a measured improvement: no measurement, a worse number, or a zero bonus', async () => {
  const unmeasured = await itImplemented('Без замеров');
  await progress.approveEffect(db, w.decider.actor, unmeasured, approval);
  const worse = await itImplemented('Хуже, чем было');
  await measure(worse, 55);
  await progress.approveEffect(db, w.decider.actor, worse, approval);
  const zero = await itImplemented('Нулевой бонус');
  await measure(zero, 20);
  await progress.approveEffect(db, w.decider.actor, zero, { xp: 0, rationale: 'Эффект есть, но бонус не назначаю' });
  for (const n of [unmeasured, worse, zero]) assert.deepEqual((await awardsOf(n)).map((x) => x.kind), ['implementation']);
});

test('attribution: an item raised on behalf of a colleague credits that colleague, once, not every participant', async () => {
  const worker = await person(db, w.acmeId, 'Гульнара Кладовщик', ['employee'], 'Склад');
  const n = await warehouseItem(w.maintainer, 'Перчатки на холодном складе', { raisedBy: worker.membershipId, sourceChannel: 'meeting' });
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Нужно для холодной зоны', implementer: w.colleague.membershipId });
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Выдали перчатки всей смене' });
  assert.deepEqual((await awardsOf(n)).map((a) => [a.membership_id, a.xp]), [[worker.membershipId, 20]]);
  const k = (await kingdom(db, w.colleague.actor)).envoys;
  assert.ok(!k.some((e) => e.number === n), 'an implemented item is no longer an envoy on the road');
});

test('parallel requests: one replayed key awards once; two parallel implementations never lose a rank-up', async () => {
  const p = await person(db, w.acmeId, 'Ирина Параллельная', ['employee'], 'Склад');
  // A threshold only the sum of both awards reaches: 30 (each award alone is 20).
  await ownerQuery(db, `UPDATE organizations SET envoy_rank_thresholds = '{0,30,600,700,800,900,1000}' WHERE id = $1`, [w.acmeId]);
  try {
    const [a, b] = [await warehouseItem(p, 'Параллельно А'), await warehouseItem(p, 'Параллельно Б')];
    for (const n of [a, b]) await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Полезно и недорого', implementer: w.colleague.membershipId });
    const report = { report: 'Внедрено одновременно' };
    const same = await Promise.allSettled([
      wf.completeImplementation(db, w.colleague.actor, a, report, 'parallel-a'),
      wf.completeImplementation(db, w.colleague.actor, a, report, 'parallel-a'),
      wf.completeImplementation(db, w.colleague.actor, b, report, 'parallel-b'),
    ]);
    assert.ok(same.some((r) => r.status === 'fulfilled'), JSON.stringify(same.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok'))));
    assert.equal(await envoyXp(p), 40);
    const ups = await ownerQuery<{ rank: number }>(db, 'SELECT rank FROM envoy_rank_ups WHERE membership_id = $1', [p.membershipId]);
    assert.deepEqual(ups.map((u) => u.rank), [2], 'the crossing of 30 is seen although each transaction alone brought 20');
    const notes = await ownerQuery<{ n: number }>(db, `SELECT count(*)::int AS n FROM notifications WHERE recipient_membership_id = $1 AND event_type = 'envoy_rank_up'`, [p.membershipId]);
    assert.equal(notes[0]!.n, 1);
  } finally {
    await ownerQuery(db, `UPDATE organizations SET envoy_rank_thresholds = '{0,20,60,140,280,500,800}' WHERE id = $1`, [w.acmeId]);
  }
});

test('a rank-up is recorded once and announced to the owner; it waits unread until opened, opening awards nothing', async () => {
  const p = await person(db, w.acmeId, 'Тимур Вестник', ['employee'], 'Склад');
  const n = await implemented(p, 'Первое внедрение нового вестника');
  let me = await envoy.myEnvoy(db, p.actor);
  assert.deepEqual([me.rank, me.name, me.pending?.rank, me.pending?.text, me.pending?.number], [2, 'Вестник', 2, 'Ваш посол достиг ранга Вестника!', n]);
  assert.ok(me.ranks[1]!.reachedAt, 'the date of the rank-up is kept');
  const inbox = await listInbox(db, p.actor);
  const note = inbox.find((x) => x.event === 'envoy_rank_up')!;
  assert.equal(note.headline, 'Ваш посол получил новый ранг');
  assert.ok(!note.message.includes('Тимур'), 'no free text: rendered from the event and the item title');
  // A second look (after the next login) still shows it; reading it is the only thing the viewer does.
  assert.equal((await envoy.myEnvoy(db, p.actor)).pending?.notificationId, note.id);
  await markRead(db, p.actor, [note.id]);
  me = await envoy.myEnvoy(db, p.actor);
  assert.deepEqual([me.pending, me.xp, me.rank], [null, 20, 2]);
  // Nobody can write the ledger or the rank-ups from the app, not even for themselves.
  await assert.rejects(asUser(p, `INSERT INTO envoy_rank_ups (organization_id, membership_id, rank, xp, award_id, idea_id) SELECT organization_id, membership_id, 3, 999, id, idea_id FROM envoy_xp_awards WHERE membership_id = $1`, [p.membershipId]));
  await assert.rejects(asUser(p, `INSERT INTO envoy_xp_awards (organization_id, membership_id, idea_id, event_kind, xp, source_type, source_id) SELECT organization_id, $1, id, 'resolution', 500, 'xp_award', id FROM ideas WHERE number = $2`, [p.membershipId, n]));
});

test('the history is append-only: no update or delete, even by the schema owner', async () => {
  await assert.rejects(ownerQuery(db, `UPDATE envoy_xp_awards SET xp = 999 WHERE membership_id = $1`, [w.author.membershipId]));
  await assert.rejects(ownerQuery(db, `DELETE FROM envoy_xp_awards WHERE membership_id = $1`, [w.author.membershipId]));
  await assert.rejects(ownerQuery(db, `DELETE FROM envoy_rank_ups`));
  assert.ok((await envoy.myEnvoy(db, w.author.actor)).history.length >= 4);
});

test('a change of the department style changes the clothes, never the XP or the rank', async () => {
  const before = await envoy.myEnvoy(db, w.author.actor);
  assert.equal(before.civilization, 'camelot');
  // The author works at «Склад»; the department switches to the Kazakh Khanate.
  await setCivilization(db, w.admin.actor, f.departments.sklad, 'kazakh');
  const after = await envoy.myEnvoy(db, w.author.actor);
  assert.deepEqual([after.civilization, after.civilizationName, after.xp, after.rank], ['kazakh', 'Казахское ханство', before.xp, before.rank]);
  const onMap = (await kingdom(db, w.colleague.actor)).envoys.filter((e) => e.sender === 'Кирилл Демо');
  assert.ok(onMap.length && onMap.every((e) => e.envoyCivilization === 'kazakh' && e.envoyRank === after.rank));
  await setCivilization(db, w.admin.actor, f.departments.sklad, 'camelot');
});

test('guests and other organizations see no colleague’s envoy beyond the existing rights', async () => {
  const guest = await person(db, w.acmeId, 'Гость Ревьюер', ['decision_owner'], 'Внешние', 'guest');
  await assert.rejects(envoy.envoyOf(db, guest.actor, w.author.membershipId), codes('forbidden'));
  assert.equal((await envoy.envoyOf(db, guest.actor, guest.membershipId)).xp, 0, 'a guest sees only their own envoy');
  const raw = await asUser(guest, 'SELECT count(*)::int AS n FROM envoy_xp_awards');
  assert.equal(raw.rows[0].n, 0);
  await assert.rejects(envoy.envoyOf(db, w.outsider.actor, w.author.membershipId), codes('not_found'));
  const foreign = await asUser(w.outsider, 'SELECT count(*)::int AS n FROM envoy_xp_awards');
  assert.equal(foreign.rows[0].n, 0, 'tenant isolation');
});

test('private Personal Lab drafts never reach the map or the envoy', async () => {
  await createDraft(db, w.author.userId, { ...fullDraft, title: 'ЛИЧНОЕ: черновик про премии' });
  const k = await kingdom(db, w.colleague.actor);
  assert.ok(!JSON.stringify(k).includes('ЛИЧНОЕ'));
  const card = await envoy.envoyOf(db, w.colleague.actor, w.author.membershipId);
  assert.ok(!JSON.stringify(card).includes('ЛИЧНОЕ'));
});

test('a rank grants no power: even rank VII cannot decide, assign or approve without the role', async () => {
  const p = await person(db, w.acmeId, 'Посол Высший', ['employee'], 'Склад');
  await ownerQuery(db, `UPDATE organizations SET envoy_rank_thresholds = '{0,1,2,3,4,5,6}' WHERE id = $1`, [w.acmeId]);
  try {
    await implemented(p, 'Внедрение высшего посла');
    assert.equal((await envoy.myEnvoy(db, p.actor)).rank, 7);
    const other = await warehouseItem(w.author, 'Чужое обращение для проверки прав');
    await assert.rejects(wf.decide(db, p.actor, other, { outcome: 'merge', rationale: 'Посол высшего ранга решает' }), codes('forbidden'));
    await assert.rejects(wf.assign(db, p.actor, other, { maintainer: p.membershipId }), codes('forbidden', 'validation_failed'));
    const done = await implemented(w.author, 'Эффект для проверки прав');
    await assert.rejects(progress.approveEffect(db, p.actor, done, approval), codes('forbidden'));
    await assert.rejects(envoy.envoyOf(db, w.outsider.actor, p.membershipId), codes('not_found'));
    const roles = await ownerQuery<{ roles: string[] }>(db, 'SELECT roles FROM memberships WHERE id = $1', [p.membershipId]);
    assert.deepEqual(roles[0]!.roles, ['employee'], 'no role appears with the rank');
  } finally {
    await ownerQuery(db, `UPDATE organizations SET envoy_rank_thresholds = '{0,20,60,140,280,500,800}' WHERE id = $1`, [w.acmeId]);
  }
});

test('the map shows each envoy with its sender, rank and style; nothing else of the person', async () => {
  const n = await warehouseItem(w.author, 'Посол на дороге к Совету');
  const e = (await kingdom(db, w.colleague.actor)).envoys.find((x) => x.number === n)!;
  assert.deepEqual([e.sender, e.envoyRank, e.envoyCivilization], ['Кирилл Демо', (await envoy.myEnvoy(db, w.author.actor)).rank, 'camelot']);
  assert.ok(!('ownerId' in e), 'membership ids of senders are not exposed by the map');
  assert.ok(!('xp' in e), 'the map shows a rank, not a score');
});

// ---------------------------------------------------------------------------
// «The Living Envoy» (ADR-0036): one employee — one envoy, whatever the number of items.
// ---------------------------------------------------------------------------
test('five items of one employee: one XP profile, and all five envoys wear the same confirmed rank', async () => {
  const p = await person(db, w.acmeId, 'Нурия Пятерых', ['employee'], 'Склад');
  const open: number[] = [];
  for (let i = 1; i <= 5; i++) open.push(await warehouseItem(p, `Послание номер ${i} от Нурии`));
  const rankOnMap = async () => (await kingdom(db, w.colleague.actor)).envoys.filter((e) => open.includes(e.number)).map((e) => [e.envoyRank, e.envoyCivilization]);
  assert.deepEqual(await rankOnMap(), Array(5).fill([1, 'camelot']));
  // A sixth item is implemented: the person (not an item) gains XP and every envoy of theirs changes at once.
  await implemented(p, 'Шестое: внедрено');
  const profiles = await ownerQuery<{ n: number }>(db, 'SELECT count(DISTINCT membership_id)::int AS n FROM envoy_xp_awards a JOIN ideas i ON i.id = a.idea_id WHERE coalesce(i.raised_by_membership_id, i.author_membership_id) = $1', [p.membershipId]);
  assert.equal(profiles[0]!.n, 1, 'one ledger owner — the person');
  assert.deepEqual([(await envoy.myEnvoy(db, p.actor)).xp, (await envoy.myEnvoy(db, p.actor)).rank], [20, 2]);
  assert.deepEqual(await rankOnMap(), Array(5).fill([2, 'camelot']), 'all five envoys show the new rank');
  // No separate profile per item: the open items have no awards of their own.
  for (const n of open) assert.deepEqual(await awardsOf(n), []);
});

test('a transfer to a department of another civilization changes the clothes, never the XP, the rank or the history', async () => {
  const p = await person(db, w.acmeId, 'Ольга Переводная', ['employee'], 'Склад');
  await implemented(p, 'Внедрено до перевода');
  await setCivilization(db, w.admin.actor, f.departments.service, 'mongolia');
  const snapshot = async () => ({
    awards: await ownerQuery(db, 'SELECT id, idea_id, event_kind, xp, created_at FROM envoy_xp_awards WHERE membership_id = $1 ORDER BY id', [p.membershipId]),
    ups: await ownerQuery(db, 'SELECT id, rank, xp, created_at FROM envoy_rank_ups WHERE membership_id = $1 ORDER BY id', [p.membershipId]),
  });
  const before = { card: await envoy.myEnvoy(db, p.actor), rows: await snapshot() };
  // The transfer is a fact of the directory (provisioning), not of the game.
  await ownerQuery(db, `UPDATE memberships SET department = 'Сервис' WHERE id = $1`, [p.membershipId]);
  const after = { card: await envoy.myEnvoy(db, p.actor), rows: await snapshot() };
  assert.deepEqual([before.card.civilization, after.card.civilization], ['camelot', 'mongolia']);
  assert.deepEqual([after.card.xp, after.card.rank, after.card.history], [before.card.xp, before.card.rank, before.card.history]);
  assert.deepEqual(after.rows, before.rows, 'past records are not rewritten');
  const roles = await ownerQuery<{ roles: string[] }>(db, 'SELECT roles FROM memberships WHERE id = $1', [p.membershipId]);
  assert.deepEqual(roles[0]!.roles, ['employee'], 'rights come from the real role, not from the envoy');
  await setCivilization(db, w.admin.actor, f.departments.service, 'camelot');
});

test('a rank-up is announced once: after it was read, a reload or the next login does not replay it', async () => {
  const p = await person(db, w.acmeId, 'Марат Однажды', ['employee'], 'Склад');
  await implemented(p, 'Один раз о повышении');
  const first = await envoy.myEnvoy(db, p.actor);
  assert.equal(first.pending?.rank, 2);
  await markRead(db, p.actor, [first.pending!.notificationId]);
  for (let i = 0; i < 3; i++) assert.equal((await envoy.myEnvoy(db, p.actor)).pending, null, `reload ${i + 1}: not replayed`);
  const ups = await ownerQuery<{ n: number }>(db, 'SELECT count(*)::int AS n FROM envoy_rank_ups WHERE membership_id = $1', [p.membershipId]);
  assert.equal(ups[0]!.n, 1, 'the event itself stays recorded');
  assert.ok((await envoy.myEnvoy(db, p.actor)).ranks[1]!.reachedAt);
});

test('another organization sees neither the envoys nor the history of this one', async () => {
  const theirs = await kingdom(db, w.outsider.actor);
  assert.ok(!theirs.envoys.some((e) => e.sender === 'Кирилл Демо'));
  const raw = await asUser(w.outsider, 'SELECT count(*)::int AS n FROM envoy_rank_ups');
  assert.equal(raw.rows[0].n, 0);
});

// ---------------------------------------------------------------------------
// «Проблема решена» — подтверждает автор (ADR-0035)
// ---------------------------------------------------------------------------
async function problemImplemented(who: P, title: string, extra: Record<string, unknown> = {}) {
  const n = (await submit(db, who, { kind: 'problem', title, departmentId: f.departments.sklad, ...extra })).body.item.number;
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Устраним на складе своими силами', implementer: w.colleague.membershipId });
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Устранено, проверили на смене' });
  return n;
}

test('«problem resolved»: +5 once, only by the person whose question it is, only after a confirmed implementation', async () => {
  const p = await person(db, w.acmeId, 'Светлана Проблемная', ['employee'], 'Склад');
  const n = (await submit(db, p, { kind: 'problem', title: 'Сканер у ворот гаснет на морозе', departmentId: f.departments.sklad })).body.item.number;
  await assert.rejects(envoy.confirmResolution(db, p.actor, n, {}), codes('conflict'), 'not before the implementation is confirmed');
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Купим чехлы с подогревом', implementer: w.colleague.membershipId });
  await assert.rejects(envoy.confirmResolution(db, p.actor, n, {}), codes('conflict'), 'a decision is not an implementation');
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Чехлы надеты на все сканеры' });
  // Nobody else says it for the author: not the implementer, the lead, the decision owner or a colleague.
  for (const other of [w.colleague, f.head, w.maintainer, w.admin]) await assert.rejects(envoy.confirmResolution(db, other.actor, n, {}), codes('forbidden'));
  await assert.rejects(asUser(f.head, `INSERT INTO problem_resolutions (organization_id, idea_id, confirmed_by_membership_id) SELECT organization_id, id, $1 FROM ideas WHERE number = $2`, [f.head.membershipId, n]), 'the database refuses it too');
  const state = await envoy.problemResolution(db, p.actor, n);
  assert.deepEqual([state.applies, state.implemented, state.canConfirm, state.confirmed], [true, true, true, null]);
  const key = 'resolve-key-1';
  const first = await envoy.confirmResolution(db, p.actor, n, {}, key);
  assert.deepEqual((await envoy.confirmResolution(db, p.actor, n, {}, key)).body, first.body, 'the same key replays, nothing new');
  await assert.rejects(envoy.confirmResolution(db, p.actor, n, {}), codes('conflict'), 'a second confirmation is refused');
  assert.deepEqual((await awardsOf(n)).map((a) => [a.kind, a.xp, a.membership_id]), [['implementation', 20, p.membershipId], ['resolution', 5, p.membershipId]]);
  const me = await envoy.myEnvoy(db, p.actor);
  assert.equal(me.xp, 25);
  assert.ok(me.history.some((h) => h.text === `+5 XP — автор подтвердил, что проблема по обращению №${n} решена`));
  assert.equal(await castleXp(n), 100, 'the castle gets nothing extra for it');
  await assert.rejects(ownerQuery(db, 'DELETE FROM problem_resolutions'), 'append-only');
  const seen = await envoy.problemResolution(db, w.colleague.actor, n);
  assert.deepEqual([seen.canConfirm, seen.confirmed?.by], [false, 'Светлана Проблемная']);
});

test('«problem resolved» never for an idea, a rejected or closed problem; on behalf — the colleague confirms', async () => {
  const idea = await implemented(w.author, 'Идея, а не проблема');
  await assert.rejects(envoy.confirmResolution(db, w.author.actor, idea, {}), codes('validation_failed'));
  const p = await person(db, w.acmeId, 'Рустам Отклонённый', ['employee'], 'Склад');
  const rejected = (await submit(db, p, { kind: 'problem', title: 'Шумит вентилятор в бытовке', departmentId: f.departments.sklad })).body.item.number;
  await wf.decide(db, f.head.actor, rejected, { outcome: 'reject', rationale: 'Вентилятор заменят по плану в декабре' });
  await assert.rejects(envoy.confirmResolution(db, p.actor, rejected, {}), codes('conflict'));
  const closed = (await submit(db, p, { kind: 'problem', title: 'Дубликат про вентилятор', departmentId: f.departments.sklad })).body.item.number;
  await wf.decide(db, f.head.actor, closed, { outcome: 'close', rationale: 'Дубликат обращения про вентилятор' });
  await assert.rejects(envoy.confirmResolution(db, p.actor, closed, {}), codes('conflict'));
  assert.equal(await envoyXp(p), 0);
  // Raised on behalf: the colleague who had the problem confirms, not the person who typed it in.
  const worker = await person(db, w.acmeId, 'Айдана Со Слов', ['employee'], 'Склад');
  const n = await problemImplemented(w.maintainer, 'Нет перчаток нужного размера', { raisedBy: worker.membershipId, sourceChannel: 'meeting' });
  await assert.rejects(envoy.confirmResolution(db, w.maintainer.actor, n, {}), codes('forbidden'));
  await envoy.confirmResolution(db, worker.actor, n, {});
  assert.deepEqual((await awardsOf(n)).map((a) => [a.kind, a.membership_id]), [['implementation', worker.membershipId], ['resolution', worker.membershipId]]);
});
