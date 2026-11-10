/**
 * Idea Verification Engine — level 1: automated checks ("CI for ideas").
 *
 * These checks only say whether a proposal is *ready* to be verified or decided.
 * They never claim that an idea works: field verification (level 2) is a
 * separate, human process with recorded evidence and a reviewer's conclusion.
 */
export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  message: string;
}

export interface CheckInput {
  revision: { title: string; problem: string; proposal: string | null; successCriteria: string | null } | null;
  /** Problems may be reported without a proposed solution. Defaults to 'idea'. */
  kind?: 'idea' | 'problem';
  currentRevisionNumber: number;
  revisionNumbers: readonly number[];
  maintainerMembershipId: string | null;
  decisionOwnerMembershipId: string | null;
  authorMembershipId: string;
  openBlockingReviews: number;
  hasHypothesisVerification: boolean;
  completedHypothesisVerification: boolean;
}

export type CheckGate = 'start_verification' | 'decide';

const MIN_PROBLEM = 20;
const MIN_PROPOSAL = 20;

export function runChecks(input: CheckInput): CheckResult[] {
  const r = input.revision;
  const results: CheckResult[] = [];
  const push = (id: string, ok: boolean, okMsg: string, failMsg: string, soft = false) =>
    results.push({ id, status: ok ? 'pass' : soft ? 'warn' : 'fail', message: ok ? okMsg : failMsg });

  push(
    'completeness',
    !!r &&
      r.problem.trim().length >= MIN_PROBLEM &&
      (input.kind === 'problem' || (r.proposal ?? '').trim().length >= MIN_PROPOSAL),
    'Проблема и предложение описаны',
    `Опишите проблему и предложение (не менее ${MIN_PROBLEM} символов каждое)`,
  );
  push(
    'success_criteria',
    !!r?.successCriteria && r.successCriteria.trim().length >= 10,
    'Критерии успеха указаны',
    'Не указаны критерии успеха — по ним будет оцениваться проверка',
  );
  push(
    'maintainer_assigned',
    input.maintainerMembershipId !== null && input.maintainerMembershipId !== input.authorMembershipId,
    'Назначен ведущий (maintainer)',
    'Не назначен ведущий, независимый от автора',
  );
  push(
    'decision_owner_assigned',
    input.decisionOwnerMembershipId !== null && input.decisionOwnerMembershipId !== input.authorMembershipId,
    'Назначен ответственный за решение',
    'Не назначен ответственный за решение, независимый от автора',
  );
  push(
    'no_blocking_reviews',
    input.openBlockingReviews === 0,
    'Нет незакрытых блокирующих замечаний',
    `Незакрытых блокирующих замечаний: ${input.openBlockingReviews}`,
  );
  push(
    'revision_consistency',
    input.revisionNumbers.includes(input.currentRevisionNumber),
    'Текущая версия согласована с историей',
    'Текущая версия отсутствует в истории изменений',
  );
  push(
    'field_verification',
    input.completedHypothesisVerification,
    'Есть завершённая полевая проверка',
    input.hasHypothesisVerification
      ? 'Полевая проверка ещё не завершена'
      : 'Полевая проверка не проводилась — решение будет принято без экспериментальных данных',
    true,
  );
  return results;
}

/** Which checks must pass before a given workflow step. */
const GATES: Record<CheckGate, readonly string[]> = {
  start_verification: ['completeness', 'success_criteria', 'maintainer_assigned', 'revision_consistency'],
  decide: [
    'completeness',
    'maintainer_assigned',
    'decision_owner_assigned',
    'no_blocking_reviews',
    'revision_consistency',
  ],
};

export function failingForGate(results: readonly CheckResult[], gate: CheckGate): CheckResult[] {
  const required = GATES[gate];
  return results.filter((c) => required.includes(c.id) && c.status === 'fail');
}
