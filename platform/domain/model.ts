/**
 * Shared vocabulary of the MODUS FLOW domain. Mirrors the CHECK constraints in
 * platform/db/migrations/0001_foundation.sql — keep both in sync.
 */
export const ORG_ROLES = ['employee', 'maintainer', 'decision_owner', 'org_admin'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const IDEA_STAGES = [
  'published',
  'review',
  'development',
  'verification',
  'decision',
  'adoption',
  'impact_verification',
  'closed',
] as const;
export type IdeaStage = (typeof IDEA_STAGES)[number];

export const REVIEW_KINDS = ['comment', 'request_changes', 'objection', 'approval'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const VERIFICATION_OUTCOMES = ['positive', 'negative', 'inconclusive'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export const DECISION_OUTCOMES = ['merge', 'reject', 'close'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const CONTRIBUTION_KINDS = [
  'authorship',
  'co_authorship',
  'revision',
  'review',
  'issue_found',
  'verification',
  'implementation',
  'confirmed_impact',
  'harm_prevented',
  'negative_result',
] as const;
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number];

export const NOTIFICATION_EVENTS = [
  'idea_published',
  'comment_added',
  'changes_requested',
  'assigned',
  'verification_started',
  'verification_completed',
  'idea_merged',
  'idea_rejected',
  'contribution_confirmed',
  'honor_board_recognition',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/** Who is acting, inside one organization. Built only by the server from a verified session. */
export interface OrgActor {
  userId: string;
  orgId: string;
  membershipId: string;
  roles: readonly OrgRole[];
}

/** The parts of an idea that authorization decisions depend on. */
export interface IdeaAccessFacts {
  authorMembershipId: string;
  maintainerMembershipId: string | null;
  decisionOwnerMembershipId: string | null;
  stage: IdeaStage;
}
