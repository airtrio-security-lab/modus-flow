-- MODUS FLOW · 0018 · «Отложить решение» (owner request 2026-11-12, decisions: who decides may postpone;
-- the resolution deadline is paused while the item is postponed).
--
-- The person responsible for the decision on an item may postpone it until a date, with a reason the
-- author reads. Titles (King, Regent) give no rights here: the right is the existing «decides this item».
-- While postponed the resolution deadline does not run: it is moved forward by the length of the pause,
-- so every existing consumer of the deadline (overdue flags, escalation, «срок скоро», filters) stays
-- correct without a second definition of «overdue». Returning the item earlier moves the deadline back
-- by the unused part. Nothing else in the registration changes; statuses and XP are untouched.
-- Additive only: one table, two SECURITY DEFINER functions, one notification event.

CREATE TABLE idea_deferrals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  idea_id                uuid NOT NULL REFERENCES ideas(id),
  until_date             date NOT NULL,
  reason                 text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  deferred_by_membership_id uuid NOT NULL REFERENCES memberships(id),
  deferred_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- How far the resolution deadline was moved by this pause (kept so the pause can be undone exactly).
  shift                  interval NOT NULL,
  resumed_at             timestamptz,
  resumed_by_membership_id uuid REFERENCES memberships(id),
  CHECK (until_date > deferred_at::date),
  CHECK ((resumed_at IS NULL) = (resumed_by_membership_id IS NULL))
);
-- One running pause per item.
CREATE UNIQUE INDEX idea_deferrals_one_open ON idea_deferrals (idea_id) WHERE resumed_at IS NULL;
CREATE INDEX idea_deferrals_idea ON idea_deferrals (idea_id, deferred_at DESC);
ALTER TABLE idea_deferrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY idea_deferrals_read ON idea_deferrals FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
GRANT SELECT ON idea_deferrals TO modus_app;

-- Is the item postponed right now, and until when.
CREATE FUNCTION app_idea_deferred_until(p_idea uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS
$$ SELECT d.until_date FROM public.idea_deferrals d WHERE d.idea_id = p_idea AND d.resumed_at IS NULL AND d.until_date >= current_date $$;

-- The deadline is registration data and is immutable for people (0005). A postponement is the one
-- sanctioned, logged way to move it: the function checks the right itself and then performs the single
-- column update as the system, exactly like the scheduler does.
CREATE FUNCTION app_defer_idea(p_idea uuid, p_until date, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i public.ideas%ROWTYPE;
  me uuid := public.app_membership_id();
  who text := current_setting('app.user_id', true);
  until_ts timestamptz;
  delta interval;
  new_id uuid;
BEGIN
  SELECT * INTO i FROM public.ideas x WHERE x.id = p_idea AND x.organization_id = public.app_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT public.app_actor_ok() OR NOT public.app_full_member()
     OR i.decision_owner_membership_id IS DISTINCT FROM me
     OR me IN (i.author_membership_id, coalesce(i.raised_by_membership_id, i.author_membership_id)) THEN
    RAISE EXCEPTION 'only the decision owner of the item may postpone it' USING ERRCODE = '42501';
  END IF;
  IF i.stage NOT IN ('published', 'review', 'development', 'verification', 'decision') THEN
    RAISE EXCEPTION 'only an item awaiting a decision can be postponed' USING ERRCODE = '23514';
  END IF;
  IF p_until <= current_date OR p_until > current_date + 180 THEN
    RAISE EXCEPTION 'the date must be from tomorrow to 180 days ahead' USING ERRCODE = '22023';
  END IF;
  -- A pause whose date has passed is closed first: the item is simply postponed again.
  UPDATE public.idea_deferrals SET resumed_at = clock_timestamp(), resumed_by_membership_id = me
    WHERE idea_id = p_idea AND resumed_at IS NULL AND until_date < current_date;
  IF EXISTS (SELECT 1 FROM public.idea_deferrals d WHERE d.idea_id = p_idea AND d.resumed_at IS NULL) THEN
    RAISE EXCEPTION 'the item is already postponed' USING ERRCODE = '23505';
  END IF;
  until_ts := (p_until + 1)::timestamptz;
  delta := until_ts - clock_timestamp();
  INSERT INTO public.idea_deferrals (organization_id, idea_id, until_date, reason, deferred_by_membership_id, shift)
    VALUES (i.organization_id, p_idea, p_until, btrim(p_reason), me, delta) RETURNING id INTO new_id;
  PERFORM set_config('app.user_id', '', true);
  UPDATE public.ideas SET resolution_due_at = resolution_due_at + delta WHERE id = p_idea AND resolution_due_at IS NOT NULL;
  PERFORM set_config('app.user_id', who, true);
  INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (i.organization_id, public.app_user_id(), 'idea.deferred', 'idea', p_idea, jsonb_build_object('until', p_until, 'deferral', new_id));
  RETURN new_id;
END $$;

-- Return the item to work before the date: the unused part of the pause is given back to the deadline.
CREATE FUNCTION app_resume_idea(p_idea uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i public.ideas%ROWTYPE;
  d public.idea_deferrals%ROWTYPE;
  me uuid := public.app_membership_id();
  who text := current_setting('app.user_id', true);
  unused interval;
BEGIN
  SELECT * INTO i FROM public.ideas x WHERE x.id = p_idea AND x.organization_id = public.app_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT public.app_actor_ok() OR NOT public.app_full_member() OR i.decision_owner_membership_id IS DISTINCT FROM me THEN
    RAISE EXCEPTION 'only the decision owner of the item may return it to work' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO d FROM public.idea_deferrals x WHERE x.idea_id = p_idea AND x.resumed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the item is not postponed' USING ERRCODE = '23514';
  END IF;
  unused := greatest((d.until_date + 1)::timestamptz - clock_timestamp(), interval '0');
  UPDATE public.idea_deferrals SET resumed_at = clock_timestamp(), resumed_by_membership_id = me WHERE id = d.id;
  PERFORM set_config('app.user_id', '', true);
  UPDATE public.ideas SET resolution_due_at = resolution_due_at - unused WHERE id = p_idea AND resolution_due_at IS NOT NULL;
  PERFORM set_config('app.user_id', who, true);
  INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (i.organization_id, public.app_user_id(), 'idea.resumed', 'idea', p_idea, jsonb_build_object('deferral', d.id));
  RETURN d.id;
END $$;
REVOKE ALL ON FUNCTION app_defer_idea(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_resume_idea(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_idea_deferred_until(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_defer_idea(uuid, date, text) TO modus_app;
GRANT EXECUTE ON FUNCTION app_resume_idea(uuid) TO modus_app;
GRANT EXECUTE ON FUNCTION app_idea_deferred_until(uuid) TO modus_app;

-- The author and the people of the item are told: «решение отложено до …», proven by the deferral row.
ALTER TABLE notifications DROP CONSTRAINT notifications_event_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN
  ('idea_published','comment_added','changes_requested','assigned',
   'verification_started','verification_completed','idea_merged',
   'idea_rejected','contribution_confirmed','honor_board_recognition',
   'objection_raised','revision_submitted','suggestion_submitted','suggestion_decided',
   'status_report','implemented','raised_on_behalf','escalated',
   'council_recommendation','council_handoff','castle_level_up',
   'meeting_called','meeting_recording_started','meeting_findings_ready',
   'meeting_rescheduled','meeting_cancelled','deadline_soon','castle_xp',
   'knowledge_submitted','knowledge_in_library','knowledge_archived','knowledge_reverify',
   'council_escalated','idea_deferred'));

CREATE FUNCTION app_notify_deferral(p_deferral uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d record;
  n integer;
BEGIN
  SELECT x.*, i.author_membership_id, i.raised_by_membership_id, i.maintainer_membership_id
    INTO d FROM public.idea_deferrals x JOIN public.ideas i ON i.id = x.idea_id
   WHERE x.id = p_deferral AND x.organization_id = app_org_id();
  IF NOT FOUND OR NOT app_actor_ok() OR d.deferred_by_membership_id <> app_membership_id() THEN
    RAISE EXCEPTION 'notification is not backed by a postponement' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
  SELECT app_org_id(), m.id, d.deferred_by_membership_id, 'idea_deferred', d.idea_id, 'idea_deferred:' || p_deferral
    FROM public.memberships m
   WHERE m.id IN (d.author_membership_id, d.raised_by_membership_id, d.maintainer_membership_id)
     AND m.id <> d.deferred_by_membership_id AND m.organization_id = app_org_id() AND m.status = 'active'
     AND app_notification_enabled(m.id, 'idea_deferred', d.idea_id)
  ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_notify_deferral(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_deferral(uuid) TO modus_app;
