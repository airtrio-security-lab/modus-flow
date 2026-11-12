import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStageTransition, canMoveStage } from '../../platform/domain/lifecycle.ts';
import { can } from '../../platform/domain/policy.ts';
import { failingForGate, runChecks, type CheckInput } from '../../platform/domain/checks.ts';
import { projectPublication } from '../../platform/domain/lab.ts';
import { issueToken, verifyToken, assertSecret } from '../../platform/http/auth.ts';
import type { IdeaAccessFacts, OrgActor } from '../../platform/domain/model.ts';

const actor = (membershipId: string, roles: OrgActor['roles'] = ['employee']): OrgActor => ({
  userId: `u-${membershipId}`,
  orgId: 'org',
  membershipId,
  roles,
  access: 'member',
});
const author = actor('author');
const maintainer = actor('maint', ['employee', 'maintainer']);
const decider = actor('dec', ['employee', 'decision_owner']);
const colleague = actor('col');
const admin = actor('adm', ['employee', 'org_admin']);
const idea: IdeaAccessFacts = {
  authorMembershipId: 'author',
  maintainerMembershipId: 'maint',
  decisionOwnerMembershipId: 'dec',
  stage: 'review',
};

test('lifecycle: merge path and closed is terminal', () => {
  for (const [a, b] of [
    ['published', 'review'],
    ['review', 'verification'],
    ['verification', 'decision'],
    ['decision', 'adoption'],
    ['adoption', 'impact_verification'],
    ['impact_verification', 'closed'],
  ] as const) assert.ok(canMoveStage(a, b), `${a}→${b}`);
  assert.equal(canMoveStage('closed', 'review'), false);
  assert.equal(canMoveStage('published', 'adoption'), false, 'cannot skip review and decision');
  assert.throws(() => assertStageTransition('review', 'impact_verification'), /не допускается/);
});

test('policy: only the author edits the idea text; others suggest', () => {
  assert.ok(can(author, 'idea.revise', idea));
  assert.equal(can(maintainer, 'idea.revise', idea), false);
  assert.ok(can(maintainer, 'idea.suggest_revision', idea));
  assert.equal(can(author, 'idea.suggest_revision', idea), false);
  assert.ok(can(author, 'idea.decide_suggestion', idea));
  assert.equal(can(maintainer, 'idea.decide_suggestion', idea), false);
});

test('policy: maintainer requests changes, author may object', () => {
  assert.ok(can(maintainer, 'idea.request_changes', idea));
  assert.equal(can(colleague, 'idea.request_changes', idea), false);
  assert.equal(can(author, 'idea.request_changes', idea), false);
  assert.ok(can(author, 'idea.object', idea));
  assert.equal(can(colleague, 'idea.object', idea), false);
});

test('policy: before assignment any org maintainer may lead review', () => {
  const unassigned = { ...idea, maintainerMembershipId: null };
  assert.ok(can(maintainer, 'idea.request_changes', unassigned));
  assert.equal(can(colleague, 'idea.request_changes', unassigned), false);
});

test('policy: nobody decides on their own idea; admin has no decision power', () => {
  assert.ok(can(decider, 'idea.decide', idea));
  assert.equal(can(admin, 'idea.decide', idea), false);
  assert.equal(can(maintainer, 'idea.decide', idea), false);
  const ownIdea = { ...idea, authorMembershipId: 'dec' };
  assert.equal(can(decider, 'idea.decide', ownIdea), false);
});

test('policy: contributions are confirmed by someone else', () => {
  assert.ok(can(maintainer, 'contribution.confirm', idea, { contributorMembershipId: 'author' }));
  assert.equal(can(maintainer, 'contribution.confirm', idea, { contributorMembershipId: 'maint' }), false);
  assert.equal(can(colleague, 'contribution.confirm', idea, { contributorMembershipId: 'author' }), false);
});

test('policy: closed ideas accept no workflow actions', () => {
  const closed = { ...idea, stage: 'closed' as const };
  for (const a of ['idea.comment', 'idea.request_changes', 'idea.revise', 'verification.start', 'idea.decide'] as const) {
    assert.equal(can(maintainer, a, closed) || can(author, a, closed) || can(decider, a, closed), false, a);
  }
  assert.ok(can(colleague, 'idea.view', closed));
});

const base: CheckInput = {
  revision: { title: 'T', problem: 'x'.repeat(30), proposal: 'y'.repeat(30), successCriteria: 'Ожидание < 40 минут' },
  currentRevisionNumber: 1,
  revisionNumbers: [1],
  maintainerMembershipId: 'm',
  decisionOwnerMembershipId: 'd',
  authorMembershipId: 'a',
  openBlockingReviews: 0,
  hasHypothesisVerification: false,
  completedHypothesisVerification: false,
};

test('checks: complete proposal passes the decision gate', () => {
  const results = runChecks(base);
  assert.deepEqual(failingForGate(results, 'decide'), []);
  assert.equal(results.find((r) => r.id === 'field_verification')?.status, 'warn', 'no field data is a warning, never a pass');
});

test('checks: blocking reviews, self-maintainer and missing criteria fail', () => {
  const results = runChecks({ ...base, openBlockingReviews: 2, maintainerMembershipId: 'a', revision: { ...base.revision!, successCriteria: null } });
  const failed = results.filter((r) => r.status === 'fail').map((r) => r.id).sort();
  assert.deepEqual(failed, ['maintainer_assigned', 'no_blocking_reviews', 'success_criteria']);
  assert.ok(failingForGate(results, 'start_verification').some((r) => r.id === 'success_criteria'));
});

test('lab projection publishes only observation, proposal and pilot', () => {
  const p = projectPublication('  Заголовок  ', {
    observation: 'Наблюдение',
    proposal: 'Предложение',
    pilot: 'Критерий',
    cause: 'секрет',
    evidence: 'секрет',
    risks: 'секрет',
    notes: 'секрет',
  });
  assert.deepEqual(p, { title: 'Заголовок', problem: 'Наблюдение', proposal: 'Предложение', successCriteria: 'Критерий' });
  assert.doesNotMatch(JSON.stringify(p), /секрет/);
  assert.throws(() => projectPublication('T', { observation: 'x' }), /наблюдение и предложение/);
});

test('auth tokens: valid, tampered, expired, weak secret', () => {
  const secret = 'x'.repeat(40);
  const uid = '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';
  const t = issueToken(secret, uid, 60, 1_000_000);
  assert.equal(verifyToken(secret, t, 1_000_000)?.sub, uid);
  assert.equal(verifyToken('y'.repeat(40), t, 1_000_000), null, 'other secret');
  const [v, p, m] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', exp: 9e9 })).toString('base64url');
  assert.equal(verifyToken(secret, `${v}.${forged}.${m}`, 1_000_000), null, 'payload swap');
  assert.equal(verifyToken(secret, `${v}.${p}.${m}`, 1_000_000 + 61_000), null, 'expired');
  assert.throws(() => assertSecret('short'), /32/);
  assert.throws(() => assertSecret(undefined), /32/);
});

test('authenticator selection: explicit mode, dev tokens refused in production, OIDC not faked', async () => {
  const { authenticatorFromEnv } = await import('../../platform/http/authn.ts');
  const secret = 's'.repeat(40);
  assert.throws(() => authenticatorFromEnv({}), /must be set explicitly/);
  assert.throws(() => authenticatorFromEnv({ MODUS_AUTH_MODE: 'dev-token', NODE_ENV: 'production', MODUS_AUTH_SECRET: secret }), /not allowed/);
  assert.throws(() => authenticatorFromEnv({ MODUS_AUTH_MODE: 'oidc' }), /not implemented/);
  const a = authenticatorFromEnv({ MODUS_AUTH_MODE: 'dev-token', MODUS_AUTH_SECRET: secret });
  assert.equal(a.productionReady, false);
  const uid = '6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';
  assert.deepEqual(await a.authenticate(issueToken(secret, uid)), { userId: uid });
  assert.equal(await a.authenticate('garbage'), null);
});

test('recurring problems: a group of similar items is shown once, not again from each member', async () => {
  const { distinctClusters } = await import('../../platform/modules/analytics.ts');
  const rows = [
    { anchorNumber: 16, similarNumbers: [17, 18] },
    { anchorNumber: 2, similarNumbers: [8] },
    { anchorNumber: 17, similarNumbers: [18] },
  ];
  assert.deepEqual(distinctClusters(rows).map((r) => r.anchorNumber), [16, 2]);
});
