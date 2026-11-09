-- MODUS FLOW · Phase 2 hardening after independent adversarial review
-- (docs/audit/2026-11-10-phase2-review.md). Every rule here closes a
-- reproduced attack; each has a regression test in test/platform/phase2-review.test.ts.

-- ---------------------------------------------------------------------------
-- A. Serialize at the database level, not only in the service: every write
--    that participates in a workflow gate first locks the idea row. Trigger
--    names start with "a00_" so they fire before the other BEFORE triggers.
-- ---------------------------------------------------------------------------
CREATE FUNCTION lock_parent_idea() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.ideas WHERE id = NEW.idea_id FOR UPDATE;
  RETURN NEW;
END $$;
CREATE FUNCTION lock_idea_of_verification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.ideas i JOIN public.verifications v ON v.idea_id = i.id
   WHERE v.id = NEW.verification_id FOR UPDATE OF i;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_lock_idea BEFORE INSERT OR UPDATE ON reviews        FOR EACH ROW EXECUTE FUNCTION lock_parent_idea();
CREATE TRIGGER a00_lock_idea BEFORE INSERT ON decisions                FOR EACH ROW EXECUTE FUNCTION lock_parent_idea();
CREATE TRIGGER a00_lock_idea BEFORE INSERT OR UPDATE ON idea_revisions FOR EACH ROW EXECUTE FUNCTION lock_parent_idea();
CREATE TRIGGER a00_lock_idea BEFORE INSERT OR UPDATE ON verifications  FOR EACH ROW EXECUTE FUNCTION lock_parent_idea();
CREATE TRIGGER a00_lock_idea BEFORE INSERT OR UPDATE ON contributions  FOR EACH ROW EXECUTE FUNCTION lock_parent_idea();
CREATE TRIGGER a00_lock_idea BEFORE INSERT ON verification_evidence    FOR EACH ROW EXECUTE FUNCTION lock_idea_of_verification();

-- ---------------------------------------------------------------------------
-- B. Independent powers. Maintainer (leads review and verification) and
--    Decision Owner (decides) are different people; assignments are frozen
--    while a verification is active; the guard only runs when assignments
--    change, so a later role change cannot brick unrelated workflow steps.
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
      RETURN NEW;  -- unrelated update: never re-validate (a later role change must not brick the idea)
    END IF;
    IF EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = NEW.id AND v.status IN ('planned','running')) THEN
      RAISE EXCEPTION 'assignments are frozen while a verification is active' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.author_membership_id IN (NEW.maintainer_membership_id, NEW.decision_owner_membership_id) THEN
    RAISE EXCEPTION 'the author cannot lead or decide their own idea' USING ERRCODE = '23514';
  END IF;
  IF NEW.maintainer_membership_id = NEW.decision_owner_membership_id THEN
    RAISE EXCEPTION 'maintainer and decision owner must be different people' USING ERRCODE = '23514';
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

-- ---------------------------------------------------------------------------
-- C. Verification: started and concluded only by the assigned maintainer;
--    owner is never the author and is a full member or an assigned lead;
--    evidence never by the author; plan/criteria/owner/revision frozen once
--    running; the decision owner never owns a run they will later judge;
--    cancel only by the maintainer, with a reason, and only before
--    any evidence exists (evidence always ends in a verdict).
-- ---------------------------------------------------------------------------
CREATE POLICY verifications_started_by_maintainer ON verifications AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM ideas i
     WHERE i.id = verifications.idea_id
       AND i.maintainer_membership_id = verifications.created_by_membership_id
       AND i.author_membership_id <> verifications.owner_membership_id
       AND i.decision_owner_membership_id IS DISTINCT FROM verifications.owner_membership_id
       AND (verifications.owner_membership_id = i.maintainer_membership_id
            OR EXISTS (SELECT 1 FROM memberships m WHERE m.id = verifications.owner_membership_id
                                                     AND m.access = 'member' AND m.status = 'active'))));

CREATE POLICY verification_evidence_recorders ON verification_evidence AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM verifications v JOIN ideas i ON i.id = v.idea_id
     WHERE v.id = verification_evidence.verification_id
       AND i.author_membership_id <> verification_evidence.recorded_by_membership_id
       AND verification_evidence.recorded_by_membership_id IN
           (v.owner_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)));

CREATE FUNCTION verifications_guard_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE maint uuid;
BEGIN
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'planned' AND NEW.status IN ('running','cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('completed','cancelled'))) THEN
    RAISE EXCEPTION 'verification status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'planned' AND (NEW.plan, NEW.success_criteria, NEW.owner_membership_id, NEW.revision_number)
       IS DISTINCT FROM (OLD.plan, OLD.success_criteria, OLD.owner_membership_id, OLD.revision_number) THEN
    RAISE EXCEPTION 'plan, criteria, owner and revision are frozen once a verification runs' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    IF length(btrim(coalesce(NEW.conclusion, ''))) < 10 THEN
      RAISE EXCEPTION 'cancelling needs a recorded reason' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.verification_evidence e WHERE e.verification_id = NEW.id) THEN
      RAISE EXCEPTION 'a verification with evidence must be concluded with an outcome, not cancelled' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF app_user_id() IS NOT NULL AND NEW.status IN ('completed','cancelled') AND OLD.status <> NEW.status THEN
    SELECT i.maintainer_membership_id INTO maint FROM public.ideas i WHERE i.id = NEW.idea_id;
    IF app_membership_id() IS DISTINCT FROM maint THEN
      RAISE EXCEPTION 'only the assigned maintainer concludes or cancels a verification' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'cancelled' THEN
      NEW.concluded_by_membership_id := app_membership_id();
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verifications_guard_transition BEFORE UPDATE ON verifications
  FOR EACH ROW EXECUTE FUNCTION verifications_guard_transition();

-- ---------------------------------------------------------------------------
-- D. Stage machine: only assigned leads move an idea (org leads only to pick
--    up a published idea); leaving verification needs no active run;
--    entering decision from verification needs a completed run on the
--    current revision; the current text changes only before verification.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ideas_guard_update() RETURNS trigger
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
    RETURN NEW;
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
    IF OLD.stage NOT IN ('published','review','development') THEN
      RAISE EXCEPTION 'the text cannot change during verification, decision or adoption' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    IF NOT app_stage_transition_ok(OLD.stage, NEW.stage) THEN
      RAISE EXCEPTION 'stage transition % -> % is not allowed', OLD.stage, NEW.stage USING ERRCODE = '23514';
    END IF;
    IF is_author THEN
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
    IF NEW.stage = 'closed' AND OLD.stage <> 'impact_verification' AND NOT EXISTS (
         SELECT 1 FROM public.decisions d WHERE d.idea_id = NEW.id AND d.outcome IN ('reject','close')) THEN
      RAISE EXCEPTION 'closing requires a reject or close decision with rationale' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- E. Revisions: numbers are gap-free (no 2147483647 squatting); author
--    updates only before verification; only the author retires the current
--    text; at commit every idea has exactly one current revision and it is
--    the one the idea points to.
-- ---------------------------------------------------------------------------
CREATE FUNCTION idea_revisions_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.number <> (SELECT coalesce(max(r.number), 0) + 1 FROM public.idea_revisions r WHERE r.idea_id = NEW.idea_id) THEN
    RAISE EXCEPTION 'revision numbers are sequential' USING ERRCODE = '23514';
  END IF;
  IF NEW.origin = 'author_update' AND NOT EXISTS (
       SELECT 1 FROM public.ideas i WHERE i.id = NEW.idea_id AND i.stage IN ('published','review','development')) THEN
    RAISE EXCEPTION 'the text cannot change during verification, decision or adoption' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idea_revisions_guard_insert BEFORE INSERT ON idea_revisions
  FOR EACH ROW EXECUTE FUNCTION idea_revisions_guard_insert();

CREATE FUNCTION idea_revisions_guard_retire() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status = 'current' AND NEW.status = 'superseded' AND app_user_id() IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.ideas i WHERE i.id = NEW.idea_id AND i.author_membership_id = app_membership_id()) THEN
    RAISE EXCEPTION 'only the author replaces the current text' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idea_revisions_guard_retire BEFORE UPDATE ON idea_revisions
  FOR EACH ROW EXECUTE FUNCTION idea_revisions_guard_retire();

CREATE FUNCTION assert_one_current_revision(target uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM public.idea_revisions r WHERE r.idea_id = target AND r.status = 'current') <> 1
     OR NOT EXISTS (SELECT 1 FROM public.ideas i JOIN public.idea_revisions r
                      ON r.idea_id = i.id AND r.number = i.current_revision_number AND r.status = 'current'
                     WHERE i.id = target) THEN
    RAISE EXCEPTION 'each idea must have exactly one current revision, and point to it' USING ERRCODE = '23514';
  END IF;
END $$;
CREATE FUNCTION idea_revisions_current_consistent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM assert_one_current_revision(NEW.idea_id);
  RETURN NULL;
END $$;
CREATE FUNCTION ideas_current_consistent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM assert_one_current_revision(NEW.id);
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION assert_one_current_revision(uuid) TO modus_app;
CREATE CONSTRAINT TRIGGER idea_revisions_current_consistent AFTER INSERT OR UPDATE ON idea_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION idea_revisions_current_consistent();
CREATE CONSTRAINT TRIGGER ideas_current_consistent AFTER UPDATE OF current_revision_number ON ideas
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ideas_current_consistent();

-- ---------------------------------------------------------------------------
-- F. Change requests are resolved only by whoever raised them or by the
--    assigned maintainer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION reviews_guard_resolution() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state <> OLD.state AND app_user_id() IS NOT NULL
     AND app_membership_id() IS DISTINCT FROM OLD.author_membership_id
     AND NOT EXISTS (SELECT 1 FROM public.ideas i
                      WHERE i.id = NEW.idea_id AND i.maintainer_membership_id = app_membership_id()) THEN
    RAISE EXCEPTION 'only the requester or the assigned maintainer resolves a change request' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reviews_guard_resolution BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_guard_resolution();

-- ---------------------------------------------------------------------------
-- G. Contributions are facts backed by a workflow record, not claims anyone
--    can insert; system facts can never be revoked; confirmation/revocation
--    move forward only.
-- ---------------------------------------------------------------------------
CREATE POLICY contributions_backed_by_record ON contributions AS RESTRICTIVE FOR INSERT TO modus_app
  WITH CHECK (CASE contributions.kind
    WHEN 'authorship' THEN contributions.source_type = 'idea' AND contributions.source_id = contributions.idea_id
      AND EXISTS (SELECT 1 FROM ideas i WHERE i.id = contributions.idea_id
                     AND i.author_membership_id = contributions.membership_id)
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
    ELSE false  -- claim-type kinds need a dedicated, reviewed workflow (not yet built)
  END);

CREATE FUNCTION contributions_guard_update() RETURNS trigger
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
    IF OLD.kind IN ('authorship','co_authorship','review','verification','negative_result') THEN
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
CREATE TRIGGER contributions_guard_update BEFORE UPDATE ON contributions
  FOR EACH ROW EXECUTE FUNCTION contributions_guard_update();

-- ---------------------------------------------------------------------------
-- H. Decisions: the decider never verified the idea themselves; the snapshot
--    counts evidence by kind (a "result" is neither positive nor negative).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION decisions_guard_insert() RETURNS trigger
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
  IF EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = NEW.idea_id
               AND NEW.decided_by_membership_id IN (v.created_by_membership_id, v.concluded_by_membership_id, v.owner_membership_id)) THEN
    RAISE EXCEPTION 'the decision owner cannot decide on a verification they ran' USING ERRCODE = '23514';
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
  NEW.verification_summary := coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'verificationId', v.id, 'purpose', v.purpose, 'revision', v.revision_number,
             'status', v.status, 'outcome', v.outcome,
             'results', (SELECT count(*) FROM public.verification_evidence e WHERE e.verification_id = v.id AND e.kind = 'result'),
             'positiveObservations', (SELECT count(*) FROM public.verification_evidence e WHERE e.verification_id = v.id AND e.kind = 'positive_observation'),
             'negativeObservations', (SELECT count(*) FROM public.verification_evidence e WHERE e.verification_id = v.id AND e.kind = 'negative_observation'))
           ORDER BY v.created_at)
      FROM public.verifications v WHERE v.idea_id = NEW.idea_id), '[]'::jsonb);
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- I. Guest scope everywhere: people directory, organization counters,
--    subscriptions.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_membership_visible(mid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_full_member() OR mid = app_membership_id() OR EXISTS (
    SELECT 1 FROM public.ideas i
     WHERE i.organization_id = app_org_id() AND app_idea_visible(i.id)
       AND (mid IN (i.author_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)
            OR EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = i.id AND r.author_membership_id = mid)
            OR EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = i.id AND r.author_membership_id = mid)
            OR EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = i.id
                          AND mid IN (v.owner_membership_id, v.created_by_membership_id, v.concluded_by_membership_id))
            OR EXISTS (SELECT 1 FROM public.verification_evidence e JOIN public.verifications v ON v.id = e.verification_id
                        WHERE v.idea_id = i.id AND e.recorded_by_membership_id = mid)
            OR EXISTS (SELECT 1 FROM public.decisions d WHERE d.idea_id = i.id AND d.decided_by_membership_id = mid)
            OR EXISTS (SELECT 1 FROM public.contributions c WHERE c.idea_id = i.id AND c.membership_id = mid)))
$$;
GRANT EXECUTE ON FUNCTION app_membership_visible(uuid) TO modus_app;

CREATE POLICY memberships_guest_scope ON memberships AS RESTRICTIVE FOR SELECT TO modus_app
  USING (user_id = app_user_id() OR app_org_id() IS NULL OR app_membership_visible(id));
CREATE POLICY users_guest_scope ON users AS RESTRICTIVE FOR SELECT TO modus_app
  USING (id = app_user_id() OR app_full_member()
         OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app_org_id()));
CREATE POLICY notification_subscriptions_guest_scope ON notification_subscriptions AS RESTRICTIVE FOR ALL TO modus_app
  USING (idea_id IS NULL OR app_idea_visible(idea_id)) WITH CHECK (idea_id IS NULL OR app_idea_visible(idea_id));

REVOKE SELECT ON organizations FROM modus_app;
GRANT SELECT (id, slug, name, created_at) ON organizations TO modus_app;

-- ---------------------------------------------------------------------------
-- J. Notifications can no longer be written directly. app_notify() only emits
--    an event backed by a workflow record the actor really created, only to
--    active members of the organization who may see the idea.
-- ---------------------------------------------------------------------------
REVOKE INSERT ON notifications FROM modus_app;

CREATE FUNCTION app_notify(event text, idea uuid, recipients uuid[], dedupe text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := app_membership_id();
  org uuid := app_org_id();
  proven boolean;
  n integer;
BEGIN
  IF NOT app_actor_ok() OR idea IS NULL OR NOT app_idea_visible(idea)
     OR NOT EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = idea AND i.organization_id = org) THEN
    RAISE EXCEPTION 'notification not allowed' USING ERRCODE = '42501';
  END IF;
  proven := CASE event
    WHEN 'idea_published' THEN EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = idea AND i.author_membership_id = actor)
    WHEN 'assigned' THEN EXISTS (SELECT 1 FROM public.audit_events a WHERE a.entity_id = idea
                                    AND a.action = 'idea.assigned' AND a.actor_user_id = app_user_id())
    WHEN 'comment_added' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND (r.author_membership_id = actor OR r.resolved_by_membership_id = actor))
    WHEN 'changes_requested' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND r.kind = 'request_changes' AND r.author_membership_id = actor)
    WHEN 'objection_raised' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND r.kind = 'objection' AND r.author_membership_id = actor)
    WHEN 'revision_submitted' THEN EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea
                                    AND r.origin = 'author_update' AND r.author_membership_id = actor)
    WHEN 'suggestion_submitted' THEN EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea
                                    AND r.origin = 'suggestion' AND r.author_membership_id = actor)
    WHEN 'suggestion_decided' THEN EXISTS (SELECT 1 FROM public.ideas i JOIN public.idea_revisions r ON r.idea_id = i.id
                                    WHERE i.id = idea AND i.author_membership_id = actor
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
  IF NOT proven THEN
    RAISE EXCEPTION 'notification is not backed by a workflow record' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
  SELECT org, m.id, actor, event, idea, event || ':' || dedupe
    FROM public.memberships m
   WHERE m.id = ANY (recipients) AND m.id <> actor AND m.organization_id = org AND m.status = 'active'
     AND (m.access = 'member' OR EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = idea
                                            AND m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id)))
     AND app_notification_enabled(m.id, event, idea)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_notify(text, uuid, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify(text, uuid, uuid[], text) TO modus_app;
