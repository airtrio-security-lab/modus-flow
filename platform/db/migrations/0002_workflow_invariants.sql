-- MODUS FLOW · Phase 2: review → verification → decision workflow invariants
--
-- Principle: no decision may destroy a person's contribution history or hide
-- evidence of mistakes. Everything below is enforced by PostgreSQL itself, in
-- addition to the service policy (platform/domain/policy.ts).
--
-- Checks that depend on "who is acting" run only when a request identity is
-- bound (app_user_id() IS NOT NULL); operator provisioning without identity
-- is governed by grants and RLS bypass of the schema owner instead.

-- ---------------------------------------------------------------------------
-- 1. Invited reviewers (guest memberships)
-- ---------------------------------------------------------------------------
-- A small team can bring in an independent maintainer or decision owner from
-- outside. A guest sees only the ideas they are assigned to, cannot publish,
-- cannot assign, and is never part of organization-wide triage.
ALTER TABLE memberships
  ADD COLUMN access text NOT NULL DEFAULT 'member' CHECK (access IN ('member','guest'));
ALTER TABLE memberships
  ADD CONSTRAINT memberships_guest_roles CHECK (
    access = 'member'
    OR (roles <@ ARRAY['maintainer','decision_owner'] AND cardinality(roles) > 0));

CREATE OR REPLACE VIEW employees WITH (security_invoker = true) AS
  SELECT m.id AS membership_id, m.organization_id, m.user_id, u.display_name,
         m.department, m.job_title, m.roles, m.status, m.created_at, m.access
    FROM memberships m JOIN users u ON u.id = m.user_id;

CREATE FUNCTION app_full_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_actor_ok() AND EXISTS (
    SELECT 1 FROM public.memberships m WHERE m.id = app_membership_id() AND m.access = 'member')
$$;

CREATE FUNCTION app_idea_visible(idea uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_full_member() OR (app_actor_ok() AND EXISTS (
    SELECT 1 FROM public.ideas i
     WHERE i.id = idea AND i.organization_id = app_org_id()
       AND app_membership_id() IN (i.maintainer_membership_id, i.decision_owner_membership_id)))
$$;

CREATE FUNCTION app_verification_visible(verification uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.verifications v
                  WHERE v.id = verification AND app_idea_visible(v.idea_id))
$$;

GRANT EXECUTE ON FUNCTION app_full_member(), app_idea_visible(uuid), app_verification_visible(uuid) TO modus_app;

CREATE POLICY ideas_guest_scope ON ideas AS RESTRICTIVE FOR ALL TO modus_app
  USING (app_idea_visible(id)) WITH CHECK (app_full_member() OR app_idea_visible(id));
CREATE POLICY ideas_publish_members_only ON ideas AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (app_full_member());
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['idea_revisions','reviews','verifications','decisions','contributions'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO modus_app
         USING (app_idea_visible(idea_id)) WITH CHECK (app_idea_visible(idea_id))',
      t || '_guest_scope', t);
  END LOOP;
END $$;
CREATE POLICY verification_evidence_guest_scope ON verification_evidence AS RESTRICTIVE FOR ALL TO modus_app
  USING (app_verification_visible(verification_id)) WITH CHECK (app_verification_visible(verification_id));

-- ---------------------------------------------------------------------------
-- 2. Idea lifecycle and authority over the idea row
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_stage_transition_ok(from_stage text, to_stage text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (from_stage, to_stage) IN (
    ('published','review'), ('published','development'), ('published','closed'),
    ('review','development'), ('review','verification'), ('review','decision'), ('review','closed'),
    ('development','review'), ('development','closed'),
    ('verification','review'), ('verification','development'), ('verification','decision'), ('verification','closed'),
    ('decision','review'), ('decision','development'), ('decision','adoption'), ('decision','closed'),
    ('adoption','impact_verification'), ('adoption','closed'),
    ('impact_verification','closed'))
$$;

CREATE FUNCTION ideas_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := app_membership_id();
  is_author boolean := coalesce(actor = OLD.author_membership_id, false);
  is_lead boolean := coalesce(actor = OLD.maintainer_membership_id, false)
                     OR coalesce(actor = OLD.decision_owner_membership_id, false);
  org_lead boolean := coalesce(app_full_member()
                      AND (app_has_role(OLD.organization_id, 'maintainer') OR app_has_role(OLD.organization_id, 'decision_owner')), false);
BEGIN
  IF app_user_id() IS NULL THEN
    RETURN NEW;  -- operator provisioning (no request identity bound)
  END IF;

  IF (NEW.maintainer_membership_id, NEW.decision_owner_membership_id)
     IS DISTINCT FROM (OLD.maintainer_membership_id, OLD.decision_owner_membership_id) THEN
    IF is_author OR NOT org_lead THEN
      RAISE EXCEPTION 'only an organization maintainer or decision owner other than the author may assign'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.current_revision_number IS DISTINCT FROM OLD.current_revision_number THEN
    IF NOT is_author THEN
      RAISE EXCEPTION 'only the author changes the current revision' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.idea_revisions r
                    WHERE r.idea_id = NEW.id AND r.number = NEW.current_revision_number AND r.status = 'current') THEN
      RAISE EXCEPTION 'current revision must exist and be marked current' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    IF NOT app_stage_transition_ok(OLD.stage, NEW.stage) THEN
      RAISE EXCEPTION 'stage transition % -> % is not allowed', OLD.stage, NEW.stage USING ERRCODE = '23514';
    END IF;
    -- The author may only hand a revised idea back to review.
    IF is_author AND NOT (OLD.stage = 'development' AND NEW.stage = 'review') THEN
      RAISE EXCEPTION 'the author cannot move the idea through review, verification or decision' USING ERRCODE = '42501';
    END IF;
    IF NOT is_author AND NOT is_lead AND NOT org_lead THEN
      RAISE EXCEPTION 'not allowed to move this idea' USING ERRCODE = '42501';
    END IF;
    IF NEW.stage = 'development' AND NOT EXISTS (
         SELECT 1 FROM public.reviews v WHERE v.idea_id = NEW.id AND v.kind = 'request_changes' AND v.state = 'open') THEN
      RAISE EXCEPTION 'development requires an open change request' USING ERRCODE = '23514';
    END IF;
    IF NEW.stage = 'verification' AND NOT EXISTS (
         SELECT 1 FROM public.verifications v WHERE v.idea_id = NEW.id AND v.purpose = 'hypothesis' AND v.status = 'running') THEN
      RAISE EXCEPTION 'verification stage requires a running verification' USING ERRCODE = '23514';
    END IF;
    IF NEW.stage = 'adoption' AND NOT EXISTS (
         SELECT 1 FROM public.decisions d WHERE d.idea_id = NEW.id AND d.outcome = 'merge') THEN
      RAISE EXCEPTION 'adoption requires a merge decision' USING ERRCODE = '23514';
    END IF;
    IF NEW.stage = 'closed' AND OLD.stage <> 'impact_verification' AND NOT EXISTS (
         SELECT 1 FROM public.decisions d WHERE d.idea_id = NEW.id AND d.outcome IN ('reject','close')) THEN
      RAISE EXCEPTION 'closing requires a reject or close decision with rationale' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ideas_guard_update BEFORE UPDATE ON ideas
  FOR EACH ROW EXECUTE FUNCTION ideas_guard_update();

-- ---------------------------------------------------------------------------
-- 3. Revisions: author owns the text; suggestions keep their own authorship
-- ---------------------------------------------------------------------------
CREATE POLICY idea_revisions_origin_rules ON idea_revisions AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (
    origin = 'publication'
    OR (origin = 'author_update' AND status = 'current' AND EXISTS (
          SELECT 1 FROM ideas i WHERE i.id = idea_revisions.idea_id
             AND i.author_membership_id = idea_revisions.author_membership_id))
    OR (origin = 'suggestion' AND status = 'proposed' AND NOT EXISTS (
          SELECT 1 FROM ideas i WHERE i.id = idea_revisions.idea_id
             AND i.author_membership_id = idea_revisions.author_membership_id)));

CREATE FUNCTION idea_revisions_guard_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('current','declined'))
          OR (OLD.status = 'current' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'revision status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'proposed' AND app_user_id() IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.ideas i WHERE i.id = NEW.idea_id AND i.author_membership_id = app_membership_id()) THEN
    RAISE EXCEPTION 'only the author accepts or declines a suggested revision' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idea_revisions_guard_status BEFORE UPDATE ON idea_revisions
  FOR EACH ROW EXECUTE FUNCTION idea_revisions_guard_status();

-- ---------------------------------------------------------------------------
-- 4. Reviews: who may request changes, and the author's right of reply
-- ---------------------------------------------------------------------------
CREATE POLICY reviews_kind_rules ON reviews AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (
    CASE kind
      WHEN 'objection' THEN EXISTS (
        SELECT 1 FROM ideas i JOIN reviews p ON p.id = reviews.parent_review_id
         WHERE i.id = reviews.idea_id AND i.author_membership_id = reviews.author_membership_id
           AND p.idea_id = reviews.idea_id AND p.kind = 'request_changes')
      WHEN 'request_changes' THEN NOT EXISTS (
        SELECT 1 FROM ideas i WHERE i.id = reviews.idea_id AND i.author_membership_id = reviews.author_membership_id)
      WHEN 'approval' THEN NOT EXISTS (
        SELECT 1 FROM ideas i WHERE i.id = reviews.idea_id AND i.author_membership_id = reviews.author_membership_id)
      ELSE true
    END);

-- ---------------------------------------------------------------------------
-- 5. Verification: one active run, evidence only while running, no "positive"
--    or "negative" outcome without the evidence that supports it
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX verifications_one_active_per_purpose
  ON verifications (idea_id, purpose) WHERE status IN ('planned','running');

CREATE FUNCTION verifications_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ideas i
                  WHERE i.id = NEW.idea_id AND i.current_revision_number = NEW.revision_number
                    AND ((NEW.purpose = 'hypothesis' AND i.stage IN ('review','verification'))
                         OR (NEW.purpose = 'impact' AND i.stage = 'adoption'))) THEN
    RAISE EXCEPTION 'verification must target the current revision at the right stage' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verifications_guard_insert BEFORE INSERT ON verifications
  FOR EACH ROW EXECUTE FUNCTION verifications_guard_insert();

CREATE FUNCTION verifications_require_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
    IF OLD.status <> 'running' THEN
      RAISE EXCEPTION 'only a running verification can be concluded' USING ERRCODE = '23514';
    END IF;
    IF NEW.outcome = 'positive' AND NOT EXISTS (
         SELECT 1 FROM public.verification_evidence e
          WHERE e.verification_id = NEW.id AND e.kind IN ('result','positive_observation')) THEN
      RAISE EXCEPTION 'a positive outcome needs recorded results or positive observations' USING ERRCODE = '23514';
    END IF;
    IF NEW.outcome = 'negative' AND NOT EXISTS (
         SELECT 1 FROM public.verification_evidence e
          WHERE e.verification_id = NEW.id AND e.kind IN ('result','negative_observation')) THEN
      RAISE EXCEPTION 'a negative outcome needs recorded results or negative observations' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verifications_require_evidence BEFORE UPDATE ON verifications
  FOR EACH ROW EXECUTE FUNCTION verifications_require_evidence();

CREATE FUNCTION verification_evidence_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.verifications v WHERE v.id = NEW.verification_id AND v.status = 'running') THEN
    RAISE EXCEPTION 'evidence can only be added to a running verification' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_evidence_guard_insert BEFORE INSERT ON verification_evidence
  FOR EACH ROW EXECUTE FUNCTION verification_evidence_guard_insert();

-- ---------------------------------------------------------------------------
-- 6. Decisions: one per idea, on the current revision, never over an open
--    change request (for merge), with a frozen snapshot of what the decider
--    knew about verifications — negative results stay attached to the decision.
-- ---------------------------------------------------------------------------
ALTER TABLE decisions ADD COLUMN verification_summary jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX decisions_one_per_idea ON decisions (idea_id);

CREATE FUNCTION decisions_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE i record;
BEGIN
  SELECT * INTO i FROM public.ideas WHERE id = NEW.idea_id;
  IF NOT FOUND OR i.current_revision_number <> NEW.revision_number THEN
    RAISE EXCEPTION 'a decision must target the current revision' USING ERRCODE = '23514';
  END IF;
  IF i.stage NOT IN ('review','decision') THEN
    RAISE EXCEPTION 'decisions are taken at the review or decision stage' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'merge' THEN
    IF i.maintainer_membership_id IS NULL THEN
      RAISE EXCEPTION 'merge requires an assigned maintainer' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.reviews v
                WHERE v.idea_id = NEW.idea_id AND v.kind = 'request_changes' AND v.state = 'open') THEN
      RAISE EXCEPTION 'merge is blocked by open change requests' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.verifications v
                WHERE v.idea_id = NEW.idea_id AND v.status IN ('planned','running')) THEN
      RAISE EXCEPTION 'merge is blocked by an unfinished verification' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Server-computed, overrides anything the client sent.
  NEW.verification_summary := coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'verificationId', v.id, 'purpose', v.purpose, 'revision', v.revision_number,
             'status', v.status, 'outcome', v.outcome,
             'positiveEvidence', (SELECT count(*) FROM public.verification_evidence e
                                   WHERE e.verification_id = v.id AND e.kind IN ('result','positive_observation')),
             'negativeEvidence', (SELECT count(*) FROM public.verification_evidence e
                                   WHERE e.verification_id = v.id AND e.kind = 'negative_observation'))
           ORDER BY v.created_at)
      FROM public.verifications v WHERE v.idea_id = NEW.idea_id), '[]'::jsonb);
  RETURN NEW;
END $$;
CREATE TRIGGER decisions_guard_insert BEFORE INSERT ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_guard_insert();

-- ---------------------------------------------------------------------------
-- 7. Notification events for the review conversation
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT notifications_event_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN
  ('idea_published','comment_added','changes_requested','assigned',
   'verification_started','verification_completed','idea_merged',
   'idea_rejected','contribution_confirmed','honor_board_recognition',
   'objection_raised','revision_submitted','suggestion_submitted','suggestion_decided'));

-- ---------------------------------------------------------------------------
-- 8. Truthful chronology
-- ---------------------------------------------------------------------------
-- now() is the transaction START time. Workflow steps wait for the idea row
-- lock, so a step that started earlier can commit later; history timestamps
-- must reflect when the row was actually written (under the lock).
ALTER TABLE idea_revisions        ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE reviews               ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE verifications         ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE verification_evidence ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE decisions             ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE contributions         ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE notifications         ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE audit_events          ALTER COLUMN created_at SET DEFAULT clock_timestamp();
