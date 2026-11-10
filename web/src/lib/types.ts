/** Shapes returned by API v1 (platform/modules/*). */
export type Role = 'employee' | 'maintainer' | 'decision_owner' | 'org_admin';
export type Status =
  | 'unrouted'
  | 'in_review'
  | 'needs_info'
  | 'in_verification'
  | 'decision'
  | 'in_progress'
  | 'implemented'
  | 'rejected'
  | 'closed';
export type Stage = 'published' | 'review' | 'development' | 'verification' | 'decision' | 'adoption' | 'impact_verification' | 'closed';
export type Channel = 'app' | 'meeting' | 'email' | 'phone' | 'conversation' | 'messenger' | 'other';
export type Kind = 'idea' | 'problem';

export interface Me {
  id: string;
  displayName: string;
  memberships: { organization: string; organizationName: string; membershipId: string; roles: Role[] }[];
}

export interface Persona {
  userId: string;
  name: string;
  title: string;
  department: string;
  hint: string;
}
export interface Personas {
  organization: string;
  organizationName: string;
  personas: Persona[];
}

export interface ListItem {
  number: number;
  kind: Kind;
  title: string;
  stage: Stage;
  status: Status;
  category: string | null;
  department: string | null;
  sourceChannel: Channel;
  author: string;
  raisedBy: string | null;
  maintainer: string | null;
  decisionOwner: string | null;
  implementer: string | null;
  publishedAt: string;
  updatedAt: string;
  firstResponseDueAt: string | null;
  firstResponseAt: string | null;
  resolutionDueAt: string | null;
  overdueFirstResponse: boolean;
  overdueResolution: boolean;
  stale: boolean;
}

export interface Person {
  membershipId: string;
  name: string;
}
export interface Revision {
  number: number;
  origin: 'publication' | 'author_update' | 'suggestion';
  status: 'proposed' | 'current' | 'superseded' | 'declined';
  title: string;
  problem: string;
  proposal: string | null;
  success_criteria: string | null;
  rationale: string | null;
  created_at: string;
  author: string;
  author_membership_id: string;
}
export interface Review {
  id: string;
  kind: 'comment' | 'request_changes' | 'objection' | 'approval' | 'progress';
  revision_number: number;
  parent_review_id: string | null;
  body: string;
  state: 'open' | 'resolved' | 'withdrawn';
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  author: string;
  author_membership_id: string;
}
export interface Evidence {
  id: string;
  kind: 'baseline' | 'result' | 'positive_observation' | 'negative_observation' | 'reference';
  body: string;
  metric: string | null;
  value: number | null;
  unit: string | null;
  createdAt: string;
  recordedBy: string;
}
export interface Verification {
  id: string;
  purpose: string;
  revision_number: number;
  status: 'planned' | 'running' | 'completed' | 'cancelled';
  outcome: 'positive' | 'negative' | 'inconclusive' | null;
  plan: string;
  success_criteria: string;
  conclusion: string | null;
  owner_membership_id: string;
  owner: string;
  concluded_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  evidence: Evidence[];
}
export interface Decision {
  id: string;
  outcome: 'merge' | 'reject' | 'close';
  revision_number: number;
  rationale: string;
  created_at: string;
  decided_by: string;
}
export interface Contribution {
  kind: string;
  status: 'recorded' | 'confirmed' | 'revoked';
  member: string;
  created_at: string;
}
export interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy?: string;
  createdAt: string;
}
export interface Escalation {
  kind: 'first_response' | 'resolution' | 'stale';
  createdAt: string;
  escalatedTo: string | null;
}

export interface IdeaDetail {
  id: string;
  number: number;
  kind: Kind;
  stage: Stage;
  status: Status;
  category: string | null;
  categoryId: string | null;
  department: string | null;
  departmentId: string | null;
  sourceChannel: Channel;
  sourceNote: string | null;
  raisedBy: string | null;
  raisedByMembershipId: string | null;
  implementer: string | null;
  implementerMembershipId: string | null;
  author: Person;
  maintainer: Person | null;
  decisionOwner: Person | null;
  currentRevision: number;
  publishedAt: string;
  updatedAt: string;
  firstResponseDueAt: string | null;
  firstResponseAt: string | null;
  resolutionDueAt: string | null;
  overdueFirstResponse: boolean;
  overdueResolution: boolean;
  stale: boolean;
  revisions: Revision[];
  reviews: Review[];
  verifications: Verification[];
  decisions: Decision[];
  contributions: Contribution[];
  attachments: Attachment[];
  escalations: Escalation[];
  checks: { id: string; status: 'pass' | 'fail' | 'warn' | 'info'; message: string }[];
}

export interface Directory {
  departments: { id: string; name: string; active: boolean; headMembershipId: string | null; head: string | null }[];
  categories: { id: string; name: string; description: string | null; sortOrder: number; active: boolean }[];
  members: { membershipId: string; name: string; department: string | null; jobTitle: string | null; roles: Role[]; access: 'member' | 'guest' }[];
  settings: { defaultFirstResponseHours: number; defaultResolutionDays: number; staleDays: number; escalationMembershipId: string | null } | null;
}

export interface Rule {
  id: string;
  priority: number;
  active: boolean;
  categoryId: string | null;
  category: string | null;
  departmentId: string | null;
  department: string | null;
  maintainer: string;
  maintainerName: string;
  decisionOwner: string | null;
  decisionOwnerName: string | null;
  escalateTo: string | null;
  escalateToName: string | null;
  firstResponseHours: number | null;
  resolutionDays: number | null;
}

export interface Notification {
  id: string;
  event: string;
  message: string;
  ideaNumber: number | null;
  createdAt: string;
  readAt: string | null;
}

export interface Analytics {
  totals: Record<string, number | string | null>;
  metrics: {
    shareResponded: number | null;
    shareWithResult: number | null;
    medianFirstResponseHours: string | number | null;
    p90FirstResponseHours: string | number | null;
    implemented: number;
  };
  byStatus: { status: Status; count: number }[];
  byChannel: { channel: Channel; count: number }[];
  byCategory: { category: string; total: number; open: number; implemented: number; rejected: number; overdue: number }[];
  byDepartment: { department: string; total: number; open: number; overdue: number }[];
  recurring: { anchorNumber: number; anchorTitle: string; category: string | null; similarNumbers: number[]; size: number }[];
  needsAttention: (Pick<ListItem, 'number' | 'title' | 'status' | 'category' | 'department' | 'maintainer' | 'publishedAt' | 'overdueFirstResponse' | 'overdueResolution' | 'stale'>)[];
}

/** «Королевство»: castles of departments and envoys (open items). */
export interface Castle {
  id: string;
  name: string;
  towers: number;
  building: number;
  envoys: number;
  waiting: number;
  returned: number;
}
export interface Envoy {
  number: number;
  title: string;
  status: Status;
  departmentId: string | null;
  responded: boolean;
  overdueFirstResponse: boolean;
  overdueResolution: boolean;
  stale: boolean;
  mine: boolean;
  publishedAt: string;
}
export interface Kingdom {
  castles: Castle[];
  envoys: Envoy[];
  wildlands: number;
}
