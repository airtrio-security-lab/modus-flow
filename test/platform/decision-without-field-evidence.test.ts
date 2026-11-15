import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, failingForGate, type CheckInput } from '../../platform/domain/checks.ts';
import { canMoveStage } from '../../platform/domain/lifecycle.ts';

/**
 * Regression characterization: decision readiness is NOT evidence of impact.
 * This test documents current behavior; follow-up integration tests must verify
 * that no XP or verified-impact record is emitted without independent proof.
 */
const input: CheckInput = {
  revision: {
    title: 'Reduce waiting time',
    problem: 'Customers wait too long during peak hours',
    proposal: 'Introduce a separate express service queue',
    successCriteria: 'Median wait under 20 minutes',
  },
  currentRevisionNumber: 1,
  revisionNumbers: [1],
  maintainerMembershipId: 'maintainer',
  decisionOwnerMembershipId: 'decider',
  authorMembershipId: 'author',
  openBlockingReviews: 0,
  hasHypothesisVerification: false,
  completedHypothesisVerification: false,
};

test('no field verification is an explicit warning, never a passed check', () => {
  const checks = runChecks(input);
  const field = checks.find((x) => x.id === 'field_verification');
  assert.equal(field?.status, 'warn');
  assert.match(field?.message ?? '', /не проводилась/);
});

test('decision gate can be ready without field verification (current policy)', () => {
  const checks = runChecks(input);
  assert.deepEqual(failingForGate(checks, 'decide'), []);
});

test('decision and adoption are distinct from verified impact', () => {
  assert.equal(canMoveStage('decision', 'adoption'), true);
  assert.equal(canMoveStage('decision', 'impact_verification'), false);
  assert.equal(canMoveStage('adoption', 'impact_verification'), true);
  assert.equal(canMoveStage('adoption', 'closed'), true);
});

test('unresolved blocking review prevents decision readiness', () => {
  const checks = runChecks({ ...input, openBlockingReviews: 1 });
  assert.ok(failingForGate(checks, 'decide').some((x) => x.id === 'no_blocking_reviews'));
});
