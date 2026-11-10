import { forbidden } from './errors.ts';
import type { IdeaAccessFacts, OrgActor, OrgRole } from './model.ts';

/**
 * Server-side authorization rules for organization actions. Pure functions:
 * the HTTP layer never decides permissions, and the database repeats the
 * critical parts (tenant isolation, authorship) as RLS policies.
 *
 * Principles encoded here:
 *  - The author owns the idea text. Others suggest revisions; only the author
 *    accepts them. Nobody silently rewrites an author's proposal.
 *  - The author may object to any change request (right of reply).
 *  - Nobody decides on their own idea (conflict of interest).
 *  - Whoever raised an item (author, or the employee it was recorded for) never
 *    leads, verifies or decides it.
 *  - Hybrid powers (owner decision 2026-11-10): one head may lead and decide a
 *    simple item; a field verification needs a separate decision owner, and the
 *    decision owner never judges a verification they ran.
 *  - The responsible people report progress; the implementer reports completion.
 *  - Organization Admin administers; it does not grant review or decision power.
 *  - Invited guests act only on ideas they are assigned to (visibility is enforced by RLS).
 */
export type IdeaAction =
  | 'idea.view'
  | 'idea.comment'
  | 'idea.approve'
  | 'idea.request_changes'
  | 'idea.object'
  | 'idea.revise'
  | 'idea.suggest_revision'
  | 'idea.decide_suggestion'
  | 'idea.assign'
  | 'review.resolve'
  | 'verification.start'
  | 'verification.record_evidence'
  | 'verification.conclude'
  | 'idea.decide'
  | 'idea.adopt'
  | 'idea.report_progress'
  | 'idea.complete_implementation'
  | 'contribution.confirm';

const has = (actor: OrgActor, role: OrgRole) => actor.roles.includes(role);
const member = (actor: OrgActor) => actor.access === 'member';
const isAuthor = (actor: OrgActor, idea: IdeaAccessFacts) => actor.membershipId === idea.authorMembershipId;
/** Author or the employee the item was raised for: both have a stake and never judge it. */
const isOriginator = (actor: OrgActor, idea: IdeaAccessFacts) =>
  isAuthor(actor, idea) || (!!idea.raisedByMembershipId && actor.membershipId === idea.raisedByMembershipId);
const isImplementer = (actor: OrgActor, idea: IdeaAccessFacts) =>
  !!idea.implementerMembershipId && actor.membershipId === idea.implementerMembershipId;
const isMaintainer = (actor: OrgActor, idea: IdeaAccessFacts) =>
  idea.maintainerMembershipId !== null && actor.membershipId === idea.maintainerMembershipId;
const isDecisionOwner = (actor: OrgActor, idea: IdeaAccessFacts) =>
  idea.decisionOwnerMembershipId !== null && actor.membershipId === idea.decisionOwnerMembershipId;
/** Until a maintainer is assigned, any organization maintainer may lead review. */
const leadsReview = (actor: OrgActor, idea: IdeaAccessFacts) =>
  !isOriginator(actor, idea) &&
  (isMaintainer(actor, idea) ||
    isDecisionOwner(actor, idea) ||
    (idea.maintainerMembershipId === null && member(actor) && has(actor, 'maintainer')));

export interface PolicyContext {
  /** For review.resolve: who opened the change request. */
  reviewAuthorMembershipId?: string;
  /** For verification.record_evidence: who owns the verification run. */
  verificationOwnerMembershipId?: string;
  /** For contribution.confirm: whose contribution is being confirmed. */
  contributorMembershipId?: string;
}

export function can(actor: OrgActor, action: IdeaAction, idea: IdeaAccessFacts, ctx: PolicyContext = {}): boolean {
  const open = idea.stage !== 'closed';
  switch (action) {
    case 'idea.view':
      return true;
    case 'idea.comment':
      return open;
    case 'idea.approve':
      return open && !isAuthor(actor, idea);
    case 'idea.request_changes':
      return open && leadsReview(actor, idea);
    case 'idea.object':
      return open && isAuthor(actor, idea);
    case 'idea.revise':
    case 'idea.decide_suggestion':
      return open && isAuthor(actor, idea);
    case 'idea.suggest_revision':
      return open && !isAuthor(actor, idea);
    case 'idea.assign':
      // Invited guests never assign; the author never picks their own reviewers.
      return open && member(actor) && !isOriginator(actor, idea) && (has(actor, 'maintainer') || has(actor, 'decision_owner'));
    case 'review.resolve':
      return (
        open &&
        !isAuthor(actor, idea) &&
        (ctx.reviewAuthorMembershipId === actor.membershipId || isMaintainer(actor, idea))
      );
    case 'verification.start':
    case 'verification.conclude':
      // Verification is the maintainer's job; the decision owner stays independent of it.
      return open && !isOriginator(actor, idea) && isMaintainer(actor, idea);
    case 'verification.record_evidence':
      return (
        open &&
        !isAuthor(actor, idea) &&
        (ctx.verificationOwnerMembershipId === actor.membershipId ||
          isMaintainer(actor, idea) ||
          isDecisionOwner(actor, idea))
      );
    case 'idea.decide':
    case 'idea.adopt':
      return open && isDecisionOwner(actor, idea) && !isOriginator(actor, idea);
    case 'idea.report_progress':
      return open && (isMaintainer(actor, idea) || isDecisionOwner(actor, idea) || isImplementer(actor, idea));
    case 'idea.complete_implementation':
      return idea.stage === 'adoption' && (isImplementer(actor, idea) || isMaintainer(actor, idea) || isDecisionOwner(actor, idea));
    case 'contribution.confirm':
      return (
        ctx.contributorMembershipId !== undefined &&
        ctx.contributorMembershipId !== actor.membershipId &&
        (isMaintainer(actor, idea) || isDecisionOwner(actor, idea))
      );
  }
}

export function authorize(actor: OrgActor, action: IdeaAction, idea: IdeaAccessFacts, ctx?: PolicyContext): void {
  if (!can(actor, action, idea, ctx)) throw forbidden(`Действие ${action} недоступно`);
}
