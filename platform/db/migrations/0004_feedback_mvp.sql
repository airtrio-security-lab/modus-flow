-- MODUS FLOW · Phase 2.5: feedback MVP for the Modus Trade hackathon brief
--
-- Owner's problem (video brief, 2026-11-10): questions arrive chaotically
-- (e-mail, meetings, phone), get forgotten, and people stop raising them.
-- This migration makes sure nothing is lost and everyone can see progress:
--   * categories, departments and routing rules: the DATABASE picks the
--     responsible person when an item is registered (cannot be forged),
--     falling back to the head of department, else the "unrouted" queue;
--   * source channel (meeting / e-mail / phone / ...) and "raised by";
--   * deadlines for first response and decision, stale detection, escalation;
--   * progress reports by the responsible person, implementer, "implemented";
--   * attachments, full-text search, similar-item detection;
--   * idea_overview: one read model with the author-facing status.
-- Owner decision (2026-11-10): hybrid powers — a head of department may both
-- lead and decide a simple item; a field verification still requires two
-- different people.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. Organization settings
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN default_first_response_hours integer NOT NULL DEFAULT 48 CHECK (default_first_response_hours BETWEEN 1 AND 720),
  ADD COLUMN default_resolution_days integer NOT NULL DEFAULT 14 CHECK (default_resolution_days BETWEEN 1 AND 365),
  ADD COLUMN stale_days integer NOT NULL DEFAULT 7 CHECK (stale_days BETWEEN 1 AND 90),
  ADD COLUMN escalation_membership_id uuid;
ALTER TABLE organizations
  ADD CONSTRAINT organizations_escalation_fk FOREIGN KEY (id, escalation_membership_id)
  REFERENCES memberships (organization_id, id);

GRANT SELECT (default_first_response_hours, default_resolution_days, stale_days, escalation_membership_id) ON organizations TO modus_app;
GRANT UPDATE (default_first_response_hours, default_resolution_days, stale_days, escalation_membership_id) ON organizations TO modus_app;
CREATE POLICY organizations_admin_update ON organizations FOR UPDATE TO modus_app
  USING (id = app_org_id() AND app_full_member() AND app_has_role(id, 'org_admin'))
  WITH CHECK (id = app_org_id() AND app_full_member() AND app_has_role(id, 'org_admin'));

-- ---------------------------------------------------------------------------
-- 2. Reference data: departments, categories, routing rules (admin-managed)
-- ---------------------------------------------------------------------------
CREATE TABLE departments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  head_membership_id  uuid,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, head_membership_id) REFERENCES memberships(organization_id, id)
);

CREATE TABLE categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  description     text CHECK (description IS NULL OR length(description) <= 500),
  sort_order      integer NOT NULL DEFAULT 100,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, id)
);

CREATE TABLE routing_rules (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id              uuid NOT NULL REFERENCES organizations(id),
  category_id                  uuid,
  department_id                uuid,
  priority                     integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000),
  maintainer_membership_id     uuid NOT NULL,
  decision_owner_membership_id uuid,
  escalate_to_membership_id    uuid,
  first_response_hours         integer CHECK (first_response_hours IS NULL OR first_response_hours BETWEEN 1 AND 720),
  resolution_days              integer CHECK (resolution_days IS NULL OR resolution_days BETWEEN 1 AND 365),
  active                       boolean NOT NULL DEFAULT true,
  created_by_membership_id     uuid,
  created_at                   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, category_id) REFERENCES categories(organization_id, id),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id),
  FOREIGN KEY (organization_id, maintainer_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, decision_owner_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, escalate_to_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES memberships(organization_id, id)
);

-- Rule assignees must hold the roles they are given, at the time the rule is
-- written. Routing re-checks at registration and skips stale rules.
CREATE FUNCTION routing_rules_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.id = NEW.maintainer_membership_id
                    AND m.status = 'active' AND 'maintainer' = ANY (m.roles)) THEN
    RAISE EXCEPTION 'rule maintainer must hold the maintainer role' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision_owner_membership_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.memberships m WHERE m.id = NEW.decision_owner_membership_id
          AND m.status = 'active' AND 'decision_owner' = ANY (m.roles)) THEN
    RAISE EXCEPTION 'rule decision owner must hold the decision_owner role' USING ERRCODE = '23514';
  END IF;
  IF app_user_id() IS NOT NULL THEN
    NEW.created_by_membership_id := coalesce(NEW.created_by_membership_id, app_membership_id());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER routing_rules_validate BEFORE INSERT OR UPDATE ON routing_rules
  FOR EACH ROW EXECUTE FUNCTION routing_rules_validate();

ALTER TABLE departments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories    ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['departments','categories','routing_rules'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO modus_app
                      USING (organization_id = app_org_id() AND app_actor_ok())', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO modus_app
                      WITH CHECK (organization_id = app_org_id() AND app_full_member() AND app_has_role(organization_id, ''org_admin''))',
                   t || '_admin_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO modus_app
                      USING (organization_id = app_org_id() AND app_full_member() AND app_has_role(organization_id, ''org_admin''))
                      WITH CHECK (organization_id = app_org_id() AND app_full_member() AND app_has_role(organization_id, ''org_admin''))',
                   t || '_admin_update', t);
  END LOOP;
END $$;
-- Routing rules reveal who handles what; guests do not need them.
CREATE POLICY routing_rules_members_only ON routing_rules AS RESTRICTIVE FOR SELECT TO modus_app
  USING (app_full_member());

GRANT SELECT, INSERT ON departments, categories, routing_rules TO modus_app;
GRANT UPDATE (name, head_membership_id, active) ON departments TO modus_app;
GRANT UPDATE (name, description, sort_order, active) ON categories TO modus_app;
GRANT UPDATE (category_id, department_id, priority, maintainer_membership_id, decision_owner_membership_id,
              escalate_to_membership_id, first_response_hours, resolution_days, active) ON routing_rules TO modus_app;

-- ---------------------------------------------------------------------------
-- 3. Idea intake fields
-- ---------------------------------------------------------------------------
ALTER TABLE ideas
  ADD COLUMN category_id uuid,
  ADD COLUMN department_id uuid,
  ADD COLUMN routing_rule_id uuid,
  ADD COLUMN source_channel text NOT NULL DEFAULT 'app'
    CHECK (source_channel IN ('app','meeting','email','phone','conversation','other')),
  ADD COLUMN source_note text CHECK (source_note IS NULL OR length(source_note) <= 300),
  ADD COLUMN raised_by_membership_id uuid,
  ADD COLUMN implementer_membership_id uuid,
  ADD COLUMN first_response_due_at timestamptz,
  ADD COLUMN resolution_due_at timestamptz,
  ADD COLUMN first_response_at timestamptz;
ALTER TABLE ideas
  ADD CONSTRAINT ideas_category_fk FOREIGN KEY (organization_id, category_id) REFERENCES categories(organization_id, id),
  ADD CONSTRAINT ideas_department_fk FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id),
  ADD CONSTRAINT ideas_rule_fk FOREIGN KEY (organization_id, routing_rule_id) REFERENCES routing_rules(organization_id, id),
  ADD CONSTRAINT ideas_raised_by_fk FOREIGN KEY (organization_id, raised_by_membership_id) REFERENCES memberships(organization_id, id),
  ADD CONSTRAINT ideas_implementer_fk FOREIGN KEY (organization_id, implementer_membership_id) REFERENCES memberships(organization_id, id),
  ADD CONSTRAINT ideas_raised_by_not_author CHECK (raised_by_membership_id IS DISTINCT FROM author_membership_id);
GRANT UPDATE (implementer_membership_id) ON ideas TO modus_app;

-- Problems may be reported without a proposed solution; ideas still need one.
ALTER TABLE idea_revisions ALTER COLUMN proposal DROP NOT NULL;
CREATE FUNCTION idea_revisions_proposal_by_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.proposal IS NULL AND EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = NEW.idea_id AND i.kind = 'idea') THEN
    RAISE EXCEPTION 'an idea needs a proposal; report a problem instead' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idea_revisions_proposal_by_kind BEFORE INSERT ON idea_revisions
  FOR EACH ROW EXECUTE FUNCTION idea_revisions_proposal_by_kind();

-- ---------------------------------------------------------------------------
-- 4. Routing — decided by the database at registration
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_has_member_role(mid uuid, role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.memberships m
                  WHERE m.id = mid AND m.status = 'active' AND role = ANY (m.roles))
$$;

CREATE FUNCTION ideas_route_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o record;
  r record;
  excluded uuid[] := ARRAY[NEW.author_membership_id, NEW.raised_by_membership_id];
  dept_head uuid;
BEGIN
  SELECT * INTO o FROM public.organizations WHERE id = NEW.organization_id;
  IF NEW.raised_by_membership_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.memberships m WHERE m.id = NEW.raised_by_membership_id
          AND m.organization_id = NEW.organization_id AND m.status = 'active' AND m.access = 'member') THEN
    RAISE EXCEPTION 'raised_by must be an active employee' USING ERRCODE = '23514';
  END IF;
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.id = NEW.category_id AND c.active) THEN
    RAISE EXCEPTION 'category is inactive' USING ERRCODE = '23514';
  END IF;
  IF NEW.department_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = NEW.department_id AND d.active) THEN
    RAISE EXCEPTION 'department is inactive' USING ERRCODE = '23514';
  END IF;

  -- Never trust client-supplied routing or workflow fields.
  NEW.maintainer_membership_id := NULL;
  NEW.decision_owner_membership_id := NULL;
  NEW.implementer_membership_id := NULL;
  NEW.routing_rule_id := NULL;
  NEW.first_response_at := NULL;
  NEW.stage := 'published';

  SELECT * INTO r FROM public.routing_rules rr
   WHERE rr.organization_id = NEW.organization_id AND rr.active
     AND (rr.category_id IS NULL OR rr.category_id = NEW.category_id)
     AND (rr.department_id IS NULL OR rr.department_id = NEW.department_id)
     AND NOT (rr.maintainer_membership_id = ANY (excluded))
     AND (rr.decision_owner_membership_id IS NULL OR NOT (rr.decision_owner_membership_id = ANY (excluded)))
     AND app_has_member_role(rr.maintainer_membership_id, 'maintainer')
     AND (rr.decision_owner_membership_id IS NULL OR app_has_member_role(rr.decision_owner_membership_id, 'decision_owner'))
   ORDER BY (rr.category_id IS NOT NULL)::int + (rr.department_id IS NOT NULL)::int DESC, rr.priority, rr.created_at
   LIMIT 1;

  IF FOUND THEN
    NEW.routing_rule_id := r.id;
    NEW.maintainer_membership_id := r.maintainer_membership_id;
    -- Hybrid: a rule without a separate decision owner gives the decision to the
    -- maintainer when they hold the decision_owner role.
    NEW.decision_owner_membership_id := coalesce(r.decision_owner_membership_id,
      CASE WHEN app_has_member_role(r.maintainer_membership_id, 'decision_owner') THEN r.maintainer_membership_id END);
    NEW.first_response_due_at := NEW.published_at + make_interval(hours => coalesce(r.first_response_hours, o.default_first_response_hours));
    NEW.resolution_due_at := NEW.published_at + make_interval(days => coalesce(r.resolution_days, o.default_resolution_days));
  ELSE
    SELECT d.head_membership_id INTO dept_head FROM public.departments d WHERE d.id = NEW.department_id;
    IF dept_head IS NOT NULL AND NOT (dept_head = ANY (excluded)) AND app_has_member_role(dept_head, 'maintainer') THEN
      NEW.maintainer_membership_id := dept_head;
      NEW.decision_owner_membership_id := CASE WHEN app_has_member_role(dept_head, 'decision_owner') THEN dept_head END;
    END IF;
    NEW.first_response_due_at := NEW.published_at + make_interval(hours => o.default_first_response_hours);
    NEW.resolution_due_at := NEW.published_at + make_interval(days => o.default_resolution_days);
  END IF;

  IF NEW.maintainer_membership_id IS NOT NULL THEN
    NEW.stage := 'review';
  END IF;
  RETURN NEW;
END $$;
-- "a10_" fires before ideas_guard_assignment (alphabetical order of BEFORE triggers).
CREATE TRIGGER a10_ideas_route BEFORE INSERT ON ideas
  FOR EACH ROW EXECUTE FUNCTION ideas_route_on_insert();

-- ---------------------------------------------------------------------------
-- 5. Hybrid powers (owner decision 2026-11-10)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ideas_guard_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  maint_changed boolean := true;
  owner_changed boolean := true;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    maint_changed := NEW.maintainer_membership_id IS DISTINCT FROM OLD.maintainer_membership_id;
    owner_changed := NEW.decision_owner_membership_id IS DISTINCT FROM OLD.decision_owner_membership_id;
    IF NOT maint_changed AND NOT owner_changed THEN
      RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = NEW.id AND v.status IN ('planned','running')) THEN
      RAISE EXCEPTION 'assignments are frozen while a verification is active' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.author_membership_id IN (NEW.maintainer_membership_id, NEW.decision_owner_membership_id)
     OR NEW.raised_by_membership_id IN (NEW.maintainer_membership_id, NEW.decision_owner_membership_id) THEN
    RAISE EXCEPTION 'whoever raised the item cannot lead or decide it' USING ERRCODE = '23514';
  END IF;
  IF maint_changed AND NEW.maintainer_membership_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.memberships m WHERE m.id = NEW.maintainer_membership_id
          AND m.status = 'active' AND 'maintainer' = ANY (m.roles)) THEN
    RAISE EXCEPTION 'maintainer must hold the maintainer role' USING ERRCODE = '23514';
  END IF;
  IF owner_changed AND NEW.decision_owner_membership_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.memberships m WHERE m.id = NEW.decision_owner_membership_id
          AND m.status = 'active' AND 'decision_owner' = ANY (m.roles)) THEN
    RAISE EXCEPTION 'decision owner must hold the decision_owner role' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A field verification still needs two different people.
DROP POLICY verifications_started_by_maintainer ON verifications;
CREATE POLICY verifications_started_by_maintainer ON verifications AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM ideas i
     WHERE i.id = verifications.idea_id
       AND i.maintainer_membership_id = verifications.created_by_membership_id
       AND i.decision_owner_membership_id IS NOT NULL
       AND i.decision_owner_membership_id <> i.maintainer_membership_id
       AND NOT (verifications.owner_membership_id IN (i.author_membership_id, i.decision_owner_membership_id))
       AND verifications.owner_membership_id IS DISTINCT FROM i.raised_by_membership_id
       AND (verifications.owner_membership_id = i.maintainer_membership_id
            OR EXISTS (SELECT 1 FROM memberships m WHERE m.id = verifications.owner_membership_id
                                                     AND m.access = 'member' AND m.status = 'active'))));

CREATE POLICY decisions_not_by_raiser ON decisions AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (NOT EXISTS (SELECT 1 FROM ideas i WHERE i.id = decisions.idea_id
                             AND i.raised_by_membership_id = decisions.decided_by_membership_id));

-- ---------------------------------------------------------------------------
-- 6. Stage machine: implementer may report completion; implementer is set by
--    the idea leads during decision/adoption only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ideas_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := app_membership_id();
  is_author boolean := coalesce(actor = OLD.author_membership_id, false);
  is_lead boolean := coalesce(actor = OLD.maintainer_membership_id, false)
                     OR coalesce(actor = OLD.decision_owner_membership_id, false);
  is_implementer boolean := coalesce(actor = OLD.implementer_membership_id, false);
  org_lead boolean := coalesce(app_full_member()
                      AND (app_has_role(OLD.organization_id, 'maintainer') OR app_has_role(OLD.organization_id, 'decision_owner')), false);
BEGIN
  IF app_user_id() IS NULL THEN
    RETURN NEW;
  END IF;

  IF (NEW.category_id, NEW.department_id, NEW.routing_rule_id, NEW.source_channel, NEW.source_note,
      NEW.raised_by_membership_id, NEW.first_response_due_at, NEW.resolution_due_at)
     IS DISTINCT FROM
     (OLD.category_id, OLD.department_id, OLD.routing_rule_id, OLD.source_channel, OLD.source_note,
      OLD.raised_by_membership_id, OLD.first_response_due_at, OLD.resolution_due_at) THEN
    RAISE EXCEPTION 'registration data is immutable' USING ERRCODE = '42501';
  END IF;

  IF (NEW.maintainer_membership_id, NEW.decision_owner_membership_id)
     IS DISTINCT FROM (OLD.maintainer_membership_id, OLD.decision_owner_membership_id) THEN
    IF is_author OR NOT org_lead THEN
      RAISE EXCEPTION 'only an organization maintainer or decision owner other than the author may assign'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.implementer_membership_id IS DISTINCT FROM OLD.implementer_membership_id THEN
    IF NOT is_lead OR OLD.stage NOT IN ('decision','review','adoption') THEN
      RAISE EXCEPTION 'only the idea leads appoint the implementer, at decision or adoption' USING ERRCODE = '42501';
    END IF;
    IF NEW.implementer_membership_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.memberships m WHERE m.id = NEW.implementer_membership_id
            AND m.organization_id = NEW.organization_id AND m.status = 'active' AND m.access = 'member') THEN
      RAISE EXCEPTION 'implementer must be an active employee' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.current_revision_number IS DISTINCT FROM OLD.current_revision_number THEN
    IF NOT is_author THEN
      RAISE EXCEPTION 'only the author changes the current revision' USING ERRCODE = '42501';
    END IF;
    IF OLD.stage NOT IN ('published','review','development') THEN
      RAISE EXCEPTION 'the text cannot change during verification, decision or adoption' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    IF NOT app_stage_transition_ok(OLD.stage, NEW.stage) THEN
      RAISE EXCEPTION 'stage transition % -> % is not allowed', OLD.stage, NEW.stage USING ERRCODE = '23514';
    END IF;
    IF OLD.stage = 'adoption' AND NEW.stage = 'impact_verification' AND (is_implementer OR is_lead) THEN
      NULL;  -- implementation reported done
    ELSIF is_author THEN
      IF NOT (OLD.stage = 'development' AND NEW.stage = 'review') THEN
        RAISE EXCEPTION 'the author cannot move the idea through review, verification or decision' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT is_lead AND NOT (org_lead AND OLD.stage = 'published' AND NEW.stage IN ('review','development')) THEN
      RAISE EXCEPTION 'only the assigned maintainer or decision owner moves this idea' USING ERRCODE = '42501';
    END IF;
    IF NEW.stage = 'development' AND NOT EXISTS (
         SELECT 1 FROM public.reviews v WHERE v.idea_id = NEW.id AND v.kind = 'request_changes' AND v.state = 'open') THEN
      RAISE EXCEPTION 'development requires an open change request' USING ERRCODE = '23514';
    END IF;
    IF NEW.stage = 'verification' AND NOT EXISTS (
         SELECT 1 FROM public.verifications v WHERE v.idea_id = NEW.id AND v.purpose = 'hypothesis' AND v.status = 'running') THEN
      RAISE EXCEPTION 'verification stage requires a running verification' USING ERRCODE = '23514';
    END IF;
    IF OLD.stage = 'verification' AND EXISTS (
         SELECT 1 FROM public.verifications v WHERE v.idea_id = NEW.id AND v.purpose = 'hypothesis' AND v.status IN ('planned','running')) THEN
      RAISE EXCEPTION 'conclude or cancel the running verification first' USING ERRCODE = '23514';
    END IF;
    IF OLD.stage = 'verification' AND NEW.stage = 'decision' AND NOT EXISTS (
         SELECT 1 FROM public.verifications v WHERE v.idea_id = NEW.id AND v.purpose = 'hypothesis'
            AND v.status = 'completed' AND v.revision_number = NEW.current_revision_number) THEN
      RAISE EXCEPTION 'decision after verification requires a completed verification of the current text' USING ERRCODE = '23514';
    END IF;
    IF NEW.stage = 'adoption' AND NOT EXISTS (
         SELECT 1 FROM public.decisions d WHERE d.idea_id = NEW.id AND d.outcome = 'merge') THEN
      RAISE EXCEPTION 'adoption requires a merge decision' USING ERRCODE = '23514';
    END IF;
    IF NEW.stage = 'impact_verification' AND NOT EXISTS (
         SELECT 1 FROM public.reviews v WHERE v.idea_id = NEW.id AND v.kind = 'progress'
            AND v.author_membership_id = actor AND v.created_at >= (SELECT max(d.created_at) FROM public.decisions d WHERE d.idea_id = NEW.id)) THEN
      RAISE EXCEPTION 'completing implementation requires a progress report' USING ERRCODE = '23514';
    END IF;
    IF NEW.stage = 'closed' AND OLD.stage <> 'impact_verification' AND NOT EXISTS (
         SELECT 1 FROM public.decisions d WHERE d.idea_id = NEW.id AND d.outcome IN ('reject','close')) THEN
      RAISE EXCEPTION 'closing requires a reject or close decision with rationale' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Progress reports ("отчитываться о статусах")
-- ---------------------------------------------------------------------------
ALTER TABLE reviews DROP CONSTRAINT reviews_kind_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_kind_check
  CHECK (kind IN ('comment','request_changes','objection','approval','progress'));
CREATE POLICY reviews_progress_by_responsible ON reviews AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (reviews.kind <> 'progress' OR EXISTS (
    SELECT 1 FROM ideas i WHERE i.id = reviews.idea_id
       AND reviews.author_membership_id IN (i.maintainer_membership_id, i.decision_owner_membership_id, i.implementer_membership_id)));

-- First response = first comment, change request, approval, progress report or
-- decision by someone responsible for the item.
CREATE FUNCTION mark_first_response(idea uuid, who uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.ideas i SET first_response_at = clock_timestamp()
   WHERE i.id = idea AND i.first_response_at IS NULL
     AND who IN (i.maintainer_membership_id, i.decision_owner_membership_id, i.implementer_membership_id)
$$;
REVOKE EXECUTE ON FUNCTION mark_first_response(uuid, uuid) FROM PUBLIC;
CREATE FUNCTION reviews_mark_first_response() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind <> 'objection' THEN
    PERFORM mark_first_response(NEW.idea_id, NEW.author_membership_id);
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION decisions_mark_first_response() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM mark_first_response(NEW.idea_id, NEW.decided_by_membership_id);
  RETURN NULL;
END $$;
CREATE TRIGGER ideas_first_response_from_review AFTER INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_mark_first_response();
CREATE TRIGGER ideas_first_response_from_decision AFTER INSERT ON decisions
  FOR EACH ROW EXECUTE FUNCTION decisions_mark_first_response();

-- ---------------------------------------------------------------------------
-- 8. Contributions backed by records (adds issue_found and implementation)
-- ---------------------------------------------------------------------------
DROP POLICY contributions_backed_by_record ON contributions;
CREATE POLICY contributions_backed_by_record ON contributions AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (CASE contributions.kind
    WHEN 'authorship' THEN contributions.source_type = 'idea' AND contributions.source_id = contributions.idea_id
      AND EXISTS (SELECT 1 FROM ideas i WHERE i.id = contributions.idea_id
                     AND i.author_membership_id = contributions.membership_id)
    WHEN 'issue_found' THEN contributions.source_type = 'idea' AND contributions.source_id = contributions.idea_id
      AND EXISTS (SELECT 1 FROM ideas i WHERE i.id = contributions.idea_id
                     AND i.raised_by_membership_id = contributions.membership_id)
    WHEN 'implementation' THEN contributions.source_type = 'idea' AND contributions.source_id = contributions.idea_id
      AND EXISTS (SELECT 1 FROM ideas i WHERE i.id = contributions.idea_id
                     AND i.implementer_membership_id = contributions.membership_id
                     AND i.stage IN ('impact_verification','closed'))
    WHEN 'review' THEN contributions.source_type = 'review'
      AND EXISTS (SELECT 1 FROM reviews r WHERE r.id = contributions.source_id AND r.idea_id = contributions.idea_id
                     AND r.author_membership_id = contributions.membership_id AND r.kind IN ('request_changes','approval'))
    WHEN 'verification' THEN contributions.source_type = 'verification'
      AND EXISTS (SELECT 1 FROM verifications v WHERE v.id = contributions.source_id AND v.idea_id = contributions.idea_id
                     AND v.owner_membership_id = contributions.membership_id)
    WHEN 'negative_result' THEN contributions.source_type = 'verification'
      AND EXISTS (SELECT 1 FROM verifications v WHERE v.id = contributions.source_id AND v.idea_id = contributions.idea_id
                     AND v.owner_membership_id = contributions.membership_id
                     AND v.status = 'completed' AND v.outcome = 'negative')
    WHEN 'co_authorship' THEN contributions.source_type = 'revision'
      AND EXISTS (SELECT 1 FROM idea_revisions r WHERE r.id = contributions.source_id AND r.idea_id = contributions.idea_id
                     AND r.author_membership_id = contributions.membership_id
                     AND r.origin = 'suggestion' AND r.status IN ('current','superseded'))
    ELSE false
  END);

CREATE OR REPLACE FUNCTION contributions_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = OLD.status AND (NEW.confirmed_by_membership_id, NEW.confirmed_at, NEW.revoked_reason)
       IS NOT DISTINCT FROM (OLD.confirmed_by_membership_id, OLD.confirmed_at, OLD.revoked_reason) THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'recorded' AND NEW.status IN ('confirmed','revoked'))
          OR (OLD.status = 'confirmed' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'contribution status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'revoked' THEN
    IF OLD.kind IN ('authorship','co_authorship','review','verification','negative_result','issue_found','implementation') THEN
      RAISE EXCEPTION 'contributions recorded from workflow facts cannot be revoked' USING ERRCODE = 'P0001';
    END IF;
    IF app_user_id() IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.ideas i WHERE i.id = NEW.idea_id
            AND app_membership_id() IN (i.maintainer_membership_id, i.decision_owner_membership_id)) THEN
      RAISE EXCEPTION 'only the idea leads revoke a contribution' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Attachments (append-only; size/type limits; hash computed by the DB)
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  idea_id                   uuid NOT NULL,
  uploaded_by_membership_id uuid NOT NULL,
  file_name                 text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200 AND file_name !~ '[/\\[:cntrl:]]'),
  content_type              text NOT NULL CHECK (content_type IN (
                              'image/png','image/jpeg','image/webp','application/pdf','text/plain',
                              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  size_bytes                integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256                    text NOT NULL,
  data                      bytea NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, uploaded_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE INDEX attachments_idea ON attachments (idea_id, created_at);

CREATE FUNCTION attachments_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.size_bytes := octet_length(NEW.data);
  NEW.sha256 := encode(sha256(NEW.data), 'hex');
  IF NEW.size_bytes > 5242880 THEN
    RAISE EXCEPTION 'attachment too large' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM public.attachments a WHERE a.idea_id = NEW.idea_id) >= 10 THEN
    RAISE EXCEPTION 'at most 10 attachments per item' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = NEW.idea_id AND i.stage = 'closed') THEN
    RAISE EXCEPTION 'the item is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_lock_idea BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION lock_parent_idea();
CREATE TRIGGER attachments_guard_insert BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION attachments_guard_insert();
CREATE TRIGGER attachments_append_only BEFORE UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachments_tenant ON attachments FOR ALL TO modus_app
  USING (organization_id = app_org_id() AND app_actor_ok() AND app_idea_visible(idea_id))
  WITH CHECK (organization_id = app_org_id() AND app_actor_ok() AND app_idea_visible(idea_id)
              AND uploaded_by_membership_id = app_membership_id());
GRANT SELECT, INSERT ON attachments TO modus_app;

-- ---------------------------------------------------------------------------
-- 10. Escalations (written by the operator job platform/cli/escalate.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE escalations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL,
  idea_id                    uuid NOT NULL,
  kind                       text NOT NULL CHECK (kind IN ('first_response','resolution','stale')),
  escalated_to_membership_id uuid,
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (idea_id, kind),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, escalated_to_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER escalations_append_only BEFORE UPDATE OR DELETE ON escalations FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE escalations ENABLE ROW LEVEL SECURITY;
CREATE POLICY escalations_read ON escalations FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_actor_ok() AND app_idea_visible(idea_id));
GRANT SELECT ON escalations TO modus_app;

ALTER TABLE notifications DROP CONSTRAINT notifications_event_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN
  ('idea_published','comment_added','changes_requested','assigned',
   'verification_started','verification_completed','idea_merged',
   'idea_rejected','contribution_confirmed','honor_board_recognition',
   'objection_raised','revision_submitted','suggestion_submitted','suggestion_decided',
   'status_report','implemented','raised_on_behalf','escalated'));

-- ---------------------------------------------------------------------------
-- 11. Notification gateway: new events; targeted events only to the people
--     they concern.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_notify(event text, idea uuid, recipients uuid[], dedupe text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := app_membership_id();
  org uuid := app_org_id();
  proven boolean;
  n integer;
  i record;
BEGIN
  IF NOT app_actor_ok() OR idea IS NULL OR NOT app_idea_visible(idea) THEN
    RAISE EXCEPTION 'notification not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO i FROM public.ideas x WHERE x.id = idea AND x.organization_id = org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'notification not allowed' USING ERRCODE = '42501';
  END IF;
  proven := CASE event
    WHEN 'idea_published' THEN i.author_membership_id = actor
    WHEN 'raised_on_behalf' THEN i.author_membership_id = actor AND i.raised_by_membership_id IS NOT NULL
    WHEN 'assigned' THEN EXISTS (SELECT 1 FROM public.audit_events a WHERE a.entity_id = idea
                                    AND a.action = 'idea.assigned' AND a.actor_user_id = app_user_id())
    WHEN 'comment_added' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND (r.author_membership_id = actor OR r.resolved_by_membership_id = actor))
    WHEN 'changes_requested' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND r.kind = 'request_changes' AND r.author_membership_id = actor)
    WHEN 'objection_raised' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND r.kind = 'objection' AND r.author_membership_id = actor)
    WHEN 'status_report' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND r.kind = 'progress' AND r.author_membership_id = actor)
    WHEN 'implemented' THEN i.stage IN ('impact_verification','closed')
                            AND actor IN (i.implementer_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)
    WHEN 'revision_submitted' THEN EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea
                                    AND r.origin = 'author_update' AND r.author_membership_id = actor)
    WHEN 'suggestion_submitted' THEN EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea
                                    AND r.origin = 'suggestion' AND r.author_membership_id = actor)
    WHEN 'suggestion_decided' THEN i.author_membership_id = actor AND EXISTS (
                                    SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea
                                      AND r.origin = 'suggestion' AND r.status IN ('current','superseded','declined'))
    WHEN 'verification_started' THEN EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = idea
                                    AND v.created_by_membership_id = actor)
    WHEN 'verification_completed' THEN EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = idea
                                    AND v.concluded_by_membership_id = actor AND v.status = 'completed')
    WHEN 'idea_merged' THEN EXISTS (SELECT 1 FROM public.decisions d WHERE d.idea_id = idea
                                    AND d.decided_by_membership_id = actor AND d.outcome = 'merge')
    WHEN 'idea_rejected' THEN EXISTS (SELECT 1 FROM public.decisions d WHERE d.idea_id = idea
                                    AND d.decided_by_membership_id = actor AND d.outcome IN ('reject','close'))
    ELSE false
  END;
  IF NOT coalesce(proven, false) THEN
    RAISE EXCEPTION 'notification is not backed by a workflow record' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
  SELECT org, m.id, actor, event, idea, event || ':' || dedupe
    FROM public.memberships m
   WHERE m.id = ANY (recipients) AND m.id <> actor AND m.organization_id = org AND m.status = 'active'
     AND (m.access = 'member' OR m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id))
     AND CASE event
           WHEN 'assigned' THEN m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id, i.implementer_membership_id)
           WHEN 'raised_on_behalf' THEN m.id = i.raised_by_membership_id
           ELSE true
         END
     AND app_notification_enabled(m.id, event, idea)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- 12. Search
-- ---------------------------------------------------------------------------
CREATE INDEX idea_revisions_fts ON idea_revisions
  USING gin (to_tsvector('russian', title || ' ' || problem || ' ' || coalesce(proposal, '')));
CREATE INDEX idea_revisions_title_trgm ON idea_revisions USING gin (title gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 13. Read model with the author-facing status
-- ---------------------------------------------------------------------------
CREATE VIEW idea_overview WITH (security_invoker = true) AS
SELECT
  i.id, i.organization_id, i.number, i.kind, r.title, r.problem, r.proposal, i.stage,
  CASE
    WHEN i.stage = 'closed' THEN coalesce((SELECT CASE d.outcome WHEN 'merge' THEN 'implemented'
                                                                  WHEN 'reject' THEN 'rejected' ELSE 'closed' END
                                             FROM decisions d WHERE d.idea_id = i.id), 'implemented')
    WHEN i.stage = 'impact_verification' THEN 'implemented'
    WHEN i.stage = 'adoption' THEN 'in_progress'
    WHEN i.stage = 'decision' THEN 'decision'
    WHEN i.stage = 'verification' THEN 'in_verification'
    WHEN i.stage = 'development' THEN 'needs_info'
    WHEN i.maintainer_membership_id IS NULL THEN 'unrouted'
    ELSE 'in_review'
  END AS status,
  i.category_id, c.name AS category, i.department_id, dp.name AS department,
  i.source_channel, i.source_note,
  i.author_membership_id, ea.display_name AS author,
  i.raised_by_membership_id, er.display_name AS raised_by,
  i.maintainer_membership_id, em.display_name AS maintainer,
  i.decision_owner_membership_id, ed.display_name AS decision_owner,
  i.implementer_membership_id, ei.display_name AS implementer,
  i.current_revision_number, i.published_at, i.updated_at,
  i.first_response_due_at, i.first_response_at, i.resolution_due_at,
  (i.first_response_at IS NULL AND i.stage <> 'closed' AND i.first_response_due_at < now()) AS overdue_first_response,
  (i.stage IN ('published','review','development','verification','decision') AND i.resolution_due_at < now()) AS overdue_resolution,
  (i.stage NOT IN ('closed','impact_verification') AND i.updated_at < now() - make_interval(days => o.stale_days)) AS stale
FROM ideas i
JOIN idea_revisions r ON r.idea_id = i.id AND r.number = i.current_revision_number
JOIN organizations o ON o.id = i.organization_id
LEFT JOIN categories c ON c.id = i.category_id
LEFT JOIN departments dp ON dp.id = i.department_id
LEFT JOIN employees ea ON ea.membership_id = i.author_membership_id
LEFT JOIN employees er ON er.membership_id = i.raised_by_membership_id
LEFT JOIN employees em ON em.membership_id = i.maintainer_membership_id
LEFT JOIN employees ed ON ed.membership_id = i.decision_owner_membership_id
LEFT JOIN employees ei ON ei.membership_id = i.implementer_membership_id;
GRANT SELECT ON idea_overview TO modus_app;

-- ---------------------------------------------------------------------------
-- 14. Escalation job (operator connection; no request identity)
-- ---------------------------------------------------------------------------
CREATE FUNCTION escalate_overdue(at timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer := 0; x record; target uuid;
BEGIN
  FOR x IN
    SELECT i.id, i.organization_id, i.maintainer_membership_id, k.kind,
           coalesce(rr.escalate_to_membership_id, o.escalation_membership_id) AS esc
      FROM ideas i
      JOIN organizations o ON o.id = i.organization_id
      LEFT JOIN routing_rules rr ON rr.id = i.routing_rule_id
      CROSS JOIN LATERAL (VALUES
        ('first_response', i.first_response_at IS NULL AND i.stage <> 'closed' AND i.first_response_due_at < at),
        ('resolution', i.stage IN ('published','review','development','verification','decision') AND i.resolution_due_at < at),
        ('stale', i.stage NOT IN ('closed','impact_verification') AND i.updated_at < at - make_interval(days => o.stale_days))
      ) AS k(kind, due)
     WHERE k.due
       AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.idea_id = i.id AND e.kind = k.kind)
  LOOP
    target := x.esc;
    INSERT INTO escalations (organization_id, idea_id, kind, escalated_to_membership_id)
    VALUES (x.organization_id, x.id, x.kind, target);
    INSERT INTO notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
    SELECT x.organization_id, m, NULL, 'escalated', x.id, 'escalated:' || x.kind || ':' || x.id
      FROM unnest(ARRAY[target, x.maintainer_membership_id]) AS m
     WHERE m IS NOT NULL
    ON CONFLICT DO NOTHING;
    -- Unrouted items escalate to every organization admin as well, so they are never orphaned.
    IF x.maintainer_membership_id IS NULL THEN
      INSERT INTO notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
      SELECT x.organization_id, m.id, NULL, 'escalated', x.id, 'escalated:' || x.kind || ':' || x.id
        FROM memberships m WHERE m.organization_id = x.organization_id AND m.status = 'active'
         AND m.access = 'member' AND 'org_admin' = ANY (m.roles)
      ON CONFLICT DO NOTHING;
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION escalate_overdue(timestamptz) FROM PUBLIC;
