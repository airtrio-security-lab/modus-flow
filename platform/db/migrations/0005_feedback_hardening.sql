-- MODUS FLOW · Phase 2.5 hardening after independent adversarial review
-- (docs/audit/2026-11-10-feedback-review.md). Each block closes a reproduced
-- attack; regression tests: test/platform/feedback-review.test.ts.

-- ---------------------------------------------------------------------------
-- C4/C5. Time is the database's: updated_at is set by a trigger, deadlines are
-- computed from the database clock, staleness is measured from activity of the
-- responsible people only (nobody else can "keep an item alive").
-- ---------------------------------------------------------------------------
REVOKE UPDATE (updated_at) ON ideas FROM modus_app;
ALTER TABLE ideas ADD COLUMN responsible_activity_at timestamptz;



-- Activity of the responsible people (or a running field check) resets the stale timer.
CREATE OR REPLACE FUNCTION mark_first_response(idea uuid, who uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Bypass ideas_touch's guard: this definer function is the only writer of responsible_activity_at.
  PERFORM set_config('app.activity_writer', 'on', true);
  UPDATE public.ideas i
     SET first_response_at = coalesce(i.first_response_at, clock_timestamp())
   WHERE i.id = idea
     AND who IN (i.maintainer_membership_id, i.decision_owner_membership_id, i.implementer_membership_id)
     AND i.first_response_at IS NULL;
  PERFORM mark_activity(idea, who);
  PERFORM set_config('app.activity_writer', '', true);
END $$;

CREATE FUNCTION mark_activity(idea uuid, who uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM set_config('app.activity_writer', 'on', true);
  UPDATE public.ideas i SET responsible_activity_at = clock_timestamp()
   WHERE i.id = idea
     AND (who IS NULL OR who IN (i.maintainer_membership_id, i.decision_owner_membership_id, i.implementer_membership_id));
  PERFORM set_config('app.activity_writer', '', true);
END $$;
REVOKE EXECUTE ON FUNCTION mark_activity(uuid, uuid) FROM PUBLIC;

CREATE FUNCTION ideas_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN
    NEW.updated_at := clock_timestamp();
    IF coalesce(current_setting('app.activity_writer', true), '') <> 'on' THEN
      NEW.responsible_activity_at := OLD.responsible_activity_at;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- "a05_" fires before the guards (alphabetical order of BEFORE triggers).
CREATE TRIGGER a05_ideas_touch BEFORE UPDATE ON ideas FOR EACH ROW EXECUTE FUNCTION ideas_touch();

CREATE FUNCTION verifications_mark_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM mark_activity(NEW.idea_id, NULL);
  RETURN NULL;
END $$;
CREATE TRIGGER verifications_activity AFTER INSERT OR UPDATE ON verifications
  FOR EACH ROW EXECUTE FUNCTION verifications_mark_activity();
CREATE FUNCTION evidence_mark_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM mark_activity((SELECT v.idea_id FROM public.verifications v WHERE v.id = NEW.verification_id), NULL);
  RETURN NULL;
END $$;
CREATE TRIGGER evidence_activity AFTER INSERT ON verification_evidence
  FOR EACH ROW EXECUTE FUNCTION evidence_mark_activity();

-- ---------------------------------------------------------------------------
-- C1/C5. Routing: the raiser can no longer be used to skip a rule; the clock
-- is the database's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ideas_route_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o record;
  r record;
  dept_head uuid;
  raiser uuid := NEW.raised_by_membership_id;
  author uuid := NEW.author_membership_id;
BEGIN
  SELECT * INTO o FROM public.organizations WHERE id = NEW.organization_id;
  IF raiser IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.memberships m WHERE m.id = raiser
          AND m.organization_id = NEW.organization_id AND m.status = 'active' AND m.access = 'member') THEN
    RAISE EXCEPTION 'raised_by must be an active employee' USING ERRCODE = '23514';
  END IF;
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.id = NEW.category_id AND c.active) THEN
    RAISE EXCEPTION 'category is inactive' USING ERRCODE = '23514';
  END IF;
  IF NEW.department_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = NEW.department_id AND d.active) THEN
    RAISE EXCEPTION 'department is inactive' USING ERRCODE = '23514';
  END IF;

  NEW.published_at := clock_timestamp();
  NEW.updated_at := NEW.published_at;
  NEW.responsible_activity_at := NULL;
  NEW.maintainer_membership_id := NULL;
  NEW.decision_owner_membership_id := NULL;
  NEW.implementer_membership_id := NULL;
  NEW.routing_rule_id := NULL;
  NEW.first_response_at := NULL;
  NEW.stage := 'published';

  -- Pick the rule exactly as if no "raised by" was given: only the author is
  -- excluded (nobody routes to themselves). If the chosen rule names the
  -- raiser, the rule is not skipped in favour of another one; the item falls
  -- back to the head of department or to the unrouted queue instead.
  SELECT * INTO r FROM public.routing_rules rr
   WHERE rr.organization_id = NEW.organization_id AND rr.active
     AND (rr.category_id IS NULL OR rr.category_id = NEW.category_id)
     AND (rr.department_id IS NULL OR rr.department_id = NEW.department_id)
     AND rr.maintainer_membership_id <> author
     AND rr.decision_owner_membership_id IS DISTINCT FROM author
     AND app_has_member_role(rr.maintainer_membership_id, 'maintainer')
     AND (rr.decision_owner_membership_id IS NULL OR app_has_member_role(rr.decision_owner_membership_id, 'decision_owner'))
   ORDER BY (rr.category_id IS NOT NULL)::int + (rr.department_id IS NOT NULL)::int DESC, rr.priority, rr.created_at
   LIMIT 1;

  -- NB: raiser and the rule's decision owner may both be NULL; NULL IS DISTINCT
  -- FROM NULL is false, so test "no raiser" explicitly.
  IF FOUND AND (raiser IS NULL
                OR (raiser <> r.maintainer_membership_id AND raiser IS DISTINCT FROM r.decision_owner_membership_id)) THEN
    NEW.routing_rule_id := r.id;
    NEW.maintainer_membership_id := r.maintainer_membership_id;
    NEW.decision_owner_membership_id := coalesce(r.decision_owner_membership_id,
      CASE WHEN app_has_member_role(r.maintainer_membership_id, 'decision_owner') THEN r.maintainer_membership_id END);
    NEW.first_response_due_at := NEW.published_at + make_interval(hours => coalesce(r.first_response_hours, o.default_first_response_hours));
    NEW.resolution_due_at := NEW.published_at + make_interval(days => coalesce(r.resolution_days, o.default_resolution_days));
  ELSE
    SELECT d.head_membership_id INTO dept_head FROM public.departments d WHERE d.id = NEW.department_id;
    IF dept_head IS NOT NULL AND dept_head <> author AND dept_head IS DISTINCT FROM raiser
       AND app_has_member_role(dept_head, 'maintainer') THEN
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

-- app_has_member_role: org-scoped, not callable by PUBLIC.
CREATE OR REPLACE FUNCTION app_has_member_role(mid uuid, role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.memberships m
                  WHERE m.id = mid AND m.status = 'active' AND m.access = 'member' AND role = ANY (m.roles)
                    AND (app_org_id() IS NULL OR m.organization_id = app_org_id()))
$$;
REVOKE EXECUTE ON FUNCTION app_has_member_role(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_has_member_role(uuid, text) TO modus_app;

-- ---------------------------------------------------------------------------
-- C1. The person named as "raised by" can decline the attribution; then the
-- credit is revoked and they may be assigned like anyone else.
-- ---------------------------------------------------------------------------
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
    IF OLD.kind = 'issue_found' AND app_membership_id() = OLD.membership_id THEN
      RETURN NEW;  -- the person declines an attribution they did not make
    END IF;
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
GRANT UPDATE (raised_by_membership_id) ON ideas TO modus_app;

-- ---------------------------------------------------------------------------
-- C8/C9 + implementer timing. Stage machine and assignment guard, revised.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ideas_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := app_membership_id();
  is_author boolean := coalesce(actor = OLD.author_membership_id, false);
  is_raiser boolean := coalesce(actor = OLD.raised_by_membership_id, false);
  is_lead boolean := coalesce(actor = OLD.maintainer_membership_id, false)
                     OR coalesce(actor = OLD.decision_owner_membership_id, false);
  is_implementer boolean := coalesce(actor = OLD.implementer_membership_id, false);
  implementer_is_originator boolean := coalesce(OLD.implementer_membership_id = OLD.author_membership_id, false)
                                       OR coalesce(OLD.implementer_membership_id = OLD.raised_by_membership_id, false);
  org_lead boolean := coalesce(app_full_member()
                      AND (app_has_role(OLD.organization_id, 'maintainer') OR app_has_role(OLD.organization_id, 'decision_owner')), false);
BEGIN
  IF app_user_id() IS NULL THEN
    RETURN NEW;
  END IF;

  -- The raiser may only clear their own attribution; nothing else in the registration changes.
  IF NEW.raised_by_membership_id IS DISTINCT FROM OLD.raised_by_membership_id
     AND NOT (is_raiser AND NEW.raised_by_membership_id IS NULL) THEN
    RAISE EXCEPTION 'registration data is immutable' USING ERRCODE = '42501';
  END IF;
  IF (NEW.category_id, NEW.department_id, NEW.routing_rule_id, NEW.source_channel, NEW.source_note,
      NEW.first_response_due_at, NEW.resolution_due_at, NEW.published_at)
     IS DISTINCT FROM
     (OLD.category_id, OLD.department_id, OLD.routing_rule_id, OLD.source_channel, OLD.source_note,
      OLD.first_response_due_at, OLD.resolution_due_at, OLD.published_at) THEN
    RAISE EXCEPTION 'registration data is immutable' USING ERRCODE = '42501';
  END IF;

  IF (NEW.maintainer_membership_id, NEW.decision_owner_membership_id)
     IS DISTINCT FROM (OLD.maintainer_membership_id, OLD.decision_owner_membership_id) THEN
    IF is_author OR is_raiser OR NOT org_lead THEN
      RAISE EXCEPTION 'only an organization maintainer or decision owner who did not raise the item may assign'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.implementer_membership_id IS DISTINCT FROM OLD.implementer_membership_id THEN
    IF NOT is_lead OR NOT EXISTS (SELECT 1 FROM public.decisions d WHERE d.idea_id = NEW.id AND d.outcome = 'merge') THEN
      RAISE EXCEPTION 'only the idea leads appoint the implementer, after a merge decision' USING ERRCODE = '42501';
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
    IF OLD.stage = 'adoption' AND NEW.stage = 'impact_verification' THEN
      -- Whoever raised the item never certifies it as done; a lead confirms instead.
      IF NOT ((is_implementer AND NOT coalesce(implementer_is_originator, false)) OR (is_lead AND NOT is_author AND NOT is_raiser)) THEN
        RAISE EXCEPTION 'completion is confirmed by the implementer or a lead who did not raise the item' USING ERRCODE = '42501';
      END IF;
    ELSIF is_author THEN
      IF NOT (OLD.stage = 'development' AND NEW.stage = 'review') THEN
        RAISE EXCEPTION 'the author cannot move the idea through review, verification or decision' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT is_lead AND NOT (org_lead AND NOT is_raiser AND OLD.stage = 'published' AND NEW.stage IN ('review','development')) THEN
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
-- C7. Whoever raised the item neither approves it nor requests changes on it.
-- ---------------------------------------------------------------------------
CREATE POLICY reviews_not_judged_by_raiser ON reviews AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (reviews.kind NOT IN ('approval','request_changes') OR NOT EXISTS (
    SELECT 1 FROM ideas i WHERE i.id = reviews.idea_id AND i.raised_by_membership_id = reviews.author_membership_id));

-- ---------------------------------------------------------------------------
-- C10. Attachments come from the people working on the item.
-- ---------------------------------------------------------------------------
CREATE POLICY attachments_from_participants ON attachments AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM ideas i WHERE i.id = attachments.idea_id
       AND (attachments.uploaded_by_membership_id IN (i.author_membership_id, i.raised_by_membership_id, i.maintainer_membership_id,
                                                      i.decision_owner_membership_id, i.implementer_membership_id)
            OR EXISTS (SELECT 1 FROM verifications v WHERE v.idea_id = i.id AND v.owner_membership_id = attachments.uploaded_by_membership_id))));
ALTER TABLE attachments ADD CONSTRAINT attachments_no_bidi
  CHECK (file_name !~ '[‎‏‪-‮⁦-⁩﻿]');

-- ---------------------------------------------------------------------------
-- C2/C3. Escalation contacts and heads of department are active employees;
-- escalations never end up only with suspended people or guests.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_active_employee(mid uuid, what text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF mid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.id = mid AND m.status = 'active' AND m.access = 'member') THEN
    RAISE EXCEPTION '% must be an active employee', what USING ERRCODE = '23514';
  END IF;
END $$;
REVOKE EXECUTE ON FUNCTION assert_active_employee(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assert_active_employee(uuid, text) TO modus_app;

CREATE FUNCTION organizations_validate_contacts() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM assert_active_employee(NEW.escalation_membership_id, 'escalation contact');
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_validate_contacts BEFORE INSERT OR UPDATE OF escalation_membership_id ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_validate_contacts();
CREATE FUNCTION departments_validate_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM assert_active_employee(NEW.head_membership_id, 'head of department');
  RETURN NEW;
END $$;
CREATE TRIGGER departments_validate_head BEFORE INSERT OR UPDATE OF head_membership_id ON departments
  FOR EACH ROW EXECUTE FUNCTION departments_validate_head();
CREATE FUNCTION routing_rules_validate_escalation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM assert_active_employee(NEW.escalate_to_membership_id, 'escalation contact');
  RETURN NEW;
END $$;
-- Only when the contact is set or changed: a rule whose contact was suspended
-- later must still be deactivatable.
CREATE TRIGGER routing_rules_validate_escalation BEFORE INSERT OR UPDATE OF escalate_to_membership_id ON routing_rules
  FOR EACH ROW EXECUTE FUNCTION routing_rules_validate_escalation();

CREATE OR REPLACE FUNCTION escalate_overdue(at timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer := 0; x record; delivered integer;
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
        ('stale', i.stage NOT IN ('closed','impact_verification')
                  AND coalesce(i.responsible_activity_at, i.published_at) < at - make_interval(days => o.stale_days))
      ) AS k(kind, due)
     WHERE k.due
       AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.idea_id = i.id AND e.kind = k.kind)
  LOOP
    INSERT INTO escalations (organization_id, idea_id, kind, escalated_to_membership_id)
    VALUES (x.organization_id, x.id, x.kind,
            (SELECT m.id FROM memberships m WHERE m.id = x.esc AND m.status = 'active' AND m.access = 'member'));
    INSERT INTO notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
    SELECT x.organization_id, m.id, NULL, 'escalated', x.id, 'escalated:' || x.kind || ':' || x.id
      FROM memberships m
     WHERE m.id IN (x.esc, x.maintainer_membership_id) AND m.status = 'active' AND m.access = 'member'
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS delivered = ROW_COUNT;
    -- Unrouted items also go to organization admins (they fix the routing rules);
    -- so does anything with nobody valid to tell (suspended maintainer, no contact).
    IF delivered = 0 OR x.maintainer_membership_id IS NULL THEN
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

-- ---------------------------------------------------------------------------
-- Notification spam: recipients are limited to the item's participants
-- (triage events: to leads); escalations are system-only.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_is_participant(idea uuid, mid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = idea
                   AND mid IN (i.author_membership_id, i.raised_by_membership_id, i.maintainer_membership_id,
                               i.decision_owner_membership_id, i.implementer_membership_id))
      OR EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea AND r.author_membership_id = mid)
      OR EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea AND r.author_membership_id = mid)
      OR EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = idea AND mid IN (v.owner_membership_id, v.created_by_membership_id))
$$;
REVOKE EXECUTE ON FUNCTION app_is_participant(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_participant(uuid, uuid) TO modus_app;

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
           -- Triage of a new item: its assignees, else organization leads and the escalation contact.
           WHEN 'idea_published' THEN m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id)
                                   OR (i.maintainer_membership_id IS NULL
                                       AND (m.roles && ARRAY['maintainer','decision_owner']
                                            OR m.id = (SELECT o.escalation_membership_id FROM public.organizations o WHERE o.id = org)))
           ELSE app_is_participant(idea, m.id)
         END
     AND app_notification_enabled(m.id, event, idea)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- Read model: staleness from responsible activity (C4). Same columns, one added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW idea_overview WITH (security_invoker = true) AS
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
  (i.stage NOT IN ('closed','impact_verification')
     AND coalesce(i.responsible_activity_at, i.published_at) < now() - make_interval(days => o.stale_days)) AS stale,
  i.responsible_activity_at
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
