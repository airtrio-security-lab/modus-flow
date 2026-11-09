-- MODUS FLOW · Platform foundation schema v1
--
-- Design rules (see docs/adr/):
--   * Personal Lab data is owned by a USER and never carries an organization scope.
--   * Every organization-scoped row carries organization_id; cross-table references use
--     composite foreign keys (organization_id, id) so rows from different tenants can
--     never be linked, even by a buggy service.
--   * Row Level Security is enabled on every table the application role touches.
--     The application runs as role "modus_app" (non-owner), so RLS always applies to it.
--   * History is append-only: content of revisions, review bodies, decisions, evidence,
--     draft versions and audit events cannot be updated or deleted.

DO $$ BEGIN
  CREATE ROLE modus_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Session context helpers. The service layer sets these with SET LOCAL inside
-- every transaction (see platform/db/pool.ts). Missing values resolve to NULL,
-- which makes every policy deny by default.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app_membership_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.membership_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Identity and tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name     text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  external_subject text UNIQUE,                    -- reserved for SSO / OIDC "sub"
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  next_idea_number integer NOT NULL DEFAULT 1 CHECK (next_idea_number > 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Membership = the Employee record inside one organization.
CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  department      text CHECK (department IS NULL OR length(department) <= 160),
  job_title       text CHECK (job_title IS NULL OR length(job_title) <= 160),
  roles           text[] NOT NULL DEFAULT ARRAY['employee']
                  CHECK (cardinality(roles) > 0
                         AND roles <@ ARRAY['employee','maintainer','decision_owner','org_admin']),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);

-- Membership checks used by policies. SECURITY DEFINER so they read memberships
-- without recursing into the memberships policy; they only ever answer about
-- the caller's own user id.
CREATE FUNCTION app_is_member(org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.organization_id = org AND m.user_id = app_user_id() AND m.status = 'active')
$$;

CREATE FUNCTION app_has_role(org uuid, role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.organization_id = org AND m.user_id = app_user_id()
      AND m.status = 'active' AND role = ANY (m.roles))
$$;

CREATE FUNCTION app_in_current_org(target_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_member(app_org_id()) AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.organization_id = app_org_id() AND m.user_id = target_user)
$$;

-- Allocates the next per-organization idea number (like a PR number).
CREATE FUNCTION app_next_idea_number(org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF org IS DISTINCT FROM app_org_id() OR NOT app_is_member(org) THEN
    RAISE EXCEPTION 'not a member of organization' USING ERRCODE = '42501';
  END IF;
  UPDATE organizations SET next_idea_number = next_idea_number + 1
   WHERE id = org RETURNING next_idea_number - 1 INTO n;
  RETURN n;
END $$;

-- Employee projection (read model). Profiles are views over membership + user,
-- not a second copy of identity data.
CREATE VIEW employees WITH (security_invoker = true) AS
  SELECT m.id AS membership_id, m.organization_id, m.user_id, u.display_name,
         m.department, m.job_title, m.roles, m.status, m.created_at
    FROM memberships m JOIN users u ON u.id = m.user_id;

-- ---------------------------------------------------------------------------
-- Personal Lab (private, user-owned, never organization-visible)
-- ---------------------------------------------------------------------------
CREATE TABLE lab_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid NOT NULL REFERENCES users(id),
  kind              text NOT NULL DEFAULT 'idea' CHECK (kind IN ('idea','problem')),
  state             text NOT NULL DEFAULT 'private' CHECK (state IN ('private','published')),
  current_version   integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  published_idea_id uuid,
  published_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'published') = (published_idea_id IS NOT NULL)),
  CHECK ((state = 'published') = (published_at IS NOT NULL))
);

CREATE TABLE lab_draft_versions (
  draft_id      uuid NOT NULL REFERENCES lab_drafts(id) ON DELETE CASCADE,
  version       integer NOT NULL CHECK (version > 0),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  content       jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, version)
);

-- ---------------------------------------------------------------------------
-- Organization workspace: ideas and their history
-- ---------------------------------------------------------------------------
CREATE TABLE ideas (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id              uuid NOT NULL REFERENCES organizations(id),
  number                       integer NOT NULL CHECK (number > 0),
  kind                         text NOT NULL CHECK (kind IN ('idea','problem')),
  author_membership_id         uuid NOT NULL,
  -- Lifecycle position only. Review threads, verification runs, decisions and
  -- impact results keep their own state in their own tables.
  stage                        text NOT NULL DEFAULT 'published' CHECK (stage IN
                                 ('published','review','development','verification',
                                  'decision','adoption','impact_verification','closed')),
  maintainer_membership_id     uuid,
  decision_owner_membership_id uuid,
  current_revision_number      integer NOT NULL DEFAULT 1 CHECK (current_revision_number > 0),
  published_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, maintainer_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, decision_owner_membership_id) REFERENCES memberships(organization_id, id)
);

ALTER TABLE lab_drafts
  ADD CONSTRAINT lab_drafts_published_idea_fk FOREIGN KEY (published_idea_id) REFERENCES ideas(id);

CREATE TABLE idea_revisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL,
  idea_id              uuid NOT NULL,
  number               integer NOT NULL CHECK (number > 0),
  author_membership_id uuid NOT NULL,
  origin               text NOT NULL CHECK (origin IN ('publication','author_update','suggestion')),
  based_on_number      integer CHECK (based_on_number IS NULL OR based_on_number > 0),
  title                text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  problem              text NOT NULL CHECK (length(btrim(problem)) BETWEEN 1 AND 5000),
  proposal             text NOT NULL CHECK (length(btrim(proposal)) BETWEEN 1 AND 5000),
  success_criteria     text CHECK (success_criteria IS NULL OR length(success_criteria) <= 3000),
  rationale            text CHECK (rationale IS NULL OR length(rationale) <= 3000),
  status               text NOT NULL CHECK (status IN ('proposed','current','superseded','declined')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idea_id, number),
  UNIQUE (organization_id, id),
  CHECK ((origin = 'publication') = (number = 1)),
  CHECK (origin <> 'suggestion' OR rationale IS NOT NULL),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE UNIQUE INDEX idea_revisions_one_current ON idea_revisions (idea_id) WHERE status = 'current';

-- ---------------------------------------------------------------------------
-- Review (maintainer feedback, change requests, author objections)
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  idea_id                   uuid NOT NULL,
  revision_number           integer NOT NULL CHECK (revision_number > 0),
  author_membership_id      uuid NOT NULL,
  kind                      text NOT NULL CHECK (kind IN ('comment','request_changes','objection','approval')),
  parent_review_id          uuid,
  body                      text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  state                     text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','withdrawn')),
  resolved_by_membership_id uuid,
  resolution_note           text CHECK (resolution_note IS NULL OR length(resolution_note) <= 3000),
  resolved_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (kind <> 'objection' OR parent_review_id IS NOT NULL),
  CHECK (kind = 'request_changes' OR state = 'open'),
  CHECK ((state = 'open') = (resolved_at IS NULL)),
  CHECK ((state = 'open') = (resolved_by_membership_id IS NULL)),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, parent_review_id) REFERENCES reviews(organization_id, id),
  FOREIGN KEY (organization_id, resolved_by_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (idea_id, revision_number) REFERENCES idea_revisions(idea_id, number)
);

-- ---------------------------------------------------------------------------
-- Idea Verification Engine (human / field verification; automated checks are
-- computed on demand by platform/domain/checks.ts and recorded via audit)
-- ---------------------------------------------------------------------------
CREATE TABLE verifications (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  idea_id                 uuid NOT NULL,
  revision_number         integer NOT NULL,
  purpose                 text NOT NULL CHECK (purpose IN ('hypothesis','impact')),
  owner_membership_id     uuid NOT NULL,
  created_by_membership_id uuid NOT NULL,
  plan                    text NOT NULL CHECK (length(btrim(plan)) BETWEEN 1 AND 5000),
  success_criteria        text NOT NULL CHECK (length(btrim(success_criteria)) BETWEEN 1 AND 3000),
  status                  text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','completed','cancelled')),
  outcome                 text CHECK (outcome IN ('positive','negative','inconclusive')),
  conclusion              text CHECK (conclusion IS NULL OR length(conclusion) <= 5000),
  concluded_by_membership_id uuid,
  started_at              timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  -- A result is never "proven" without a recorded outcome, conclusion and reviewer.
  CHECK ((status = 'completed') = (outcome IS NOT NULL)),
  CHECK (status <> 'completed' OR (conclusion IS NOT NULL AND concluded_by_membership_id IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (status NOT IN ('running','completed') OR started_at IS NOT NULL),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, owner_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, concluded_by_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (idea_id, revision_number) REFERENCES idea_revisions(idea_id, number)
);

CREATE TABLE verification_evidence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  verification_id       uuid NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('baseline','result','positive_observation','negative_observation','reference')),
  body                  text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  metric                text CHECK (metric IS NULL OR length(metric) <= 160),
  value                 numeric,
  unit                  text CHECK (unit IS NULL OR length(unit) <= 40),
  recorded_by_membership_id uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((value IS NULL) OR (metric IS NOT NULL)),
  FOREIGN KEY (organization_id, verification_id) REFERENCES verifications(organization_id, id),
  FOREIGN KEY (organization_id, recorded_by_membership_id) REFERENCES memberships(organization_id, id)
);

-- ---------------------------------------------------------------------------
-- Decisions. "merge" = decision to adopt; it does NOT certify proven impact.
-- ---------------------------------------------------------------------------
CREATE TABLE decisions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  idea_id                  uuid NOT NULL,
  revision_number          integer NOT NULL,
  decided_by_membership_id uuid NOT NULL,
  outcome                  text NOT NULL CHECK (outcome IN ('merge','reject','close')),
  rationale                text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 10 AND 5000),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, decided_by_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (idea_id, revision_number) REFERENCES idea_revisions(idea_id, number)
);

-- ---------------------------------------------------------------------------
-- Contributions: evidence-linked recognition (no points, no likes)
-- ---------------------------------------------------------------------------
CREATE TABLE contributions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL,
  membership_id              uuid NOT NULL,
  idea_id                    uuid NOT NULL,
  kind                       text NOT NULL CHECK (kind IN
                               ('authorship','co_authorship','revision','review','issue_found',
                                'verification','implementation','confirmed_impact',
                                'harm_prevented','negative_result')),
  source_type                text NOT NULL CHECK (source_type IN ('idea','revision','review','verification','decision')),
  source_id                  uuid NOT NULL,
  status                     text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','confirmed','revoked')),
  confirmed_by_membership_id uuid,
  confirmed_at               timestamptz,
  revoked_reason             text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, kind, source_type, source_id),
  CHECK ((status = 'confirmed') = (confirmed_by_membership_id IS NOT NULL AND confirmed_at IS NOT NULL) OR status = 'revoked'),
  CHECK (status <> 'revoked' OR length(btrim(coalesce(revoked_reason, ''))) >= 10),
  -- Nobody confirms their own contribution.
  CHECK (confirmed_by_membership_id IS NULL OR confirmed_by_membership_id <> membership_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, confirmed_by_membership_id) REFERENCES memberships(organization_id, id)
);

-- ---------------------------------------------------------------------------
-- Notifications: targeted, deduplicated, no free-text payload (rendered from
-- event type + organization-visible idea title, so private drafts never leak).
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  recipient_membership_id uuid NOT NULL,
  actor_membership_id     uuid,
  event_type              text NOT NULL CHECK (event_type IN
                            ('idea_published','comment_added','changes_requested','assigned',
                             'verification_started','verification_completed','idea_merged',
                             'idea_rejected','contribution_confirmed','honor_board_recognition')),
  idea_id                 uuid,
  dedupe_key              text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  read_at                 timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_membership_id, dedupe_key),
  CHECK (actor_membership_id IS NULL OR actor_membership_id <> recipient_membership_id),
  FOREIGN KEY (organization_id, recipient_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id)
);
CREATE INDEX notifications_inbox ON notifications (recipient_membership_id, created_at DESC);

CREATE TABLE notification_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  membership_id   uuid NOT NULL,
  event_type      text NOT NULL,
  idea_id         uuid,
  enabled         boolean NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id)
);
CREATE UNIQUE INDEX notification_subscriptions_unique
  ON notification_subscriptions (membership_id, event_type, coalesce(idea_id, '00000000-0000-0000-0000-000000000000'));

-- Whether a recipient wants this event (per-idea setting beats the global one;
-- default on). Definer: senders may ask, but cannot read others' settings.
CREATE FUNCTION app_notification_enabled(recipient uuid, event text, idea uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_is_member(app_org_id()) AND coalesce(
    (SELECT s.enabled FROM notification_subscriptions s
      WHERE s.organization_id = app_org_id() AND s.membership_id = recipient
        AND s.event_type = event AND s.idea_id = idea),
    (SELECT s.enabled FROM notification_subscriptions s
      WHERE s.organization_id = app_org_id() AND s.membership_id = recipient
        AND s.event_type = event AND s.idea_id IS NULL),
    true)
$$;

-- ---------------------------------------------------------------------------
-- Audit and idempotency
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),   -- NULL = personal-lab event
  actor_user_id   uuid NOT NULL REFERENCES users(id),
  action          text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type     text NOT NULL,
  entity_id       uuid,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id);

CREATE TABLE idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users(id),
  scope        text NOT NULL,
  key          text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_hash text NOT NULL,
  status_code  integer NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, key)
);

-- ---------------------------------------------------------------------------
-- Append-only enforcement (applies to every role, including table owners)
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: history is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER decisions_append_only BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER verification_evidence_append_only BEFORE UPDATE OR DELETE ON verification_evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER lab_draft_versions_immutable BEFORE UPDATE ON lab_draft_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER idea_revisions_no_delete BEFORE DELETE ON idea_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ideas_no_delete BEFORE DELETE ON ideas
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Revisions: only the status may change; authored content is frozen.
CREATE FUNCTION idea_revisions_freeze_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.organization_id, NEW.idea_id, NEW.number, NEW.author_membership_id, NEW.origin,
      NEW.based_on_number, NEW.title, NEW.problem, NEW.proposal, NEW.success_criteria,
      NEW.rationale, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.idea_id, OLD.number, OLD.author_membership_id, OLD.origin,
      OLD.based_on_number, OLD.title, OLD.problem, OLD.proposal, OLD.success_criteria,
      OLD.rationale, OLD.created_at) THEN
    RAISE EXCEPTION 'revision content is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idea_revisions_freeze BEFORE UPDATE ON idea_revisions
  FOR EACH ROW EXECUTE FUNCTION idea_revisions_freeze_content();

-- Reviews: body, author and kind are frozen; only resolution fields change.
CREATE FUNCTION reviews_freeze_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.organization_id, NEW.idea_id, NEW.revision_number, NEW.author_membership_id,
      NEW.kind, NEW.parent_review_id, NEW.body, NEW.created_at)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.idea_id, OLD.revision_number, OLD.author_membership_id,
      OLD.kind, OLD.parent_review_id, OLD.body, OLD.created_at) THEN
    RAISE EXCEPTION 'review content is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reviews_freeze BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_freeze_content();

-- Completed verifications cannot be edited (negative results cannot be hidden).
CREATE FUNCTION verifications_freeze_completed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verifications cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'concluded verification is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.organization_id, NEW.idea_id, NEW.created_by_membership_id, NEW.purpose, NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id, OLD.idea_id, OLD.created_by_membership_id, OLD.purpose, OLD.created_at) THEN
    RAISE EXCEPTION 'verification identity is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verifications_freeze BEFORE UPDATE OR DELETE ON verifications
  FOR EACH ROW EXECUTE FUNCTION verifications_freeze_completed();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE users                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships                ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_drafts                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_draft_versions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ideas                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE idea_revisions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifications              ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_evidence      ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contributions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications              ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events               ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys           ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_visible ON users FOR SELECT TO modus_app
  USING (id = app_user_id() OR app_in_current_org(id));

CREATE POLICY organizations_members ON organizations FOR SELECT TO modus_app
  USING (app_is_member(id));

CREATE POLICY memberships_visible ON memberships FOR SELECT TO modus_app
  USING (user_id = app_user_id()
         OR (organization_id = app_org_id() AND app_is_member(organization_id)));

CREATE POLICY lab_drafts_owner ON lab_drafts FOR ALL TO modus_app
  USING (owner_user_id = app_user_id()) WITH CHECK (owner_user_id = app_user_id());
CREATE POLICY lab_draft_versions_owner ON lab_draft_versions FOR ALL TO modus_app
  USING (owner_user_id = app_user_id()) WITH CHECK (owner_user_id = app_user_id());

-- Organization-scoped tables share one rule: the row's tenant must be the
-- transaction's tenant AND the caller must be an active member of it.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ideas','idea_revisions','reviews','verifications',
                           'verification_evidence','decisions','contributions'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO modus_app
         USING (organization_id = app_org_id() AND app_is_member(organization_id))
         WITH CHECK (organization_id = app_org_id() AND app_is_member(organization_id))',
      t || '_tenant', t);
  END LOOP;
END $$;

-- Authorship cannot be forged: rows are always inserted in the actor's own name.
CREATE POLICY ideas_author_is_actor ON ideas AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (author_membership_id = app_membership_id());
CREATE POLICY idea_revisions_author_is_actor ON idea_revisions AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (author_membership_id = app_membership_id());
CREATE POLICY reviews_author_is_actor ON reviews AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (author_membership_id = app_membership_id());
CREATE POLICY reviews_resolver_is_actor ON reviews AS RESTRICTIVE FOR UPDATE TO modus_app
  USING (true)
  WITH CHECK (resolved_by_membership_id IS NULL OR resolved_by_membership_id = app_membership_id());
CREATE POLICY verifications_creator_is_actor ON verifications AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (created_by_membership_id = app_membership_id());
CREATE POLICY verifications_concluder_is_actor ON verifications AS RESTRICTIVE FOR UPDATE TO modus_app
  USING (true)
  WITH CHECK (concluded_by_membership_id IS NULL OR concluded_by_membership_id = app_membership_id());
CREATE POLICY verification_evidence_recorder_is_actor ON verification_evidence AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (recorded_by_membership_id = app_membership_id());
CREATE POLICY decisions_decider_is_actor ON decisions AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (decided_by_membership_id = app_membership_id());
CREATE POLICY contributions_confirmer_is_actor ON contributions AS RESTRICTIVE FOR UPDATE TO modus_app
  USING (true)
  WITH CHECK (confirmed_by_membership_id IS NULL OR confirmed_by_membership_id = app_membership_id());

CREATE POLICY notifications_read ON notifications FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_is_member(organization_id)
         AND recipient_membership_id = app_membership_id());
CREATE POLICY notifications_mark_read ON notifications FOR UPDATE TO modus_app
  USING (organization_id = app_org_id() AND recipient_membership_id = app_membership_id())
  WITH CHECK (organization_id = app_org_id() AND recipient_membership_id = app_membership_id());
CREATE POLICY notifications_emit ON notifications FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND app_is_member(organization_id)
              AND actor_membership_id IS NOT DISTINCT FROM app_membership_id());

CREATE POLICY notification_subscriptions_own ON notification_subscriptions FOR ALL TO modus_app
  USING (organization_id = app_org_id() AND membership_id = app_membership_id())
  WITH CHECK (organization_id = app_org_id() AND membership_id = app_membership_id());

CREATE POLICY audit_events_write ON audit_events FOR INSERT TO modus_app
  WITH CHECK (actor_user_id = app_user_id()
              AND (organization_id IS NULL
                   OR (organization_id = app_org_id() AND app_is_member(organization_id))));
CREATE POLICY audit_events_read ON audit_events FOR SELECT TO modus_app
  USING ((organization_id IS NULL AND actor_user_id = app_user_id())
         OR (organization_id = app_org_id() AND app_has_role(organization_id, 'org_admin')));

CREATE POLICY idempotency_keys_own ON idempotency_keys FOR ALL TO modus_app
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

-- ---------------------------------------------------------------------------
-- Privileges for the application role (least privilege; column-level where
-- only workflow state may change).
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO modus_app;
GRANT SELECT ON users, organizations, memberships, employees TO modus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lab_drafts TO modus_app;
GRANT SELECT, INSERT, DELETE ON lab_draft_versions TO modus_app;
GRANT SELECT, INSERT ON ideas TO modus_app;
GRANT UPDATE (stage, maintainer_membership_id, decision_owner_membership_id,
              current_revision_number, updated_at) ON ideas TO modus_app;
GRANT SELECT, INSERT ON idea_revisions TO modus_app;
GRANT UPDATE (status) ON idea_revisions TO modus_app;
GRANT SELECT, INSERT ON reviews TO modus_app;
GRANT UPDATE (state, resolved_by_membership_id, resolution_note, resolved_at) ON reviews TO modus_app;
GRANT SELECT, INSERT ON verifications TO modus_app;
GRANT UPDATE (owner_membership_id, plan, success_criteria, status, outcome, conclusion,
              concluded_by_membership_id, started_at, completed_at, revision_number) ON verifications TO modus_app;
GRANT SELECT, INSERT ON verification_evidence, decisions TO modus_app;
GRANT SELECT, INSERT ON contributions TO modus_app;
GRANT UPDATE (status, confirmed_by_membership_id, confirmed_at, revoked_reason) ON contributions TO modus_app;
GRANT SELECT, INSERT ON notifications TO modus_app;
GRANT UPDATE (read_at) ON notifications TO modus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_subscriptions TO modus_app;
GRANT SELECT, INSERT ON audit_events TO modus_app;
GRANT SELECT, INSERT ON idempotency_keys TO modus_app;
GRANT EXECUTE ON FUNCTION app_user_id(), app_org_id(), app_membership_id(),
  app_is_member(uuid), app_has_role(uuid, text), app_in_current_org(uuid),
  app_next_idea_number(uuid), app_notification_enabled(uuid, text, uuid) TO modus_app;
REVOKE EXECUTE ON FUNCTION app_next_idea_number(uuid) FROM PUBLIC;
