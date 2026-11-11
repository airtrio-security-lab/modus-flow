-- MODUS FLOW · 0011 · «Королевские послания» (owner brief 2026-11-11, ADR-0016).
-- Built on the existing notification mechanism: the same notifications table, the same
-- proof-of-event functions (app_notify, app_notify_meeting), the existing per-event
-- subscriptions (notification_subscriptions / app_notification_enabled). New here:
-- personal style and form of address, scheduling / cancellation / attendance of meetings,
-- «deadline soon» and «castle XP» events, and decision results to council participants.
-- A game title changes the wording of a message, never anyone's rights.

-- ---------------------------------------------------------------------------
-- 1. Personal style of messages
-- ---------------------------------------------------------------------------
CREATE TABLE notification_preferences (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  membership_id   uuid NOT NULL,
  style           text NOT NULL DEFAULT 'royal' CHECK (style IN ('royal', 'business')),
  address_form    text NOT NULL DEFAULT 'title' CHECK (address_form IN ('title', 'milord', 'milady', 'master', 'neutral')),
  group_repeats   boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, membership_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_own ON notification_preferences FOR ALL TO modus_app
  USING (organization_id = app_org_id() AND app_actor_ok() AND membership_id = app_membership_id())
  WITH CHECK (organization_id = app_org_id() AND app_actor_ok() AND membership_id = app_membership_id());
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO modus_app;

-- Messages about decisions, deadlines, assignments and meetings cannot be switched off.
CREATE OR REPLACE FUNCTION app_notification_enabled(recipient uuid, event text, idea uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_actor_ok() AND (
    event IN ('assigned', 'idea_merged', 'idea_rejected', 'council_handoff', 'changes_requested', 'escalated',
              'deadline_soon', 'meeting_called', 'meeting_rescheduled', 'meeting_cancelled', 'verification_started')
    OR coalesce(
      (SELECT s.enabled FROM public.notification_subscriptions s
        WHERE s.organization_id = app_org_id() AND s.membership_id = recipient AND s.event_type = event AND s.idea_id = idea),
      (SELECT s.enabled FROM public.notification_subscriptions s
        WHERE s.organization_id = app_org_id() AND s.membership_id = recipient AND s.event_type = event AND s.idea_id IS NULL),
      true))
$$;

-- ---------------------------------------------------------------------------
-- 2. Meeting time, cancellation, attendance and changes of the participant list
-- ---------------------------------------------------------------------------
ALTER TABLE meetings
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 3 AND 500),
  ADD CONSTRAINT meetings_cancel_reason CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL));
GRANT UPDATE (scheduled_at, cancelled_at, cancel_reason) ON meetings TO modus_app;

ALTER TABLE meeting_participants
  ADD COLUMN attendance text NOT NULL DEFAULT 'pending' CHECK (attendance IN ('pending', 'confirmed', 'declined')),
  ADD COLUMN attendance_at timestamptz,
  ADD COLUMN removed_at timestamptz;
GRANT UPDATE (attendance, attendance_at) ON meeting_participants TO modus_app;

-- A removed participant loses access to the meeting, its recording and transcript.
CREATE OR REPLACE FUNCTION app_meeting_participant(meeting uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_actor_ok() AND EXISTS (
    SELECT 1 FROM public.meeting_participants p JOIN public.meetings m ON m.id = p.meeting_id
     WHERE p.meeting_id = meeting AND p.membership_id = app_membership_id() AND p.removed_at IS NULL
       AND m.organization_id = app_org_id())
$$;
CREATE OR REPLACE FUNCTION app_meeting_all_consented(meeting uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.meeting_participants WHERE meeting_id = meeting AND removed_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.meeting_participants WHERE meeting_id = meeting AND removed_at IS NULL AND consent <> 'given')
$$;

CREATE OR REPLACE FUNCTION app_meeting_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'meeting_participants' THEN
    IF TG_OP = 'INSERT' THEN
      IF EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = NEW.meeting_id AND m.recording_started_at IS NOT NULL) THEN
        RAISE EXCEPTION 'participants are fixed once recording started' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.memberships x WHERE x.id = NEW.membership_id AND x.organization_id = NEW.organization_id
                       AND x.status = 'active') THEN
        RAISE EXCEPTION 'participant must be an active member' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    IF (NEW.meeting_id, NEW.membership_id, NEW.organization_id) IS DISTINCT FROM (OLD.meeting_id, OLD.membership_id, OLD.organization_id) THEN
      RAISE EXCEPTION 'participant identity cannot change' USING ERRCODE = '23514';
    END IF;
    -- A consent given before recording cannot be silently withdrawn after it started (the person leaves instead).
    IF NEW.consent IS DISTINCT FROM OLD.consent
       AND EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = NEW.meeting_id AND m.recording_started_at IS NOT NULL) THEN
      RAISE EXCEPTION 'consent is fixed once recording started' USING ERRCODE = '23514';
    END IF;
    -- Removed participants do not answer for a meeting they left; a cancelled meeting takes no answers.
    IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS NOT NULL
       AND (NEW.consent, NEW.attendance) IS DISTINCT FROM (OLD.consent, OLD.attendance) THEN
      RAISE EXCEPTION 'participant was removed from the meeting' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = NEW.meeting_id AND m.cancelled_at IS NOT NULL) THEN
      RAISE EXCEPTION 'the meeting was cancelled' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- meetings
  IF OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'the meeting was cancelled' USING ERRCODE = '23514';
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND (OLD.recording_started_at IS NOT NULL OR NEW.recording_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a recorded meeting cannot be cancelled' USING ERRCODE = '23514';
  END IF;
  IF NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at AND OLD.recording_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'a meeting that started cannot be rescheduled' USING ERRCODE = '23514';
  END IF;
  IF NEW.recording_started_at IS NOT NULL AND OLD.recording_started_at IS NULL AND NOT app_meeting_all_consented(NEW.id) THEN
    RAISE EXCEPTION 'recording requires the consent of every participant' USING ERRCODE = '23514';
  END IF;
  IF OLD.recording_started_at IS NOT NULL AND NEW.recording_started_at IS DISTINCT FROM OLD.recording_started_at THEN
    RAISE EXCEPTION 'recording start cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'meeting already ended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- The organizer adds or removes people before recording starts. A re-added person answers again.
CREATE FUNCTION app_meeting_set_participant(mtg uuid, member uuid, present boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  m record;
BEGIN
  SELECT * INTO m FROM public.meetings WHERE id = mtg AND organization_id = app_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_actor_ok() OR m.organizer_membership_id <> app_membership_id() THEN
    RAISE EXCEPTION 'only the organizer changes the participants' USING ERRCODE = '42501';
  END IF;
  IF m.recording_started_at IS NOT NULL OR m.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'participants are fixed once recording started or the meeting was cancelled' USING ERRCODE = '23514';
  END IF;
  IF member = m.organizer_membership_id THEN
    RAISE EXCEPTION 'the organizer stays a participant' USING ERRCODE = '23514';
  END IF;
  IF present THEN
    INSERT INTO public.meeting_participants (organization_id, meeting_id, membership_id) VALUES (m.organization_id, mtg, member)
    ON CONFLICT (meeting_id, membership_id) DO UPDATE SET removed_at = NULL, consent = 'pending', consent_at = NULL,
                                                          attendance = 'pending', attendance_at = NULL;
  ELSE
    UPDATE public.meeting_participants SET removed_at = clock_timestamp() WHERE meeting_id = mtg AND membership_id = member AND removed_at IS NULL;
  END IF;
  RETURN present;
END $$;
REVOKE EXECUTE ON FUNCTION app_meeting_set_participant(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_meeting_set_participant(uuid, uuid, boolean) TO modus_app;

-- ---------------------------------------------------------------------------
-- 3. New events, proven by records; meeting messages only to active participants
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT notifications_event_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN
  ('idea_published','comment_added','changes_requested','assigned',
   'verification_started','verification_completed','idea_merged',
   'idea_rejected','contribution_confirmed','honor_board_recognition',
   'objection_raised','revision_submitted','suggestion_submitted','suggestion_decided',
   'status_report','implemented','raised_on_behalf','escalated',
   'council_recommendation','council_handoff','castle_level_up',
   'meeting_called','meeting_recording_started','meeting_findings_ready',
   'meeting_rescheduled','meeting_cancelled','deadline_soon','castle_xp'));

CREATE OR REPLACE FUNCTION app_notify_meeting(event text, meeting uuid, recipients uuid[], dedupe text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := app_membership_id();
  org uuid := app_org_id();
  m record;
  proven boolean;
  n integer;
BEGIN
  SELECT * INTO m FROM public.meetings x WHERE x.id = meeting AND x.organization_id = org;
  IF NOT app_actor_ok() OR NOT FOUND THEN
    RAISE EXCEPTION 'notification not allowed' USING ERRCODE = '42501';
  END IF;
  proven := CASE event
    WHEN 'meeting_called' THEN m.organizer_membership_id = actor AND m.cancelled_at IS NULL
    WHEN 'meeting_rescheduled' THEN m.organizer_membership_id = actor AND m.cancelled_at IS NULL AND m.scheduled_at IS NOT NULL
    WHEN 'meeting_cancelled' THEN m.organizer_membership_id = actor AND m.cancelled_at IS NOT NULL
    WHEN 'meeting_recording_started' THEN m.organizer_membership_id = actor AND m.recording_started_at IS NOT NULL
    WHEN 'meeting_findings_ready' THEN EXISTS (SELECT 1 FROM public.meeting_protocols p JOIN public.meeting_transcripts t ON t.id = p.transcript_id
                                                 WHERE t.meeting_id = meeting AND p.created_by_membership_id = actor)
    ELSE false
  END;
  IF NOT coalesce(proven, false) THEN
    RAISE EXCEPTION 'notification is not backed by a meeting record' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, meeting_id, dedupe_key)
  SELECT org, p.membership_id, actor, event, meeting, event || ':' || dedupe
    FROM public.meeting_participants p
   WHERE p.meeting_id = meeting AND p.membership_id = ANY (recipients) AND p.membership_id <> actor
     AND (p.removed_at IS NULL OR event = 'meeting_cancelled')
     AND app_notification_enabled(p.membership_id, event, NULL)
  ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- People who argued at the council of an item, and active participants of meetings about it,
-- take part in the item for notifications (decision results reach them).
CREATE OR REPLACE FUNCTION app_is_participant(idea uuid, mid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = idea
                   AND mid IN (i.author_membership_id, i.raised_by_membership_id, i.maintainer_membership_id,
                               i.decision_owner_membership_id, i.implementer_membership_id))
      OR EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea AND r.author_membership_id = mid)
      OR EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea AND r.author_membership_id = mid)
      OR EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = idea AND mid IN (v.owner_membership_id, v.created_by_membership_id))
      OR EXISTS (SELECT 1 FROM public.council_entries e WHERE e.idea_id = idea AND e.author_membership_id = mid)
      OR EXISTS (SELECT 1 FROM public.meeting_participants p JOIN public.meetings m ON m.id = p.meeting_id
                  WHERE m.idea_id = idea AND p.membership_id = mid AND p.removed_at IS NULL AND m.cancelled_at IS NULL)
$$;

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
    WHEN 'council_recommendation' THEN EXISTS (SELECT 1 FROM public.council_entries e WHERE e.idea_id = idea
                                    AND e.author_membership_id = actor AND e.kind IN ('recommendation','dissent'))
    WHEN 'council_handoff' THEN i.stage = 'decision' AND EXISTS (SELECT 1 FROM public.council_entries e WHERE e.idea_id = idea
                                    AND e.author_membership_id = actor AND e.kind = 'handoff')
    WHEN 'castle_xp' THEN EXISTS (SELECT 1 FROM public.xp_awards a WHERE a.idea_id = idea)
                            AND actor IN (i.implementer_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)
    WHEN 'castle_level_up' THEN EXISTS (SELECT 1 FROM public.xp_awards a WHERE a.idea_id = idea)
                            AND actor IN (i.implementer_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)
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
           WHEN 'idea_published' THEN m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id)
                                   OR (i.maintainer_membership_id IS NULL
                                       AND (m.roles && ARRAY['maintainer','decision_owner']
                                            OR m.id = (SELECT o.escalation_membership_id FROM public.organizations o WHERE o.id = org)))
           WHEN 'council_recommendation' THEN m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id)
           WHEN 'council_handoff' THEN m.id = i.decision_owner_membership_id
           WHEN 'castle_level_up' THEN m.id IN (i.author_membership_id, i.raised_by_membership_id)
           WHEN 'castle_xp' THEN m.id IN (i.author_membership_id, i.raised_by_membership_id)
           ELSE app_is_participant(idea, m.id)
         END
     AND app_notification_enabled(m.id, event, idea)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- «Приближается срок»: once per item and deadline, to the people who answer for it.
-- Run by the escalation job (platform/cli/escalate.ts); the system is the sender.
CREATE FUNCTION notify_deadlines_soon(at timestamptz DEFAULT now(), within interval DEFAULT interval '24 hours') RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  INSERT INTO notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
  SELECT i.organization_id, r.m, NULL, 'deadline_soon', i.id, 'deadline_soon:' || i.id || ':' || to_char(i.resolution_due_at, 'YYYY-MM-DD"T"HH24:MI')
    FROM ideas i
    CROSS JOIN LATERAL (VALUES (i.maintainer_membership_id), (i.decision_owner_membership_id), (i.implementer_membership_id)) r(m)
    JOIN memberships mm ON mm.id = r.m AND mm.status = 'active'
   WHERE r.m IS NOT NULL AND i.stage IN ('published', 'review', 'development', 'verification', 'decision', 'adoption')
     AND i.resolution_due_at > at AND i.resolution_due_at <= at + within
  ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION notify_deadlines_soon(timestamptz, interval) FROM PUBLIC;
