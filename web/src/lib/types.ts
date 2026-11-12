/** Shapes returned by API v1 (platform/modules/*). */
export type Role = 'employee' | 'maintainer' | 'decision_owner' | 'org_admin' | 'archivist';
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
  memberships: { organization: string; organizationName: string; realmName?: string; membershipId: string; roles: Role[] }[];
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

export interface Deferral {
  id: string;
  until: string;
  reason: string;
  by: string | null;
  at: string;
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
  /** The running postponement of the decision (0018), or null. */
  deferral: Deferral | null;
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
  departments: { id: string; name: string; active: boolean; headMembershipId: string | null; head: string | null; headcount?: number | null; civilization?: string }[];
  categories: { id: string; name: string; description: string | null; sortOrder: number; active: boolean }[];
  members: { membershipId: string; name: string; department: string | null; jobTitle: string | null; roles: Role[]; access: 'member' | 'guest' }[];
  settings: { defaultFirstResponseHours: number; defaultResolutionDays: number; staleDays: number; escalationMembershipId: string | null; realmName?: string } | null;
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

export type NoteCategory = 'council' | 'items' | 'decisions' | 'deadlines' | 'castle' | 'legacy';
export interface MeetingInvite {
  title: string;
  departmentId: string | null;
  hall: string;
  council: 'small' | 'great';
  agenda: { number: number; title: string }[];
  organizer: string;
  scheduledAt: string | null;
  ideaNumber: number | null;
  ideaTitle: string | null;
  reason: string;
  required: boolean;
  action: string;
  attendance: 'pending' | 'confirmed' | 'declined';
  consent: 'pending' | 'given' | 'declined';
  cancelled: boolean;
  cancelReason: string | null;
}
export interface Notification {
  id: string;
  event: string;
  category: NoteCategory;
  message: string;
  royal: string | null;
  headline: string;
  urgent: boolean;
  ideaNumber: number | null;
  meetingId: string | null;
  knowledgeId: string | null;
  meeting: MeetingInvite | null;
  meetingClosed: boolean;
  createdAt: string;
  readAt: string | null;
}
export interface NotePreferences {
  style: 'royal' | 'business';
  addressForm: 'title' | 'milord' | 'milady' | 'master' | 'neutral';
  groupRepeats: boolean;
  muted: string[];
  address: string;
  title: string | null;
  mandatory: string[];
  categories: Record<string, NoteCategory>;
  channels: { id: string; label: string; available: boolean; note?: string }[];
  note: string;
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
  xp: number;
  level: number;
  levelName: string;
  levelFloor: number;
  nextLevelXp: number | null;
  nextLevelName: string | null;
  progress: number;
  effectXp: number;
  headcount: number | null;
  /** Architectural style of the district (ADR-0019): a picture, no rights. */
  civilization: string;
  /** Achievements earned: pedestals on the achievements plaza. */
  achievements: number;
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
  /** Who sent the envoy: the author's name, as on the item card. */
  author: string | null;
  /** The decision is postponed until this date (0018), or null. */
  deferredUntil: string | null;
}
export interface Kingdom {
  castles: Castle[];
  envoys: Envoy[];
  wildlands: number;
  levels: Levels;
}
export interface Levels {
  thresholds: number[];
  names: string[];
}

/** Castle progress (0007): XP from confirmed events only. */
export interface Achievement {
  key: string;
  title: string;
  description: string;
  earnedAt: string | null;
}
export interface CastleDetail {
  id: string;
  name: string;
  headcount: number | null;
  xp: number;
  implemented: number;
  level: number;
  levelName: string;
  floor: number;
  next: number | null;
  nextName: string | null;
  progress: number;
  levels: Levels;
  history: {
    kind: 'implementation' | 'effect';
    xp: number;
    at: string;
    number: number;
    title: string;
    credited: string;
    total: number;
    levelUp: { level: number; name: string } | null;
  }[];
  achievements: Achievement[];
}
export interface RatingRow {
  rank: number;
  departmentId: string;
  name: string;
  headcount: number | null;
  level: number;
  levelName: string;
  xpTotal: number;
  xpPeriod: number;
  implementedTotal: number;
  implementedPeriod: number;
  effectXpTotal: number;
  effectXpPeriod: number;
  xpPer10: number | null;
  implementedPer10: number | null;
}
export interface Rating {
  period: '30' | '90' | '365' | 'all';
  from: string | null;
  levels: Levels;
  rows: RatingRow[];
}
export interface IdeaProgress {
  awards: { kind: 'implementation' | 'effect'; xp: number; at: string }[];
  effect: { xp: number; rationale: string; at: string; approvedBy: string } | null;
  effectMax: number;
  xpPerImplementation: number;
  canApproveEffect: boolean;
}

/** «Совет королевства». */
export type CouncilRole = 'initiator' | 'recorded' | 'maintainer' | 'decision_owner' | 'implementer' | 'department_head' | 'pilot_owner' | 'member';
export type Recommendation = 'implement' | 'pilot' | 'clarify' | 'reject' | 'rework';
export type Stance = 'for' | 'against' | 'mixed' | 'none' | 'dissent' | Recommendation;
export interface CouncilSeat {
  membershipId: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
  roles: CouncilRole[];
  headOf: string[];
  title: string | null;
  civilization: string | null;
  stance: Stance;
}
export interface CouncilEntry {
  id: string;
  kind: 'argument_for' | 'argument_against' | 'recommendation' | 'dissent' | 'handoff';
  recommendation: Recommendation | null;
  body: string;
  createdAt: string;
  author: string;
  authorMembershipId: string;
  mine: boolean;
  /** Where the entry was made: the department's small council or the Great Round Table. */
  council: 'small' | 'great';
}
export interface CouncilView {
  item: {
    number: number;
    kind: Kind;
    title: string;
    problem: string;
    proposal: string | null;
    stage: Stage;
    status: Status;
    category: string | null;
    department: string | null;
    author: string;
    raisedBy: string | null;
    maintainer: string | null;
    decisionOwner: string | null;
    implementer: string | null;
    publishedAt: string;
    firstResponseDueAt: string | null;
    firstResponseAt: string | null;
    resolutionDueAt: string | null;
    overdueFirstResponse: boolean;
    overdueResolution: boolean;
  };
  seats: CouncilSeat[];
  entries: CouncilEntry[];
  decisions: { outcome: 'merge' | 'reject' | 'close'; rationale: string; createdAt: string; decidedBy: string }[];
  questions: { body: string; state: string; createdAt: string; author: string }[];
  similar: { number: number; title: string; status: Status }[];
  can: { argue: boolean; recommend: boolean; handoff: boolean; askAuthor: boolean; pilot: boolean; decide: boolean; escalate: boolean };
  place: CouncilPlace;
  meetings: { id: string; title: string; scope: string; at: string; council: 'small' | 'great' }[];
}
export interface CouncilListRow {
  number: number;
  title: string;
  status: Status;
  department: string | null;
  initiator: string;
  maintainer: string | null;
  decisionOwner: string | null;
  iDecide: boolean;
  iLead: boolean;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  overdueFirstResponse: boolean;
  overdueResolution: boolean;
  for: number;
  against: number;
  recommendations: number;
  dissent: number;
  council: 'small' | 'great';
  hall: string;
  civilization: string | null;
  departmentId: string | null;
}
export interface Contribution {
  items: { number: number; title: string; status: Status; department: string | null; authored: boolean; credited: boolean; xp: number }[];
}

// ---- MODUS ADVISOR (0008, ADR-0013) ----------------------------------------
export interface AdvisorStatus {
  rules: { available: boolean; label: string };
  /** `remote`: a cloud model — the text sent for analysis leaves the company (ADR-0028). */
  model: { configured: boolean; provider: string | null; model: string | null; reachable: boolean; remote?: boolean };
  note: string;
}
export interface EmployeeProfile {
  skills: string[];
  preferences: string | null;
  weeklyHours: number | null;
  updatedAt: string | null;
}
export interface ProtocolRow {
  id: string;
  title: string;
  method: 'rules' | 'model';
  model: string | null;
  createdAt: string;
  createdBy: string;
  total: number;
  proposed: number;
  accepted: number;
}
export interface ProtocolCandidate {
  id: string;
  ord: number;
  quoteStart: number;
  quoteEnd: number;
  quote: string;
  title: string;
  kind: Kind;
  raiser: string | null;
  status: 'proposed' | 'accepted' | 'dismissed';
  itemNumber: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface ProtocolView {
  id: string;
  title: string;
  text: string;
  sha256: string;
  method: 'rules' | 'model';
  model: string | null;
  methodLabel: string;
  createdAt: string;
  createdBy: string;
  candidates: ProtocolCandidate[];
  canDecide: boolean;
}
export interface ExecutorSuggestion {
  membershipId: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
  skills: string[];
  matched: string[];
  weeklyHours: number | null;
  load: number;
  reasons: string[];
}
export interface ExecutorView {
  method: string;
  explanation: string;
  profiles: number;
  suggestions: ExecutorSuggestion[];
  confirmed: { candidate: string; name: string; confirmedBy: string; createdAt: string; reasons: string[] }[];
  canConfirm: boolean;
}

// ---- Living kingdom (0009, ADR-0014) ---------------------------------------
export interface GameTitle {
  membershipId: string;
  title: string;
  rank: TitleKind;
  source: 'assigned' | 'castle_head' | 'guild_default' | 'civilization' | 'neutral' | 'choice';
  castle: string | null;
  civilization: string | null;
  honor: string | null;
}
export interface TitleChoices {
  neutral: boolean;
  novice: boolean;
  showHonor: boolean;
  headForm: 'lord' | 'lady' | null;
}
export interface TitlesView {
  titles: GameTitle[];
  guilds: { departmentId: string; department: string; titles: string[] }[];
  registry: { id: string; name: string; hall: string; titles: CivTitles }[];
  choices: TitleChoices;
  note: string;
}
export type Consent = 'pending' | 'given' | 'declined';
export interface MeetingRow {
  id: string;
  title: string;
  scope: 'royal' | 'castle';
  department: string | null;
  ideaNumber: number | null;
  organizer: string;
  createdAt: string;
  recordingStartedAt: string | null;
  endedAt: string | null;
  myConsent: Consent | null;
  myAttendance?: 'pending' | 'confirmed' | 'declined' | null;
  scheduledAt?: string | null;
  cancelledAt?: string | null;
  participants: number;
  consented: number;
  hasRecording: boolean;
}
export type FindingType =
  | 'idea'
  | 'problem'
  | 'task'
  | 'deadline'
  | 'owner_candidate'
  | 'proposed_solution'
  | 'decision'
  | 'risk'
  | 'objection'
  | 'open_question'
  | 'insight';
export interface MeetingFinding {
  id: string;
  analysisId: string;
  ord: number;
  type: FindingType;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
  title: string;
  kind: Kind;
  startMs: number | null;
  speakerLabel: string | null;
  speakerMembershipId: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  basis: string | null;
  status: 'proposed' | 'accepted' | 'dismissed' | 'noted';
  itemNumber: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface MeetingView {
  id: string;
  title: string;
  scope: 'royal' | 'castle';
  departmentId: string | null;
  department: string | null;
  ideaNumber: number | null;
  organizerMembershipId: string;
  organizer: string;
  createdAt: string;
  recordingStartedAt: string | null;
  endedAt: string | null;
  participants: { membershipId: string; name: string; jobTitle: string | null; department: string | null; consent: Consent; consentAt: string | null; attendance: 'pending' | 'confirmed' | 'declined' }[];
  scheduledAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  myConsent: Consent | null;
  allConsented: boolean;
  agenda: { number: number; title: string; status: Status }[];
  place: { council: 'small' | 'great'; hall: string; civilization: string | null };
  recording: { source: 'microphone' | 'upload'; contentType: string; sizeBytes: number; durationMs: number | null; sha256: string; createdAt: string; uploadedBy: string; purgedAt: string | null } | null;
  legalHold?: boolean;
  transcripts: { id: string; source: 'engine' | 'manual' | 'prepared' | 'minutes'; engine: string | null; text: string; sha256: string; createdAt: string; createdBy: string; purgedAt: string | null }[];
  analyses: { id: string; transcriptId: string; method: 'rules' | 'model'; model: string | null; createdAt: string; createdBy: string }[];
  findings: MeetingFinding[];
  engine: { configured: boolean; model: string | null };
  model: { configured: boolean; model: string | null };
  can: { consent: boolean; attend: boolean; manage: boolean; record: boolean; review: boolean; transcribe: boolean; addTranscript: boolean };
}
export interface ItemOrigin {
  meetingId: string;
  title: string;
  startMs: number | null;
  quote: string;
  type: FindingType;
  speaker: string | null;
  confidence: string | null;
  transcriptSource: 'engine' | 'manual' | 'prepared' | 'minutes';
  recordingAvailable: boolean | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

/** «Живое Королевство» (ADR-0019): the district screen — read-only facts under the caller's rights. */
export interface StaffCard {
  membershipId: string;
  name: string;
  jobTitle: string | null;
  title: string | null;
  /** What the title stands for — a function or the person's choice, never a rating. */
  titleKind: TitleKind | null;
  honor: string | null;
  group: 'command' | 'specialist' | 'member';
  isHead: boolean;
  questionnaire: 'filled' | 'empty' | 'hidden';
  specialization: string | null;
  skills: string[] | null;
  capacityHours: number | null;
  loadHours: null;
  activeTasks: number;
  assigned: number;
  leading: number;
  achievements: { implemented: number; ideasImplemented: number; effectsConfirmed: number; confirmedAsExecutor: number };
}
export interface DistrictItem {
  number: number;
  title: string;
  kind: string;
  status: Status;
  author: string;
  maintainer: string | null;
  implementer: string | null;
  decisionOwner: string | null;
  due: string | null;
  overdue: boolean;
  stale: boolean;
  publishedAt: string;
}
export interface District {
  id: string;
  name: string;
  civilization: { id: string; name: string; motto: string; hall: string; titles: CivTitles };
  colorIndex: number;
  head: { membershipId: string; name: string | null; title: string | null } | null;
  canChooseCivilization: boolean;
  level: number;
  levelName: string;
  xp: number;
  levelFloor: number;
  nextLevelXp: number | null;
  nextLevelName: string | null;
  progress: number;
  levels: Levels;
  rank: number;
  of: number;
  people: number;
  activeTasks: number;
  inReview: number;
  implemented: number;
  lastAchievements: Achievement[];
  staff: StaffCard[];
  needs: { vacancies: null; missingSkills: null; capacityShortage: null; note: string };
  tasks: DistrictItem[];
  initiatives: DistrictItem[];
  council: {
    open: { number: number; title: string; entries: number; great: boolean }[];
    decisions: { number: number; title: string; outcome: string; by: string; at: string }[];
    meetings: { id: string; title: string; at: string; cancelled: boolean; idea: number | null; great: boolean }[];
  };
  legacy: { id: string; title: string; level: string; status: string; kind: string }[];
  development: {
    history: CastleDetail['history'];
    achievements: Achievement[];
    civilizationHistory: { at: string; from: string; to: string; actor: string | null }[];
  };
  assignable: { number: number; title: string; implementerId: string | null }[];
  canCallCouncil: boolean;
}
export interface PersonListItem {
  number: number;
  title: string;
  status: Status;
  due: string | null;
  overdue: boolean;
}
export interface PersonCard {
  membershipId: string;
  name: string;
  jobTitle: string | null;
  department: { id: string | null; name: string } | null;
  title: string | null;
  titleKind: TitleKind | null;
  honor: string | null;
  civilization: string | null;
  self: boolean;
  questionnaire: 'filled' | 'empty' | 'hidden';
  skills: string[] | null;
  weeklyHours: number | null;
  preferences: string | null;
  loadHours: null;
  tasks: PersonListItem[];
  initiatives: PersonListItem[];
  results: { number: number; title: string; role: string; xp: number }[];
  achievements: StaffCard['achievements'];
}

/** Civilization registry (ADR-0020): words only, no rights. */
export type TitleKind = 'king' | 'regent' | 'castle_head' | 'guild' | 'deputy' | 'authorized' | 'master' | 'novice' | 'member';
export interface CivTitles {
  head: string;
  deputy: string;
  authorized: string;
  master: string;
  honor: string | null;
  novice: string | null;
  member: string;
}
export interface CouncilPlace {
  level: 'small' | 'great';
  hall: string;
  department: { id: string; name: string; civilization: string; civilizationName: string; hall: string } | null;
  escalation: {
    by: string;
    at: string;
    reasonKind: string;
    reasonTitle: string;
    reason: string;
    from: { name: string; hall: string; civilization: string } | null;
  } | null;
}
export const ESCALATION_REASONS: Record<string, string> = {
  cross_department: 'Межотдельский вопрос: затрагивает несколько подразделений',
  strategic: 'Стратегическое изменение',
  shared_resources: 'Общие ресурсы компании',
  higher_authority: 'Нужны более высокие полномочия',
  other: 'Другая причина',
};
