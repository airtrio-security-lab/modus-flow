import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import { getIdea } from '../../platform/modules/ideas.ts';
import { listInbox } from '../../platform/modules/notifications.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { freshDatabase, ownerQuery, world } from './support/db.ts';
import { ideaInReview, ideaInVerification } from './support/flow.ts';

/**
 * «Ваш вклад признан» (ADR-0042, migration 0023). The item's maintainer or decision owner confirms a
 * recorded contribution of someone else; the contributor — and only they — is told once. Authorship
 * is never «confirmed», a verification only after it is completed, nobody confirms their own, and
 * nothing here awards XP, moves a stage or grants a right. The database holds the same rules.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
type P = typeof w.author;
const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const sql = (p: P, text: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(text, params));
interface Credit { id: string; kind: string; status: string; member: string; membershipId: string; confirmedBy: string | null; confirmedAt: string | null; canConfirm: boolean }
const credits = async (who: P, n: number) => (await getIdea(db, who.actor, n)).contributions as unknown as Credit[];
const xp = async () => Number((await ownerQuery<{ c: string }>(db, 'SELECT count(*) AS c FROM xp_awards'))[0]!.c);
const confirmed = async (who: P) => (await listInbox(db, who.actor)).filter((x) => x.event === 'contribution_confirmed');

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
});
after(async () => drop());

test('the decision owner confirms a colleague\'s review; the colleague is told once, nobody else; no XP, no stage change', async () => {
  const n = await ideaInReview(db, w, 'Слоты разгрузки — отзыв коллеги');
  await wf.addReview(db, w.colleague.actor, n, { kind: 'approval', body: 'Поддерживаю: на рампе №2 это сработает' });
  const review = (await credits(w.decider, n)).find((c) => c.kind === 'review')!;
  assert.equal(review.status, 'recorded');
  assert.equal(review.canConfirm, true, 'the decision owner may confirm it');
  assert.equal((await credits(w.colleague, n)).find((c) => c.kind === 'review')!.canConfirm, false, 'the contributor never confirms their own');
  assert.equal((await credits(w.author, n)).find((c) => c.kind === 'review')!.canConfirm, false, 'the author leads nothing here');
  const stage = (await getIdea(db, w.author.actor, n)).stage;
  const before = await xp();

  const r = await wf.confirmContribution(db, w.decider.actor, n, review.id, 'confirm-key-000001');
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'confirmed');
  // The same request again is a replay; a new request is a conflict, never a second message.
  const again = await wf.confirmContribution(db, w.decider.actor, n, review.id, 'confirm-key-000001');
  assert.equal(again.replayed, true);
  await assert.rejects(wf.confirmContribution(db, w.maintainer.actor, n, review.id), codes('conflict'));

  const seen = (await credits(w.colleague, n)).find((c) => c.kind === 'review')!;
  assert.deepEqual([seen.status, seen.confirmedBy, seen.canConfirm], ['confirmed', 'Олжас Решающий', false]);
  assert.ok(seen.confirmedAt);
  const note = await confirmed(w.colleague);
  assert.equal(note.length, 1, 'the contributor is told exactly once');
  assert.equal(note[0]!.headline.length > 0, true);
  assert.equal(note[0]!.ideaNumber, n);
  for (const other of [w.author, w.maintainer, w.decider, w.admin]) assert.equal((await confirmed(other)).length, 0);
  assert.equal(await xp(), before, 'confirming a contribution awards no XP');
  assert.equal((await getIdea(db, w.author.actor, n)).stage, stage, 'and moves no stage');
  const audit = await ownerQuery<{ c: string }>(db, `SELECT count(*) AS c FROM audit_events WHERE action = 'contribution.confirmed'`);
  assert.equal(Number(audit[0]!.c), 1);
});

test('only the item\'s leads confirm; the author, a colleague, the admin and another organization cannot', async () => {
  const n = await ideaInReview(db, w, 'Слоты разгрузки — кто подтверждает');
  await wf.addReview(db, w.colleague.actor, n, { kind: 'approval', body: 'Поддерживаю, проверено на смене' });
  const id = (await credits(w.maintainer, n)).find((c) => c.kind === 'review')!.id;
  for (const p of [w.author, w.colleague, w.admin]) await assert.rejects(wf.confirmContribution(db, p.actor, n, id), codes('forbidden'));
  await assert.rejects(wf.confirmContribution(db, w.outsider.actor, n, id), codes('not_found', 'forbidden'));
  // The maintainer is a lead too.
  assert.equal((await wf.confirmContribution(db, w.maintainer.actor, n, id)).body.status, 'confirmed');
});

test('authorship is not confirmed; a verification only once it is completed', async () => {
  const { n, v } = await ideaInVerification(db, w, 'Слоты разгрузки — проверка');
  const list = await credits(w.decider, n);
  const authorship = list.find((c) => c.kind === 'authorship')!;
  const verification = list.find((c) => c.kind === 'verification')!;
  assert.equal(authorship.canConfirm, false);
  assert.equal(verification.canConfirm, false, 'a running verification is not yet a contribution to confirm');
  await assert.rejects(wf.confirmContribution(db, w.decider.actor, n, authorship.id), codes('validation_failed'));
  await assert.rejects(wf.confirmContribution(db, w.decider.actor, n, verification.id), codes('validation_failed'));

  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Ожидание сократилось', metric: 'ожидание', value: 35, unit: 'мин' });
  await wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'positive', conclusion: 'Пилот подтвердил гипотезу, ожидание меньше 40 минут' });
  assert.equal((await credits(w.decider, n)).find((c) => c.kind === 'verification')!.canConfirm, true);
  await wf.confirmContribution(db, w.decider.actor, n, verification.id);
  assert.equal((await confirmed(w.colleague)).some((x) => x.ideaNumber === n), true);
});

test('the database holds the rules without the service', async () => {
  const { n } = await ideaInVerification(db, w, 'Слоты разгрузки — прямой SQL');
  await wf.addReview(db, w.colleague.actor, n, { kind: 'approval', body: 'Поддерживаю это предложение' });
  const list = await credits(w.decider, n);
  const by = (k: string) => list.find((c) => c.kind === k)!.id;
  const confirm = (p: P, id: string, as = p.membershipId) =>
    sql(p, `UPDATE contributions SET status = 'confirmed', confirmed_by_membership_id = $2, confirmed_at = now() WHERE id = $1`, [id, as]);
  // Authorship and a running verification: refused even for the decision owner.
  await assert.rejects(confirm(w.decider, by('authorship')), codes('validation_failed'));
  await assert.rejects(confirm(w.decider, by('verification')), codes('validation_failed'));
  // Not a lead of the item, in someone else's name, or one's own: refused by RLS / CHECK.
  await assert.rejects(confirm(w.author, by('review')), codes('forbidden'), 'the author is not a lead');
  await assert.rejects(confirm(w.maintainer, by('review'), w.decider.membershipId), codes('forbidden'), 'not in someone else\'s name');
  await assert.rejects(confirm(w.colleague, by('review')), codes('forbidden', 'validation_failed'), 'nobody confirms their own');
  // A message needs a confirmed row by the caller.
  await assert.rejects(sql(w.decider, 'SELECT app_notify_contribution($1)', [by('review')]), codes('forbidden'));
  await confirm(w.decider, by('review'));
  await assert.rejects(sql(w.maintainer, 'SELECT app_notify_contribution($1)', [by('review')]), codes('forbidden'), 'only the one who confirmed sends it');
  const n1 = (await sql(w.decider, 'SELECT app_notify_contribution($1) AS n', [by('review')])).rows[0].n;
  const n2 = (await sql(w.decider, 'SELECT app_notify_contribution($1) AS n', [by('review')])).rows[0].n;
  assert.deepEqual([n1, n2], [1, 0], 'deduplicated');
  // The time is the database's, not the caller's.
  const t = await ownerQuery<{ ok: boolean }>(db, `SELECT confirmed_at > now() - interval '1 minute' AS ok FROM contributions WHERE id = $1`, [by('review')]);
  assert.equal(t[0]!.ok, true);
  // Confirmed contributions from workflow facts stay: they cannot be revoked afterwards.
  await assert.rejects(
    sql(w.decider, `UPDATE contributions SET status = 'revoked', revoked_reason = 'Передумали подтверждать вклад' WHERE id = $1`, [by('review')]),
    codes('conflict'),
  );
});
