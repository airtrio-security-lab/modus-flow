import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withAdminTx, withTx, type Database } from '../../platform/db/pool.ts';
import * as admin from '../../platform/modules/admin.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { getIdea } from '../../platform/modules/ideas.ts';
import { listInbox } from '../../platform/modules/notifications.ts';
import { analytics } from '../../platform/modules/analytics.ts';
import { searchItems, similarItems } from '../../platform/modules/search.ts';
import { SubmitInput } from '../../platform/modules/intake.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, problemText, submit } from './support/feedback.ts';

/**
 * Feedback MVP (hackathon brief + owner video): nothing gets lost, everyone
 * sees progress, the owner sees what needs attention.
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
const inboxFor = async (p: P, n: number) => (await listInbox(db, p.actor)).filter((x) => x.ideaNumber === n);
const sql = (p: P, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(text, params));
const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');

// ---------------------------------------------------------------------------
// Routing: nothing is lost
// ---------------------------------------------------------------------------
test('a category rule routes the item at registration and sets deadlines', async () => {
  const r = await submit(db, w.author, { title: 'Зависают сканеры при приёмке', categoryId: f.categories.it });
  const item = r.body.item;
  assert.equal(item.routed, true);
  assert.equal(item.status, 'in_review');
  assert.equal(item.maintainer, w.maintainer.membershipId);
  assert.equal(item.decisionOwner, w.decider.membershipId);
  const due = new Date(item.firstResponseDueAt!).getTime() - Date.now();
  assert.ok(due > 3.9 * 3600e3 && due <= 4 * 3600e3, 'first response due in 4 hours (rule SLA)');
  assert.equal((await inboxFor(w.maintainer, item.number))[0]?.event, 'idea_published');
  assert.equal((await inboxFor(w.decider, item.number))[0]?.event, 'idea_published');
  assert.equal((await inboxFor(f.head, item.number)).length, 0, 'no broadcast to unrelated leads');
});

test('without a rule the head of department leads and decides (hybrid)', async () => {
  const r = await submit(db, w.author, { title: 'Узкий проход у стеллажей', categoryId: f.categories.safety, departmentId: f.departments.sklad });
  assert.equal(r.body.item.maintainer, f.head.membershipId);
  assert.equal(r.body.item.decisionOwner, f.head.membershipId);
});

test('a more specific rule wins; equal specificity is decided by priority', async () => {
  const special = (
    await admin.createRule(db, w.admin.actor, { categoryId: f.categories.it, departmentId: f.departments.service, maintainer: f.head.membershipId, priority: 50 })
  ).id;
  const r = await submit(db, w.author, { title: 'Ноутбуки сервисников без VPN', categoryId: f.categories.it, departmentId: f.departments.service });
  assert.equal(r.body.item.maintainer, f.head.membershipId);
  await admin.setRuleActive(db, w.admin.actor, special, false);
  const r2 = await submit(db, w.author, { title: 'Ноутбуки сервисников без VPN (2)', categoryId: f.categories.it, departmentId: f.departments.service });
  assert.equal(r2.body.item.maintainer, w.maintainer.membershipId, 'deactivated rules are not used');
});

test('the author is never routed to themselves; with no candidate the item is unrouted but not lost', async () => {
  const r = await submit(db, f.head, { title: 'Не хватает тележек на складе', categoryId: f.categories.logistics, departmentId: f.departments.sklad });
  assert.equal(r.body.item.routed, false);
  assert.equal(r.body.item.status, 'unrouted');
  const n = r.body.item.number;
  assert.equal((await inboxFor(f.escalation, n))[0]?.event, 'idea_published', 'escalation contact sees unrouted items');
  assert.equal((await inboxFor(w.maintainer, n))[0]?.event, 'idea_published', 'leads triage unrouted items');
  assert.equal((await inboxFor(w.colleague, n)).length, 0);
});

test('routing cannot be forged: the database ignores client-supplied assignees and stage', async () => {
  await withTx(db, w.author.actor, async (c) => {
    const num = (await c.query<{ n: number }>('SELECT app_next_idea_number($1) AS n', [w.acmeId])).rows[0]!.n;
    const { rows } = await c.query<{ maintainer_membership_id: string | null; stage: string }>(
      `INSERT INTO ideas (organization_id, number, kind, author_membership_id, maintainer_membership_id, decision_owner_membership_id, stage, category_id)
       VALUES ($1, $2, 'problem', $3, $4, $4, 'adoption', $5) RETURNING maintainer_membership_id, stage`,
      [w.acmeId, num, w.author.membershipId, w.colleague.membershipId, f.categories.it],
    );
    assert.equal(rows[0]!.maintainer_membership_id, w.maintainer.membershipId);
    assert.equal(rows[0]!.stage, 'review');
    await c.query('ROLLBACK');
    await c.query('BEGIN');
  });
});

test('registration data (category, channel, raised by, deadlines) cannot be changed later', async () => {
  const r = await submit(db, w.author, { title: 'Неудобная форма заявки', categoryId: f.categories.it });
  const [{ id }] = (await ownerQuery<{ id: string }>(db, 'SELECT id FROM ideas WHERE number = $1', [r.body.item.number])) as [{ id: string }];
  await assert.rejects(sql(w.maintainer, `UPDATE ideas SET resolution_due_at = now() + interval '1 year' WHERE id = $1`, [id]), codes('forbidden'));
  await assert.rejects(sql(w.maintainer, `UPDATE ideas SET category_id = $2 WHERE id = $1`, [id, f.categories.safety]), codes('forbidden'));
});

// ---------------------------------------------------------------------------
// Chaotic channels: record on someone's behalf
// ---------------------------------------------------------------------------
test('a question raised at a meeting is recorded on behalf of the employee, who is credited and informed', async () => {
  const r = await submit(db, f.head, {
    title: 'Поставщики путают адрес склада',
    categoryId: f.categories.logistics,
    sourceChannel: 'meeting',
    sourceNote: 'Планёрка 10.11',
    raisedBy: w.colleague.membershipId,
  });
  const n = r.body.item.number;
  assert.equal((await inboxFor(w.colleague, n)).map((x) => x.event)[0], 'raised_on_behalf');
  const full = (await getIdea(db, w.colleague.actor, n)) as unknown as Record<string, unknown> & { contributions: { kind: string; member: string }[] };
  assert.equal((full as unknown as { sourceChannel: string }).sourceChannel, 'meeting');
  assert.equal((full as unknown as { raisedBy: string }).raisedBy, 'Анна Коллега');
  assert.ok(full.contributions.some((c: { kind: string; member: string }) => c.kind === 'issue_found' && c.member === 'Анна Коллега'));
});

test('the person a question was raised for is never its judge', async () => {
  const r = await submit(db, w.author, {
    title: 'Долгое согласование командировок',
    sourceChannel: 'email',
    raisedBy: w.decider.membershipId,
  });
  const n = r.body.item.number;
  await assert.rejects(wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId, decisionOwner: w.decider.membershipId }), codes('validation_failed'));
  await wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId, decisionOwner: f.head.membershipId });
  await assert.rejects(wf.decide(db, w.decider.actor, n, { outcome: 'reject', rationale: 'Сам поднял, сам отклонил' }), codes('forbidden'));
});

test('input rules: own question without raisedBy; raisedBy needs a channel; ideas need a proposal', () => {
  assert.throws(() => SubmitInput.parse({ kind: 'idea', title: 'Без решения', problem: problemText }), /решение/);
  assert.throws(() => SubmitInput.parse({ kind: 'problem', title: 'Чужой вопрос', problem: problemText, raisedBy: w.colleague.membershipId }), /откуда/);
  assert.ok(SubmitInput.parse({ kind: 'problem', title: 'Только проблема', problem: problemText }));
});

test('the database requires a proposal for ideas (problems may come without one)', async () => {
  await assert.rejects(submit(db, w.author, { kind: 'idea', title: 'Идея без решения' } as never), codes('validation_failed'));
  await assert.rejects(submit(db, w.author, { title: 'Свой вопрос', raisedBy: w.author.membershipId, sourceChannel: 'phone' }), codes('validation_failed'));
});

// ---------------------------------------------------------------------------
// Response tracking and the simple end-to-end path (hybrid)
// ---------------------------------------------------------------------------
test('first response is counted only from the responsible people, not colleagues or the author\'s objection', async () => {
  const n = (await submit(db, w.author, { title: 'Нет зарядок для раций', categoryId: f.categories.it })).body.item.number;
  await wf.addReview(db, w.colleague.actor, n, { kind: 'comment', body: 'У нас тоже' });
  let d = (await getIdea(db, w.author.actor, n)) as unknown as { firstResponseAt: string | null };
  assert.equal(d.firstResponseAt, null);
  await wf.addReview(db, w.maintainer.actor, n, { kind: 'comment', body: 'Принято, уточняю у закупок' });
  d = (await getIdea(db, w.author.actor, n)) as unknown as { firstResponseAt: string | null };
  assert.ok(d.firstResponseAt);
});

test('simple path: head asks a question → author clarifies → head decides with implementer → progress → implemented', async () => {
  const r = await submit(db, w.author, {
    kind: 'idea',
    title: 'Разметка зон приёмки на полу',
    proposal: 'Нанести цветную разметку зон приёмки и отгрузки, повесить таблички',
    departmentId: f.departments.sklad,
    sourceChannel: 'conversation',
    raisedBy: w.colleague.membershipId,
  });
  const n = r.body.item.number;
  const q = await wf.addReview(db, f.head.actor, n, { kind: 'request_changes', body: 'Какие зоны и сколько краски нужно?' });
  assert.equal((await getIdea(db, w.author.actor, n) as unknown as { status: string }).status, 'needs_info');
  await wf.revise(db, w.author.actor, n, {
    baseRevision: 1,
    title: 'Разметка зон приёмки на полу',
    problem: problemText,
    proposal: 'Три зоны: приёмка, контроль, отгрузка; 20 литров краски, работы в выходной',
  });
  await wf.resolveReview(db, f.head.actor, n, q.body.id, { outcome: 'resolved', note: 'Понятно, объём ясен' });
  const d = await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Дёшево и сразу снижает путаницу', implementer: w.colleague.membershipId });
  assert.equal(d.body.stage, 'adoption');
  assert.equal((await getIdea(db, w.author.actor, n) as unknown as { status: string }).status, 'in_progress');

  await assert.rejects(wf.completeImplementation(db, w.author.actor, n, { report: 'Сделал сам, честно' }), codes('forbidden'));
  await wf.addReview(db, w.colleague.actor, n, { kind: 'progress', body: 'Краска закуплена, работы в субботу' });
  // The colleague raised the question and implements it: they report progress,
  // but the head (not an originator) confirms that it is done.
  await assert.rejects(wf.completeImplementation(db, w.colleague.actor, n, { report: 'Готово, сам проверил' }), codes('forbidden'));
  const done = await wf.completeImplementation(db, f.head.actor, n, { report: 'Разметка нанесена, таблички висят, фото приложены' });
  assert.equal(done.body.status, 'implemented');

  const full = (await getIdea(db, w.author.actor, n)) as unknown as { status: string; contributions: { kind: string; member: string }[] };
  assert.equal(full.status, 'implemented');
  assert.ok(full.contributions.some((c) => c.kind === 'implementation' && c.member === 'Анна Коллега'));
  const authorEvents = (await inboxFor(w.author, n)).map((x) => x.event);
  for (const e of ['changes_requested', 'idea_merged', 'status_report', 'implemented']) assert.ok(authorEvents.includes(e as never), e);
  assert.ok((await inboxFor(w.colleague, n)).some((x) => x.event === 'assigned'));
});

test('progress reports come only from the responsible people', async () => {
  const n = (await submit(db, w.author, { title: 'Холодно в зоне упаковки', departmentId: f.departments.sklad })).body.item.number;
  await assert.rejects(wf.addReview(db, w.colleague.actor, n, { kind: 'progress', body: 'Я тут не причём, но отчитаюсь' }), codes('forbidden'));
  await wf.addReview(db, f.head.actor, n, { kind: 'progress', body: 'Заказали обогреватель, срок 3 дня' });
  assert.ok((await inboxFor(w.author, n)).some((x) => x.event === 'status_report'));
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------
test('overdue and stale items are escalated once to the owner contact and the responsible person', async () => {
  const routed = (await submit(db, w.author, { title: 'Просроченный вопрос по ИТ', categoryId: f.categories.it })).body.item.number;
  const orphan = (await submit(db, f.head, { title: 'Забытый вопрос без ответственного', categoryId: f.categories.logistics })).body.item.number;
  // Stale is measured from the responsible people's last activity (or publication), not from updated_at.
  await withAdminTx(db, async (c) => {
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(
      `UPDATE ideas SET first_response_due_at = now() - interval '1 hour', published_at = now() - interval '30 days',
                        responsible_activity_at = NULL WHERE number = ANY($1)`,
      [[routed, orphan]],
    );
  });
  const [{ n: first }] = (await ownerQuery<{ n: number }>(db, 'SELECT escalate_overdue() AS n')) as [{ n: number }];
  assert.ok(first >= 4, `first response + stale for two items, got ${first}`);
  const [{ n: again }] = (await ownerQuery<{ n: number }>(db, 'SELECT escalate_overdue() AS n')) as [{ n: number }];
  assert.equal(again, 0, 'each escalation fires once');

  assert.ok((await inboxFor(f.escalation, routed)).some((x) => x.event === 'escalated'));
  assert.ok((await inboxFor(w.maintainer, routed)).some((x) => x.event === 'escalated'));
  assert.ok((await inboxFor(w.admin, orphan)).some((x) => x.event === 'escalated'), 'unrouted items reach admins');
  const page = (await getIdea(db, w.author.actor, routed)) as unknown as { escalations: { kind: string }[]; overdueFirstResponse: boolean };
  assert.deepEqual(page.escalations.map((e) => e.kind).sort(), ['first_response', 'stale']);
  assert.equal(page.overdueFirstResponse, true);
});

// ---------------------------------------------------------------------------
// Search, similar items, analytics
// ---------------------------------------------------------------------------
test('search: Russian full text, filters, "mine" and "assigned to me"', async () => {
  await submit(db, w.colleague, { title: 'Сломался погрузчик номер три', problem: 'Погрузчики простаивают, ремонт затягивается на недели', categoryId: f.categories.logistics });
  const found = await searchItems(db, w.author.actor, { q: 'погрузчик', limit: 50 });
  assert.ok(found.some((x) => (x as { title: string }).title.includes('погрузчик')), 'morphology: погрузчик ↔ погрузчики');
  const mine = await searchItems(db, w.colleague.actor, { mine: true, limit: 50 });
  assert.ok(mine.length >= 2 && mine.every((x) => ['Анна Коллега'].includes((x as { author: string }).author) || (x as { raisedBy: string }).raisedBy === 'Анна Коллега'));
  const assigned = await searchItems(db, w.maintainer.actor, { assigned: true, limit: 50 });
  assert.ok(assigned.every((x) => (x as { maintainer: string; decisionOwner: string }).maintainer === 'Мария Ведущая'));
  const unrouted = await searchItems(db, w.admin.actor, { status: 'unrouted', limit: 50 });
  assert.ok(unrouted.every((x) => (x as { status: string }).status === 'unrouted') && unrouted.length >= 1);
});

test('similar items are suggested before creating a duplicate', async () => {
  const s = await similarItems(db, w.decider.actor, 'Зависают сканеры');
  assert.ok(s.some((x) => (x as { title: string }).title === 'Зависают сканеры при приёмке'));
});

test('analytics: leads and admins only; metrics are computed from facts', async () => {
  await assert.rejects(analytics(db, w.colleague.actor, {}), codes('forbidden'));
  const a = await analytics(db, f.escalation.actor, {});
  const total = (await ownerQuery<{ n: number }>(db, 'SELECT count(*)::int AS n FROM ideas WHERE organization_id = $1', [w.acmeId]))[0]!.n;
  assert.equal(a.totals.total, total);
  assert.ok(a.byChannel.some((x) => (x as { channel: string }).channel === 'meeting'));
  assert.ok(a.needsAttention.length >= 1, 'overdue / unrouted items surface for the owner');
  assert.ok(typeof a.metrics.shareResponded === 'number');
  const other = await analytics(db, w.outsider.actor, {});
  assert.equal(other.totals.total, 0, 'another organization sees none of it');
});

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------
test('only admins manage reference data; rule assignees must hold their roles; inactive categories are refused', async () => {
  await assert.rejects(admin.createCategory(db, w.maintainer.actor, { name: 'Чужая категория' }), codes('forbidden'));
  await assert.rejects(sql(w.maintainer, `INSERT INTO categories (organization_id, name) VALUES ($1, 'В обход')`, [w.acmeId]), codes('forbidden'));
  await assert.rejects(admin.createRule(db, w.admin.actor, { maintainer: w.colleague.membershipId }), codes('validation_failed'));
  const old = (await admin.createCategory(db, w.admin.actor, { name: 'Устаревшая' })).id;
  await admin.updateCategory(db, w.admin.actor, old, { active: false });
  await assert.rejects(submit(db, w.author, { title: 'В устаревшую категорию', categoryId: old }), codes('validation_failed'));
  const guest = await person(db, w.acmeId, 'Гость Правил', ['maintainer'], 'Внешний', 'guest');
  assert.equal((await sql(guest, 'SELECT id FROM routing_rules')).rows.length, 0, 'guests do not see routing rules');
});

test('the author of a problem answers a clarifying question with a new version without a proposal; an idea still needs one', async () => {
  const n = (await submit(db, w.author, { title: 'Пыльно в зоне упаковки', departmentId: f.departments.sklad })).body.item.number;
  const q = await wf.addReview(db, f.head.actor, n, { kind: 'request_changes', body: 'В какую смену и где именно?' });
  const r = await wf.revise(db, w.author.actor, n, {
    baseRevision: 1,
    title: 'Пыльно в зоне упаковки',
    problem: 'В ночную смену у ворот №3 пыль от картона, к утру всё в пыли',
    rationale: 'Уточнил смену и место',
  });
  assert.equal(r.body.revision, 2);
  await wf.resolveReview(db, f.head.actor, n, q.body.id, { outcome: 'resolved', note: 'Ясно, проверим вытяжку' });
  assert.equal(((await getIdea(db, w.author.actor, n)) as unknown as { status: string }).status, 'in_review');

  const idea = (
    await submit(db, w.author, { kind: 'idea', title: 'Вытяжка у ворот', proposal: 'Поставить вытяжку у ворот №3 над столами упаковки', departmentId: f.departments.sklad })
  ).body.item.number;
  await assert.rejects(
    wf.revise(db, w.author.actor, idea, { baseRevision: 1, title: 'Вытяжка у ворот', problem: problemText }),
    codes('validation_failed'),
    'an idea cannot lose its proposal',
  );
});
