import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as meetings from '../../platform/modules/meetings.ts';
import * as titles from '../../platform/modules/titles.ts';
import * as council from '../../platform/modules/council.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { getPreferences, listInbox, savePreferences } from '../../platform/modules/notifications.ts';
import { freshDatabase, ownerQuery, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * «Королевские послания» (ADR-0016): wording follows the reader's title and own choice,
 * the business text is always there, titles grant nothing, every message comes from a
 * real event, repeats do not duplicate, and nobody reads what they cannot open.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
const none: meetings.MeetingDeps = { model: null, engine: null };

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  // f.escalation: owner (decision_owner + org_admin) — the King; f.head: head of «Склад».
  await titles.assignTitle(db, w.admin.actor, f.escalation.membershipId, { rank: 'king' });
  await titles.assignTitle(db, w.admin.actor, w.decider.membershipId, { rank: 'regent' });
  await titles.setGuildTitles(db, w.admin.actor, f.departments.sklad, { titles: ['Хранитель крепости', 'Мастер запасов', 'Смотритель'] });
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: { actor: typeof w.author.actor }, sql: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(sql, params));
const latest = async (p: { actor: typeof w.author.actor }, event: string) => (await listInbox(db, p.actor)).find((n) => n.event === event);
const itItem = async (title: string) =>
  (await submit(db, w.author, { kind: 'idea', title, proposal: 'Перевести печать этикеток на общий сервер печати', categoryId: f.categories.it, departmentId: f.departments.sklad })).body.item.number;

test('the King calls the council: personal address, details, reason, required participation', async () => {
  const n = await itItem('Общий сервер печати этикеток');
  await savePreferences(db, f.head.actor, { style: 'royal', addressForm: 'milord', groupRepeats: true, muted: [] });
  const at = '2026-11-14T10:00:00+05:00';
  const id = (
    await meetings.createMeeting(db, f.escalation.actor, {
      title: 'Сервер печати: решение по складу',
      ideaNumber: n,
      scheduledAt: at,
      participants: [f.head.membershipId, w.maintainer.membershipId, w.decider.membershipId, w.author.membershipId],
      organizerConsent: true,
    })
  ).body.id;
  const head = (await latest(f.head, 'meeting_called'))!;
  assert.equal(head.headline, 'Король созывает Совет');
  assert.equal(
    head.royal,
    'Милорд, вас призывают к Круглому столу! Совет собирается для рассмотрения вопроса: «Сервер печати: решение по складу». Ваше мнение необходимо для принятия решения.',
  );
  assert.match(head.message, /^Собственник Демо созывает заседание «Сервер печати: решение по складу»/);
  assert.deepEqual(
    [head.meeting?.organizer, head.meeting?.scheduledAt, head.meeting?.ideaNumber, head.meeting?.required, head.meeting?.reason],
    ['Собственник Демо', new Date(at).toISOString(), n, true, 'вы глава подразделения, решение касается нескольких замков'],
  );
  assert.equal(head.meeting?.action, 'Подтвердите участие и ответьте, согласны ли вы на запись');
  // Each reader is addressed by their own title or choice; reasons are personal.
  assert.match((await latest(w.decider, 'meeting_called'))!.royal!, /^Регент, /);
  assert.equal((await latest(w.decider, 'meeting_called'))!.meeting?.reason, 'вы принимаете решение по этому обращению');
  assert.equal((await latest(w.maintainer, 'meeting_called'))!.meeting?.reason, 'вы ведёте это обращение');
  const author = (await latest(w.author, 'meeting_called'))!;
  assert.match(author.royal!, /^Смотритель, /);
  assert.equal(author.meeting?.reason, 'вы подняли этот вопрос');
  // Attendance answers.
  await meetings.setAttendance(db, f.head.actor, id, 'confirmed');
  await meetings.setAttendance(db, w.author.actor, id, 'declined');
  assert.equal((await latest(f.head, 'meeting_called'))!.meeting?.attendance, 'confirmed');
  const view = await meetings.getMeeting(db, f.escalation.actor, id, none);
  assert.deepEqual(view.participants.map((p: { name: string; attendance: string }) => [p.name, p.attendance]).sort(), [
    ['Кирилл Демо', 'declined'],
    ['Мария Ведущая', 'pending'],
    ['Начальник Склада', 'confirmed'],
    ['Олжас Решающий', 'pending'],
    ['Собственник Демо', 'confirmed'],
  ]);
});

test('the headline never imitates the King; an invitation without authority is not called required', async () => {
  // A maintainer (no decision rights, not the castle head) calls a small council of «Склад».
  const id = (
    await meetings.createMeeting(db, w.maintainer.actor, { title: 'Малый совет склада', departmentId: f.departments.sklad, participants: [w.colleague.membershipId], organizerConsent: true })
  ).body.id;
  const msg = (await listInbox(db, w.colleague.actor)).find((x) => x.meetingId === id)!;
  assert.equal(msg.headline, 'Созван малый совет замка');
  assert.equal(msg.meeting?.required, false);
  assert.match(msg.royal!, /участие — по желанию/);
  // A «King» title on an employee is just words: no right to call a meeting appears.
  await titles.assignTitle(db, w.admin.actor, w.colleague.membershipId, { rank: 'king' });
  await assert.rejects(meetings.createMeeting(db, w.colleague.actor, { title: 'Указ', participants: [w.author.membershipId], organizerConsent: true }), codes('forbidden'));
  await titles.assignTitle(db, w.admin.actor, f.escalation.membershipId, { rank: 'king' });
});

test('business style: no game wording, a plain headline, the same facts', async () => {
  await savePreferences(db, w.colleague.actor, { style: 'business', addressForm: 'neutral', groupRepeats: false, muted: [] });
  const msg = (await listInbox(db, w.colleague.actor)).find((x) => x.event === 'meeting_called')!;
  assert.equal(msg.royal, null);
  assert.equal(msg.headline, 'Приглашение на заседание');
  assert.match(msg.message, /созывает заседание/);
  const p = await getPreferences(db, w.colleague.actor);
  assert.equal(p.address, 'Коллега');
  assert.deepEqual(p.channels.map((c) => [c.id, c.available]), [['app', true], ['email', false], ['messenger', false]]);
});

test('reschedule: one message per new time; cancel: one message, then the meeting takes no answers', async () => {
  const id = (await meetings.createMeeting(db, w.decider.actor, { title: 'Перенос и отмена', participants: [w.author.membershipId], organizerConsent: true })).body.id;
  await assert.rejects(meetings.reschedule(db, w.author.actor, id, { scheduledAt: '2026-11-15T09:00:00Z' }), codes('forbidden', 'not_found'));
  await meetings.reschedule(db, w.decider.actor, id, { scheduledAt: '2026-11-15T09:00:00Z' });
  await meetings.reschedule(db, w.decider.actor, id, { scheduledAt: '2026-11-15T09:00:00Z' });
  await meetings.reschedule(db, w.decider.actor, id, { scheduledAt: '2026-11-16T09:00:00Z' });
  const moved = (await listInbox(db, w.author.actor)).filter((x) => x.meetingId === id && x.event === 'meeting_rescheduled');
  assert.equal(moved.length, 2);
  await meetings.cancel(db, w.decider.actor, id, { reason: 'Вопрос решён без заседания' });
  await meetings.cancel(db, w.decider.actor, id, { reason: 'Повторная отмена' });
  const cancelled = (await listInbox(db, w.author.actor)).filter((x) => x.meetingId === id && x.event === 'meeting_cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]!.meeting?.cancelled, true);
  assert.equal(cancelled[0]!.meeting?.action, 'Ничего делать не нужно: заседание отменено');
  await assert.rejects(meetings.setAttendance(db, w.author.actor, id, 'confirmed'));
  await assert.rejects(meetings.setConsent(db, w.author.actor, id, 'given'));
  await assert.rejects(meetings.startRecording(db, w.decider.actor, id));
  // A forged «called» after cancellation is refused by the database.
  await assert.rejects(asUser(w.decider, `SELECT app_notify_meeting('meeting_called', $1, $2::uuid[], 'again')`, [id, [w.author.membershipId]]));
});

test('a removed participant loses access and gets no further messages; the invitation does not leak the meeting', async () => {
  const id = (await meetings.createMeeting(db, w.maintainer.actor, { title: 'Состав меняется', participants: [w.author.membershipId, w.colleague.membershipId], organizerConsent: true })).body.id;
  await assert.rejects(meetings.setParticipant(db, w.author.actor, id, { membershipId: w.colleague.membershipId, present: false }));
  await meetings.setParticipant(db, w.maintainer.actor, id, { membershipId: w.colleague.membershipId, present: false });
  await assert.rejects(meetings.getMeeting(db, w.colleague.actor, id, none), codes('not_found'));
  const old = (await listInbox(db, w.colleague.actor)).find((x) => x.meetingId === id)!;
  assert.deepEqual([old.meeting, old.meetingClosed], [null, true]);
  assert.ok(!old.message.includes('Состав меняется') && !(old.royal ?? '').includes('Состав меняется'));
  await meetings.reschedule(db, w.maintainer.actor, id, { scheduledAt: '2026-11-20T09:00:00Z' });
  assert.equal((await listInbox(db, w.colleague.actor)).filter((x) => x.meetingId === id && x.event === 'meeting_rescheduled').length, 0);
  assert.equal((await listInbox(db, w.author.actor)).filter((x) => x.meetingId === id && x.event === 'meeting_rescheduled').length, 1);
  // Recording needs only the active participants' consent.
  await meetings.setConsent(db, w.author.actor, id, 'given');
  assert.ok((await meetings.startRecording(db, w.maintainer.actor, id)).recordingStartedAt);
  await assert.rejects(meetings.setParticipant(db, w.maintainer.actor, id, { membershipId: w.colleague.membershipId, present: true }));
});

test('decisions and deadlines cannot be switched off; optional messages can', async () => {
  const saved = await savePreferences(db, w.author.actor, { style: 'royal', addressForm: 'title', groupRepeats: true, muted: ['castle_xp', 'idea_merged', 'meeting_called'] });
  assert.deepEqual(saved.muted, ['castle_xp']);
  const enabled = async (event: string) => (await asUser(w.author, 'SELECT app_notification_enabled($1, $2, NULL) AS e', [w.author.membershipId, event])).rows[0].e;
  assert.equal(await enabled('castle_xp'), false);
  // Even a row written directly cannot silence a mandatory event.
  await asUser(w.author, `INSERT INTO notification_subscriptions (organization_id, membership_id, event_type, enabled) VALUES ($1, $2, 'idea_merged', false)`, [w.acmeId, w.author.membershipId]);
  assert.equal(await enabled('idea_merged'), true);
  await savePreferences(db, w.author.actor, { style: 'royal', addressForm: 'title', groupRepeats: true, muted: [] });
});

test('council participants receive the decision; XP and deadline messages come once', async () => {
  const n = await itItem('Принтеры у каждых ворот');
  await council.addEntry(db, w.colleague.actor, n, { kind: 'argument_for', body: 'Сократит очереди у принтера' });
  await council.addEntry(db, f.head.actor, n, { kind: 'argument_against', body: 'Нужен запасной принтер' });
  await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Совет за, запасной принтер учтён', implementer: w.colleague.membershipId });
  for (const p of [w.colleague, f.head, w.author]) {
    const d = await latest(p, 'idea_merged');
    assert.ok(d, 'decision reaches every council participant');
    // Royal or business wording depending on each reader's own choice (Анна chose the business style above).
    assert.equal(d!.headline, p === w.colleague ? 'Решение принято' : 'Решение зафиксировано');
  }
  assert.ok(await latest(w.colleague, 'assigned'));
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Принтеры у ворот работают' });
  const xp = (await listInbox(db, w.author.actor)).filter((x) => x.event === 'castle_xp' && x.ideaNumber === n);
  assert.equal(xp.length, 1);
  assert.match(xp[0]!.royal!, /ваш замок получил опыт/);
  // A forged XP message from someone unrelated is refused.
  const [idea] = await ownerQuery<{ id: string }>(db, 'SELECT id FROM ideas WHERE number = $1 AND organization_id = $2', [n, w.acmeId]);
  await assert.rejects(asUser(w.author, `SELECT app_notify('castle_xp', $1, $2::uuid[], 'fake')`, [idea!.id, [w.colleague.membershipId]]));

  const m = await itItem('Срок близко');
  await ownerQuery(db, `UPDATE ideas SET resolution_due_at = now() + interval '3 hours' WHERE number = $1 AND organization_id = $2`, [m, w.acmeId]);
  const first = (await ownerQuery<{ n: number }>(db, 'SELECT notify_deadlines_soon() AS n'))[0]!.n;
  const again = (await ownerQuery<{ n: number }>(db, 'SELECT notify_deadlines_soon() AS n'))[0]!.n;
  assert.ok(first >= 2);
  assert.equal(again, 0);
  const soon = (await listInbox(db, w.decider.actor)).find((x) => x.event === 'deadline_soon' && x.ideaNumber === m)!;
  assert.deepEqual([soon.headline, soon.urgent, soon.category], ['Приближается срок', true, 'deadlines']);
  assert.match(soon.message, /Срок решения по «Срок близко» наступает в ближайшие сутки/);
});

test('nobody reads another person’s messages', async () => {
  assert.equal((await asUser(w.outsider, 'SELECT 1 FROM notifications')).rowCount, 0);
  const mine = (await asUser(w.colleague, 'SELECT DISTINCT recipient_membership_id AS r FROM notifications')).rows;
  assert.deepEqual(mine.map((r) => r.r), mine.length ? [w.colleague.membershipId] : []);
});
