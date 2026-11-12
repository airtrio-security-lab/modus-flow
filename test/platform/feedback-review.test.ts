import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as admin from '../../platform/modules/admin.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { uploadAttachment } from '../../platform/modules/attachments.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * Regression tests for the independent review of Phase 2.5 (feedback MVP),
 * docs/audit/2026-11-10-feedback-review.md. Each test reproduces an attack on
 * the database directly (as the application role), so it holds even if a
 * service-layer check is removed. Fixes: migration 0005_feedback_hardening.sql.
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
const sql = <T extends Record<string, unknown> = Record<string, unknown>>(p: P, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, async (c) => (await c.query<T>(text, params)).rows);
const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const ideaId = async (n: number) =>
  (await ownerQuery<{ id: string }>(db, 'SELECT id FROM ideas WHERE organization_id = $1 AND number = $2', [w.acmeId, n]))[0]!.id;
const row = async (n: number) =>
  (await ownerQuery<Record<string, unknown>>(db, 'SELECT * FROM ideas WHERE organization_id = $1 AND number = $2', [w.acmeId, n]))[0]!;
const suspend = (mid: string) => ownerQuery(db, `UPDATE memberships SET status = 'suspended' WHERE id = $1`, [mid]);

// ---------------------------------------------------------------------------
// C1. "Raised by" could be used to steer routing, and a false attribution
// could block a person from ever being assigned.
// ---------------------------------------------------------------------------
test('C1: naming a rule\'s maintainer as "raised by" does not skip to another rule', async () => {
  // A catch-all rule the author would prefer.
  const catchAll = (await admin.createRule(db, w.admin.actor, { maintainer: f.head.membershipId, priority: 900 })).id;
  try {
    const r = await submit(db, w.author, {
      title: 'Сканеры снова зависают',
      categoryId: f.categories.it,
      sourceChannel: 'meeting',
      raisedBy: w.maintainer.membershipId,
    });
    const i = await row(r.body.item.number);
    assert.equal(i.routing_rule_id, null, 'the IT rule is not swapped for the catch-all rule');
    assert.equal(r.body.item.routed, false, 'no department head → unrouted queue, never a hand-picked rule');
  } finally {
    await admin.setRuleActive(db, w.admin.actor, catchAll, false);
  }
});

test('C1: without a raiser, a rule with no separate decision owner still routes (NULL handling)', async () => {
  const special = (await admin.createRule(db, w.admin.actor, { categoryId: f.categories.safety, maintainer: f.head.membershipId })).id;
  try {
    const r = await submit(db, w.author, { title: 'Скользкий пол у ворот', categoryId: f.categories.safety });
    assert.equal(r.body.item.maintainer, f.head.membershipId);
    assert.equal((await row(r.body.item.number)).routing_rule_id, special);
  } finally {
    await admin.setRuleActive(db, w.admin.actor, special, false);
  }
});

test('C1: the person named as "raised by" can decline it — and only that; history keeps the revoked credit', async () => {
  const n = (await submit(db, w.author, { title: 'Долгие командировочные', sourceChannel: 'email', raisedBy: w.decider.membershipId })).body.item.number;
  const id = await ideaId(n);
  await assert.rejects(sql(w.decider, 'UPDATE ideas SET raised_by_membership_id = $2 WHERE id = $1', [id, w.colleague.membershipId]), codes('forbidden'));
  await assert.rejects(sql(w.author, 'UPDATE ideas SET raised_by_membership_id = NULL WHERE id = $1', [id]), codes('forbidden'));
  await assert.rejects(wf.declineAttribution(db, w.author.actor, n), codes('forbidden'));

  await wf.declineAttribution(db, w.decider.actor, n);
  const credit = await ownerQuery<{ status: string }>(db, `SELECT status FROM contributions WHERE idea_id = $1 AND kind = 'issue_found'`, [id]);
  assert.deepEqual(credit.map((c) => c.status), ['revoked'], 'the credit is revoked, not deleted');
  // Now the decider is no longer an originator and may be assigned to decide.
  await wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId, decisionOwner: w.decider.membershipId });
  assert.equal((await row(n)).decision_owner_membership_id, w.decider.membershipId);
});

// ---------------------------------------------------------------------------
// C2/C3. Escalations could go to suspended people or guests only.
// ---------------------------------------------------------------------------
test('C2/C3: escalation contacts and heads of department must be active employees', async () => {
  const gone = await person(db, w.acmeId, 'Уволенный Демо', ['employee', 'maintainer'], 'Склад');
  const guest = await person(db, w.acmeId, 'Гость Демо', ['maintainer'], 'Внешний', 'guest');
  await suspend(gone.membershipId);
  await assert.rejects(admin.updateSettings(db, w.admin.actor, { escalationMembershipId: gone.membershipId }), codes('validation_failed'));
  await assert.rejects(admin.createDepartment(db, w.admin.actor, { name: 'Гостевой отдел', head: guest.membershipId }), codes('validation_failed'));
  await assert.rejects(
    admin.createRule(db, w.admin.actor, { categoryId: f.categories.logistics, maintainer: w.maintainer.membershipId, escalateTo: gone.membershipId }),
    codes('validation_failed'),
  );
});

test('C2/C3: a contact suspended later gets nothing; the escalation still reaches someone active', async () => {
  const later = await person(db, w.acmeId, 'Временный Контакт', ['employee', 'decision_owner'], 'Склад');
  const rule = (await admin.createRule(db, w.admin.actor, { categoryId: f.categories.logistics, maintainer: w.maintainer.membershipId, escalateTo: later.membershipId })).id;
  try {
    const n = (await submit(db, w.author, { title: 'Не приходят машины вовремя', categoryId: f.categories.logistics })).body.item.number;
    await suspend(later.membershipId);
    await ownerQuery(db, `UPDATE ideas SET first_response_due_at = now() - interval '1 minute' WHERE id = $1`, [await ideaId(n)]);
    await ownerQuery(db, 'SELECT escalate_overdue()');
    const id = await ideaId(n);
    const esc = await ownerQuery<{ to: string | null }>(db, `SELECT escalated_to_membership_id AS to FROM escalations WHERE idea_id = $1 AND kind = 'first_response'`, [id]);
    assert.equal(esc[0]?.to, null, 'a suspended contact is not recorded as the addressee');
    const got = await ownerQuery<{ r: string }>(db, `SELECT recipient_membership_id AS r FROM notifications WHERE idea_id = $1 AND event_type = 'escalated'`, [id]);
    assert.ok(!got.some((g) => g.r === later.membershipId), 'nothing for the suspended contact');
    assert.ok(got.some((g) => g.r === w.maintainer.membershipId), 'the responsible maintainer is told');
  } finally {
    await admin.setRuleActive(db, w.admin.actor, rule, false);
  }
});

// ---------------------------------------------------------------------------
// C4/C5. Clients could rewrite time: updated_at, published_at and the stale timer.
// ---------------------------------------------------------------------------
test('C4/C5: the client cannot set updated_at; published_at and deadlines come from the database clock', async () => {
  const n = (await submit(db, w.author, { title: 'Шумит вентиляция', categoryId: f.categories.it })).body.item.number;
  const id = await ideaId(n);
  await assert.rejects(sql(w.maintainer, `UPDATE ideas SET updated_at = now() - interval '1 year' WHERE id = $1`, [id]), codes('forbidden'));

  const [ins] = await withTx(db, w.author.actor, async (c) => {
    const num = (await c.query<{ n: number }>('SELECT app_next_idea_number($1) AS n', [w.acmeId])).rows[0]!.n;
    const { rows } = await c.query<{ published_at: Date; first_response_due_at: Date; updated_at: Date }>(
      `INSERT INTO ideas (organization_id, number, kind, author_membership_id, category_id, published_at, updated_at)
       VALUES ($1, $2, 'problem', $3, $4, '2020-01-01', '2020-01-01') RETURNING published_at, first_response_due_at, updated_at`,
      [w.acmeId, num, w.author.membershipId, f.categories.it],
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    return rows;
  });
  const skew = Math.abs(ins!.published_at.getTime() - Date.now());
  assert.ok(skew < 60_000, 'a back-dated publication time is replaced by the database clock');
  assert.ok(Math.abs(ins!.updated_at.getTime() - Date.now()) < 60_000);
  const sla = ins!.first_response_due_at.getTime() - ins!.published_at.getTime();
  assert.equal(sla, 4 * 3600e3, 'the deadline is computed from the database publication time');
});

test('C4: only the responsible people reset the stale timer; nobody writes it directly', async () => {
  const n = (await submit(db, w.author, { title: 'Не работает принтер этикеток', categoryId: f.categories.it })).body.item.number;
  const id = await ideaId(n);
  await wf.addReview(db, w.colleague.actor, n, { kind: 'comment', body: 'Поддерживаю, у нас то же' });
  await wf.addReview(db, w.author.actor, n, { kind: 'comment', body: 'Напоминаю про вопрос' });
  assert.equal((await row(n)).responsible_activity_at, null, 'author and colleagues cannot keep an item "alive"');
  await sql(w.author, `UPDATE ideas SET responsible_activity_at = now() WHERE id = $1`, [id]).catch(() => undefined);
  await sql(w.maintainer, `UPDATE ideas SET responsible_activity_at = now() + interval '1 year' WHERE id = $1`, [id]).catch(() => undefined);
  assert.equal((await row(n)).responsible_activity_at, null, 'a direct write is rejected or ignored');
  await wf.addReview(db, w.maintainer.actor, n, { kind: 'comment', body: 'Взял в работу, жду картридж' });
  const at = (await row(n)).responsible_activity_at as Date | null;
  assert.ok(at && Math.abs(at.getTime() - Date.now()) < 60_000, 'the maintainer\'s answer counts as activity');
});

// ---------------------------------------------------------------------------
// Role probe across organizations (app_has_member_role).
// ---------------------------------------------------------------------------
test('role probe: role checks are scoped to the current organization', async () => {
  const [r] = await sql<{ ok: boolean }>(w.author, `SELECT app_has_member_role($1, 'maintainer') AS ok`, [w.outsider.membershipId]);
  assert.equal(r!.ok, false, 'a maintainer of another organization is not a maintainer here');
});

// ---------------------------------------------------------------------------
// C7. The raiser could approve or request changes on "their" item.
// ---------------------------------------------------------------------------
test('C7: whoever raised the item neither approves it nor requests changes on it', async () => {
  const n = (await submit(db, w.author, { title: 'Неудобный график отпусков', categoryId: f.categories.it, sourceChannel: 'phone', raisedBy: f.escalation.membershipId })).body.item.number;
  const id = await ideaId(n);
  for (const kind of ['approval', 'request_changes']) {
    await assert.rejects(
      sql(f.escalation, `INSERT INTO reviews (organization_id, idea_id, revision_number, author_membership_id, kind, body) VALUES ($1, $2, 1, $3, $4, 'Одобряю свой же вопрос')`, [
        w.acmeId,
        id,
        f.escalation.membershipId,
        kind,
      ]),
      codes('forbidden'),
      kind,
    );
  }
});

// ---------------------------------------------------------------------------
// C8/C9. Assignment and completion could be taken by the originator.
// ---------------------------------------------------------------------------
test('C8: an organization lead who raised the item cannot assign it', async () => {
  const n = (await submit(db, w.author, { title: 'Мало парковочных мест', sourceChannel: 'conversation', raisedBy: f.escalation.membershipId })).body.item.number;
  await assert.rejects(sql(f.escalation, 'UPDATE ideas SET maintainer_membership_id = $2 WHERE id = $1', [await ideaId(n), f.head.membershipId]), codes('forbidden'));
});

test('C8: the implementer is appointed only by the leads and only after a merge decision', async () => {
  const n = (await submit(db, w.author, { title: 'Нет полок для документов', categoryId: f.categories.it })).body.item.number;
  const id = await ideaId(n);
  await assert.rejects(sql(w.maintainer, 'UPDATE ideas SET implementer_membership_id = $2 WHERE id = $1', [id, w.colleague.membershipId]), codes('forbidden'));
  await assert.rejects(wf.assignImplementer(db, w.maintainer.actor, n, { implementer: w.colleague.membershipId }), codes('conflict', 'forbidden'));
});

test('C9: an implementer who raised the item cannot confirm completion themselves', async () => {
  const n = (
    await submit(db, w.author, {
      kind: 'idea',
      title: 'Крючки для касок у входа',
      proposal: 'Повесить ряд крючков у входа в цех, чтобы каски не лежали на полу',
      departmentId: f.departments.sklad,
      sourceChannel: 'conversation',
      raisedBy: w.colleague.membershipId,
    })
  ).body.item.number;
  await wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Дёшево, делаем на этой неделе', implementer: w.colleague.membershipId });
  await wf.addReview(db, w.colleague.actor, n, { kind: 'progress', body: 'Крючки куплены, повешу завтра' });
  await assert.rejects(sql(w.colleague, `UPDATE ideas SET stage = 'impact_verification' WHERE id = $1`, [await ideaId(n)]), codes('forbidden'));
  await assert.rejects(sql(w.author, `UPDATE ideas SET stage = 'impact_verification' WHERE id = $1`, [await ideaId(n)]), codes('forbidden'));
  const done = await wf.completeImplementation(db, f.head.actor, n, { report: 'Крючки висят, каски на месте' });
  assert.equal(done.body.status, 'implemented');
});

// ---------------------------------------------------------------------------
// C10. Attachments from anyone in the organization; spoofed file names.
// ---------------------------------------------------------------------------
test('C10: attachments come only from the people working on the item; no bidi tricks in file names', async () => {
  const n = (await submit(db, w.author, { title: 'Сломан турникет', categoryId: f.categories.it })).body.item.number;
  const id = await ideaId(n);
  const put = (p: P, name: string) =>
    sql(
      p,
      `INSERT INTO attachments (organization_id, idea_id, uploaded_by_membership_id, file_name, content_type, size_bytes, sha256, data)
       VALUES ($1, $2, $3, $4, 'text/plain', 0, '', $5)`,
      [w.acmeId, id, p.membershipId, name, Buffer.from('фото турникета')],
    );
  await assert.rejects(put(w.colleague, 'спам.txt'), codes('forbidden'));
  await assert.rejects(uploadAttachment(db, w.colleague.actor, n, { fileName: 'спам.txt', contentType: 'text/plain', data: Buffer.from('x') }), codes('forbidden'));
  await assert.rejects(put(w.author, 'отчёт‮txt.exe'), codes('validation_failed'));
  await put(w.author, 'фото.txt');
});

// ---------------------------------------------------------------------------
// Notification spam: a recorded fact let its author notify anyone.
// ---------------------------------------------------------------------------
test('notifications reach only the item\'s participants (or triage leads for a new item)', async () => {
  const n = (await submit(db, w.author, { title: 'Не хватает стульев в столовой', categoryId: f.categories.it })).body.item.number;
  const id = await ideaId(n);
  const [p] = await sql<{ n: number }>(w.author, `SELECT app_notify('idea_published', $1, $2, 'spam-1') AS n`, [id, [w.colleague.membershipId, w.admin.membershipId]]);
  assert.equal(p!.n, 0, 'a new item is announced only to its assignees');
  await wf.addReview(db, w.colleague.actor, n, { kind: 'comment', body: 'Да, стульев мало' });
  const [q] = await sql<{ n: number }>(w.colleague, `SELECT app_notify('comment_added', $1, $2, 'spam-2') AS n`, [id, [w.admin.membershipId, f.head.membershipId]]);
  assert.equal(q!.n, 0, 'a comment does not notify people outside the item');
  const [ok] = await sql<{ n: number }>(w.colleague, `SELECT app_notify('comment_added', $1, $2, 'ok-1') AS n`, [id, [w.author.membershipId]]);
  assert.equal(ok!.n, 1, 'participants are still notified');
});
