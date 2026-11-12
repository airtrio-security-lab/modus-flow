import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { NOTIFICATION_EVENTS } from '../../platform/domain/model.ts';
import {
  BATCH,
  BY_EVENT,
  FRESH_MS,
  NOT_CONNECTED,
  SCENES,
  TEXT_ONLY,
  continuesBatch,
  cueForAudience,
  cueForNote,
  deviceSince,
  emptyLedger,
  modeFor,
  outcomeOf,
  parseLedger,
  parseSettings,
  plan,
  remember,
  soundFor,
  type AudienceIn,
  type NoteIn,
} from '../../web/src/lib/cinematics.ts';

/**
 * Cinematic notifications (ADR-0031) without a browser or a database: which confirmed fact plays
 * which scene, to whom, once; what is never announced; how it plays on a device.
 */
const NOW = Date.parse('2026-11-13T10:00:00Z');
const ME = 'm-me';
const KING = 'm-king';
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const note = (event: string, extra: Partial<NoteIn> = {}): NoteIn => ({
  id: `n-${event}`,
  event,
  headline: `headline ${event}`,
  message: `message ${event}`,
  urgent: false,
  ideaNumber: 7,
  meetingId: null,
  knowledgeId: null,
  meeting: null,
  meetingClosed: false,
  createdAt: ago(5),
  readAt: null,
  ...extra,
});
const audience = (role: AudienceIn['role'], status: AudienceIn['status'], extra: Partial<AudienceIn> = {}): AudienceIn => ({
  id: `a-${role}-${status}`,
  ideaNumber: 12,
  title: 'Этикетки у ворот',
  role,
  status,
  requestedAt: ago(30),
  acceptedAt: status === 'accepted' ? ago(4) : null,
  ...extra,
});
const base = { notes: [] as NoteIn[], audiences: [] as AudienceIn[], membershipId: ME, currentKing: KING, ledger: emptyLedger(), since: NOW - 3600_000, now: NOW, style: 'royal' as const };

test('every connected event exists on the server, and every scene file is in the build with its poster', () => {
  const events = new Set<string>(NOTIFICATION_EVENTS);
  for (const e of [...Object.keys(BY_EVENT), ...TEXT_ONLY]) assert.ok(events.has(e), `${e} is a real notification event`);
  for (const s of Object.values(SCENES)) {
    for (const f of [s.src, s.poster]) {
      const path = `web/public${f}`;
      assert.ok(existsSync(path), `${path} exists`);
      assert.ok(statSync(path).size > 10_000 && statSync(path).size < 1_500_000, `${path} is a web-sized file`);
    }
    assert.match(s.source.sha256, /^[0-9a-f]{64}$/, `${s.id} names its original by SHA-256`);
    assert.ok(s.voice.length > 5, `${s.id} has its transcript`);
  }
  // The web versions are what docs/cinematics/manifest.json says they are.
  const manifest = JSON.parse(readFileSync('docs/cinematics/manifest.json', 'utf8')) as { scenes: { id: string; web: { sha256: string } }[] };
  for (const s of Object.values(SCENES)) {
    const m = manifest.scenes.find((x) => x.id === s.id);
    assert.ok(m, `${s.id} is in the manifest`);
    assert.equal(createHash('sha256').update(readFileSync(`web/public${s.src}`)).digest('hex'), m.web.sha256, `${s.id}: the file is the documented one`);
  }
});

test('one event, one scene; one scene, one meaning; similar files are not reused for each other', () => {
  const used = Object.values(BY_EVENT).map((r) => r.scene);
  assert.equal(new Set(used).size, used.length, 'no scene serves two events');
  // The two seal scenes: the voice decides. «Внедрение одобрено» is the merge decision, not the envoy.
  assert.equal(BY_EVENT.idea_merged!.scene, 'implementation-approved');
  assert.match(SCENES['implementation-approved'].voice, /Внедрение одобрено/);
  assert.equal(SCENES['implementation-approved'].source.file, '02_envoy_accepted.mp4');
  assert.match(SCENES['envoy-accepted'].voice, /Король принял вашего посла/);
  assert.equal(SCENES['envoy-accepted'].source.file, '08_implementation_approved.mp4');
  // Approval is not completion; completion is not a confirmed effect; Library is not the Archive.
  assert.notEqual(BY_EVENT.idea_merged!.scene, BY_EVENT.implemented!.scene);
  assert.notEqual(BY_EVENT.knowledge_in_library!.scene, BY_EVENT.knowledge_archived!.scene);
  assert.ok(!('verification_completed' in BY_EVENT), 'a completed field check is not announced as success');
  for (const e of ['meeting_started', 'contribution_confirmed', 'idea_published']) assert.ok(!(e in BY_EVENT), `${e}: no scene without a verified event`);
  assert.ok(NOT_CONNECTED.some((n) => n.file.startsWith('15_')), 'the Great Council scene is not tied to an invitation');
});

test('the confirmed fact picks the scene and the place to go after it', () => {
  const cases: [NoteIn, string | null, string][] = [
    [note('meeting_called', { meetingId: 'mt1', meeting: { cancelled: false } }), 'council-invitation', '#/meetings/mt1'],
    [note('changes_requested'), 'changes-requested', '#/items/7'],
    [note('assigned', { urgent: true }), 'assignment', '#/items/7'],
    [note('castle_level_up'), 'castle-level-up', '#/kingdom'],
    [note('idea_merged'), 'implementation-approved', '#/items/7'],
    [note('implemented'), 'implementation-completed', '#/items/7'],
    [note('knowledge_in_library', { ideaNumber: null, knowledgeId: 'k1' }), 'knowledge-in-library', '#/library/k1'],
    [note('knowledge_archived', { ideaNumber: null, knowledgeId: 'k2' }), 'knowledge-archived', '#/library/k2'],
    [note('deadline_soon', { urgent: true }), 'notification', '#/items/7'],
    [note('council_handoff', { urgent: true }), 'notification', '#/items/7'],
    [note('meeting_cancelled', { meetingId: 'mt2', meeting: { cancelled: true } }), null, '#/meetings/mt2'],
  ];
  for (const [n, scene, href] of cases) {
    const c = cueForNote(n)!;
    assert.ok(c, n.event);
    assert.equal(c.scene?.id ?? null, scene, n.event);
    assert.equal(c.href, href, n.event);
    assert.equal(c.title, n.headline, `${n.event}: the words are the server's`);
    assert.equal(c.text, n.message);
  }
  for (const e of ['comment_added', 'status_report', 'castle_xp', 'verification_completed', 'idea_rejected', 'contribution_confirmed']) assert.equal(cueForNote(note(e)), null, `${e}: inbox only`);
});

test('an invitation to a cancelled or no longer accessible meeting is not announced', () => {
  assert.equal(cueForNote(note('meeting_called', { meetingId: 'm', meeting: { cancelled: true } })), null);
  assert.equal(cueForNote(note('meeting_called', { meetingId: 'm', meeting: null, meetingClosed: true })), null);
  assert.equal(cueForNote(note('meeting_called', { meetingId: 'm', meeting: null })), null);
});

test('envoys: sent, arrived, accepted — each to its own person; accepting is not approving', () => {
  const me = { membershipId: ME, currentKing: KING };
  assert.equal(cueForAudience(audience('sender', 'requested'), me)!.scene!.id, 'envoy-sent');
  assert.equal(cueForAudience(audience('sender', 'accepted'), me)!.scene!.id, 'envoy-accepted');
  assert.match(cueForAudience(audience('sender', 'accepted'), me)!.text, /не решение/);
  assert.equal(cueForAudience(audience('king', 'requested'), me), null, 'a former King is not called');
  const king = { membershipId: KING, currentKing: KING };
  const arrived = cueForAudience(audience('king', 'requested'), king)!;
  assert.equal(arrived.scene!.id, 'envoy-arrived');
  assert.equal(arrived.href, '#/inbox', 'the King accepts in «Королевские послания», not in the scene');
  assert.equal(cueForAudience(audience('king', 'accepted'), king), null, 'the King is not told what he did');
  assert.notEqual(cueForAudience(audience('sender', 'requested'), me)!.key, cueForAudience(audience('sender', 'accepted'), me)!.key);
});

test('only unread, fresh, new on this device, never before; the most urgent first; a few at a time', () => {
  const notes = [
    note('knowledge_in_library', { id: 'k', ideaNumber: null, knowledgeId: 'k1', createdAt: ago(1) }),
    note('meeting_called', { id: 'mc', meetingId: 'mt', meeting: { cancelled: false }, createdAt: ago(20) }),
    note('castle_level_up', { id: 'cl', createdAt: ago(3) }),
    note('assigned', { id: 'as', urgent: true, createdAt: ago(10) }),
    note('changes_requested', { id: 'cr', readAt: ago(1) }),
    note('idea_merged', { id: 'old', createdAt: new Date(NOW - FRESH_MS - 60_000).toISOString() }),
    note('implemented', { id: 'pre', createdAt: new Date(base.since - 1000).toISOString() }),
  ];
  const p = plan({ ...base, notes });
  assert.deepEqual(p.show.map((c) => c.key), ['n:mc', 'n:as', 'n:cl'], 'action first, then celebration');
  assert.equal(p.show.length, BATCH);
  assert.deepEqual(p.batched.map((c) => c.key), ['n:k'], 'the rest waits in the inbox');

  let ledger = emptyLedger();
  for (const c of [...p.show, ...p.batched]) ledger = remember(ledger, c.key, 'shown');
  assert.deepEqual(plan({ ...base, notes, ledger }), { show: [], batched: [] }, 'a reload replays nothing');
  assert.deepEqual(plan({ ...base, notes, style: 'business' }), { show: [], batched: [] }, 'business wording: no scenes');
});

test('the device memory: a colleague later on the same computer sees new facts; a reseeded database starts again', () => {
  const t0 = NOW - 600_000;
  const first = deviceSince(null, 'm-a', null, t0)!;
  assert.deepEqual(first, { since: t0, members: ['m-a'] });
  assert.equal(deviceSince(first, 'm-a', null, NOW), first, 'same person: unchanged');
  assert.equal(deviceSince(first, 'm-b', null, NOW), null, 'a new person before the directory is known: wait');
  const b = deviceSince(first, 'm-b', ['m-a', 'm-b', 'm-c'], NOW)!;
  assert.equal(b.since, t0, 'same organization data: the start stays');
  assert.deepEqual(b.members, ['m-a', 'm-b']);
  const reseeded = deviceSince(b, 'm-x', ['m-x', 'm-y'], NOW)!;
  assert.deepEqual(reseeded, { since: NOW, members: ['m-x'] }, 'new member ids: seeded history is not replayed');
});

test('the ledger survives damage and stays bounded', () => {
  assert.deepEqual(parseLedger('{broken'), emptyLedger());
  assert.deepEqual(parseLedger(null), emptyLedger());
  let l = emptyLedger();
  for (let i = 0; i < 450; i++) l = remember(l, `n:${i}`, 'played');
  assert.equal(l.order.length, 400);
  assert.ok(!('n:0' in l.seen) && 'n:449' in l.seen);
  const again = remember(l, 'n:449', 'opened');
  assert.equal(again.order.length, 400);
  assert.equal(again.seen['n:449'], 'opened');
  assert.deepEqual(parseLedger(JSON.stringify(again)), again);
});

test('«Сейчас», «Позже», «Пропустить», «Открыть», «Дальше»: what is written down, and nothing else happens', () => {
  assert.equal(outcomeOf('now', false), 'opened');
  assert.equal(outcomeOf('open', false), 'opened');
  assert.equal(outcomeOf('later', false), 'later');
  assert.equal(outcomeOf('skip', false), 'skipped');
  assert.equal(outcomeOf('close', true), 'played');
  assert.equal(outcomeOf('close', false), 'skipped');
  assert.equal(outcomeOf('failed', false), 'failed');
  assert.ok(continuesBatch('next'));
  for (const a of ['now', 'later', 'skip', 'open', 'close', 'failed'] as const) assert.ok(!continuesBatch(a), `${a} ends the batch`);
});

test('how it plays: off, text, still frame for reduced motion and light graphics, video otherwise', () => {
  const on = parseSettings(null);
  const video = cueForNote(note('assigned'))!;
  const text = cueForNote(note('meeting_cancelled', { meetingId: 'm', meeting: { cancelled: true } }))!;
  assert.equal(modeFor(video, { settings: on, lite: false, reducedMotion: false }), 'video');
  assert.equal(modeFor(video, { settings: on, lite: true, reducedMotion: false }), 'still');
  assert.equal(modeFor(video, { settings: on, lite: false, reducedMotion: true }), 'still');
  assert.equal(modeFor(text, { settings: on, lite: false, reducedMotion: false }), 'text');
  assert.equal(modeFor(video, { settings: { enabled: false, sound: true }, lite: false, reducedMotion: false }), 'off');
  assert.deepEqual(parseSettings('{"enabled":false}'), { enabled: false, sound: true });
  assert.deepEqual(parseSettings('nonsense'), { enabled: true, sound: true });
});

test('sound: only if wanted, and «Милорд» only to those who chose it', () => {
  const on = parseSettings(null);
  assert.equal(soundFor(SCENES.assignment, { settings: on, addressForm: 'title' }), true);
  assert.equal(soundFor(SCENES.assignment, { settings: { enabled: true, sound: false }, addressForm: 'title' }), false);
  assert.equal(soundFor(SCENES['envoy-arrived'], { settings: on, addressForm: 'milord' }), true);
  for (const form of ['title', 'milady', 'master', 'neutral', null]) assert.equal(soundFor(SCENES['envoy-arrived'], { settings: on, addressForm: form }), false, `${form}`);
  assert.deepEqual(Object.values(SCENES).filter((s) => s.address).map((s) => s.id), ['envoy-arrived'], 'only one scene addresses the reader by a form');
});
