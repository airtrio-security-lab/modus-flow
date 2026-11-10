import type { IdeaDetail, Role } from './types';

/**
 * A copy of the server rules (platform/domain/policy.ts) used only to decide
 * which buttons to show. The server and the database enforce them again; if
 * they disagree, the server's answer is shown to the user.
 */
export interface Viewer {
  membershipId: string;
  roles: Role[];
}

export function facts(v: Viewer, i: IdeaDetail) {
  const me = v.membershipId;
  const author = i.author.membershipId === me;
  const raiser = i.raisedByMembershipId === me;
  const originator = author || raiser;
  const maintainer = i.maintainer?.membershipId === me;
  const decider = i.decisionOwner?.membershipId === me;
  const implementer = i.implementerMembershipId === me;
  const open = i.stage !== 'closed';
  const orgLead = v.roles.includes('maintainer') || v.roles.includes('decision_owner');
  const leads = !originator && (maintainer || decider || (!i.maintainer && v.roles.includes('maintainer')));
  return {
    author,
    raiser,
    originator,
    maintainer,
    decider,
    implementer,
    open,
    comment: open,
    askAuthor: open && leads && ['published', 'review', 'development', 'decision'].includes(i.stage),
    object: open && author,
    revise: open && author && ['published', 'review', 'development'].includes(i.stage),
    assign: open && !originator && orgLead,
    takeOver: open && !originator && !i.maintainer && v.roles.includes('maintainer'),
    resolve: open && !author && maintainer,
    startCheck: open && !originator && maintainer && i.stage === 'review',
    evidence: (vOwner: string) => open && !author && (vOwner === me || maintainer || decider),
    conclude: open && !originator && maintainer,
    decide: open && decider && !originator && ['review', 'decision'].includes(i.stage),
    progress: open && (maintainer || decider || implementer) && ['review', 'development', 'verification', 'decision', 'adoption'].includes(i.stage),
    setImplementer: i.stage === 'adoption' && (maintainer || decider),
    complete: i.stage === 'adoption' && !originator && (implementer || maintainer || decider),
    declineCredit: raiser,
    attach: author || raiser || maintainer || decider || implementer,
  };
}
export type Facts = ReturnType<typeof facts>;
