-- MODUS FLOW · 0015 · Civilizations, titles and councils (owner brief «Civilizations & Councils», 2026-11-11, ADR-0020).
--
-- One data model for every civilization: the style of a district stays a picture; titles are words
-- from a registry in code, computed from facts (head, assigned deputy, roles, confirmed results) and
-- the person's own choices; small councils are department meetings, the Great Round Table is the
-- company council. Nothing here grants a right.

-- ---------------------------------------------------------------------------
-- 1. «Средневековая Европа» becomes Камелот, a full civilization. The audit log keeps old names.
-- ---------------------------------------------------------------------------
ALTER TABLE departments DROP CONSTRAINT departments_civilization_check;
UPDATE departments SET civilization = 'camelot' WHERE civilization = 'europe';
ALTER TABLE departments ALTER COLUMN civilization SET DEFAULT 'camelot';
ALTER TABLE departments ADD CONSTRAINT departments_civilization_check CHECK (civilization IN ('camelot', 'japan', 'mongolia', 'kazakh'));

CREATE OR REPLACE FUNCTION app_set_civilization(dept uuid, civ text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d record;
BEGIN
  SELECT * INTO d FROM public.departments WHERE id = dept AND organization_id = app_org_id() AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'department not found' USING ERRCODE = '42501'; END IF;
  IF NOT app_full_member() OR NOT (coalesce(d.head_membership_id = app_membership_id(), false) OR app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only the head of the department or an admin chooses its style' USING ERRCODE = '42501';
  END IF;
  IF civ IS NULL OR civ NOT IN ('camelot', 'japan', 'mongolia', 'kazakh') THEN
    RAISE EXCEPTION 'unknown civilization' USING ERRCODE = '23514';
  END IF;
  IF d.civilization = civ THEN RETURN civ; END IF;
  UPDATE public.departments SET civilization = civ WHERE id = dept;
  INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (app_org_id(), app_user_id(), 'castle.civilization_changed', 'department', dept, jsonb_build_object('from', d.civilization, 'to', civ));
  RETURN civ;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Titles: an admin may name a deputy of a department (Каро, Султан, Сенешаль, Нойон…);
--    the person chooses a neutral title, the novice title (Оруженосец) and showing an earned honor.
-- ---------------------------------------------------------------------------
ALTER TABLE game_titles DROP CONSTRAINT game_titles_rank_check;
ALTER TABLE game_titles ADD CONSTRAINT game_titles_rank_check CHECK (rank IN ('king', 'regent', 'guild', 'deputy'));

CREATE TABLE title_choices (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  membership_id   uuid NOT NULL,
  neutral         boolean NOT NULL DEFAULT false,
  novice          boolean NOT NULL DEFAULT false,
  show_honor      boolean NOT NULL DEFAULT false,
  -- The public form of a Camelot head title, chosen by the person (never guessed): Лорд or Леди.
  head_form       text CHECK (head_form IN ('lord', 'lady')),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, membership_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id)
);
ALTER TABLE title_choices ENABLE ROW LEVEL SECURITY;
CREATE POLICY title_choices_read ON title_choices FOR SELECT TO modus_app USING (organization_id = app_org_id() AND app_full_member());
-- Only the person changes their own choices.
CREATE POLICY title_choices_own ON title_choices FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND membership_id = app_membership_id() AND app_full_member());
CREATE POLICY title_choices_own_update ON title_choices FOR UPDATE TO modus_app
  USING (organization_id = app_org_id() AND membership_id = app_membership_id())
  WITH CHECK (organization_id = app_org_id() AND membership_id = app_membership_id());
GRANT SELECT, INSERT, UPDATE ON title_choices TO modus_app;

-- ---------------------------------------------------------------------------
-- 3. The agenda of a meeting: items it will discuss, fixed when the meeting is called.
-- ---------------------------------------------------------------------------
CREATE TABLE meeting_agenda (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  meeting_id      uuid NOT NULL REFERENCES meetings(id),
  idea_id         uuid NOT NULL,
  position        integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  PRIMARY KEY (meeting_id, idea_id),
  UNIQUE (meeting_id, position),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id)
);
CREATE TRIGGER meeting_agenda_append_only BEFORE UPDATE OR DELETE ON meeting_agenda FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE meeting_agenda ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_agenda_read ON meeting_agenda FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND (app_meeting_participant(meeting_id) OR app_meeting_organizer(meeting_id)));
CREATE POLICY meeting_agenda_insert ON meeting_agenda FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND app_meeting_organizer(meeting_id) AND app_idea_visible(idea_id));
GRANT SELECT, INSERT ON meeting_agenda TO modus_app;

-- ---------------------------------------------------------------------------
-- 4. Small councils and the Great Round Table. An item is discussed at the small council of its
--    department until someone with authority over it passes it to the Great council, once, with a
--    reason. Every council entry records where it was made, so the department history stays visible.
-- ---------------------------------------------------------------------------
CREATE TABLE council_escalations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  idea_id               uuid NOT NULL,
  from_department_id    uuid,
  escalated_by_membership_id uuid NOT NULL,
  reason_kind           text NOT NULL CHECK (reason_kind IN ('cross_department', 'strategic', 'shared_resources', 'higher_authority', 'other')),
  reason                text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 1000),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, idea_id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, from_department_id) REFERENCES departments(organization_id, id),
  FOREIGN KEY (organization_id, escalated_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER council_escalations_append_only BEFORE UPDATE OR DELETE ON council_escalations FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE council_escalations ENABLE ROW LEVEL SECURITY;
CREATE POLICY council_escalations_read ON council_escalations FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
GRANT SELECT ON council_escalations TO modus_app;

ALTER TABLE council_entries ADD COLUMN council_level text NOT NULL DEFAULT 'small' CHECK (council_level IN ('small', 'great'));
CREATE FUNCTION app_council_level() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.council_level := CASE WHEN EXISTS (SELECT 1 FROM public.council_escalations e WHERE e.idea_id = NEW.idea_id) THEN 'great' ELSE 'small' END;
  RETURN NEW;
END $$;
CREATE TRIGGER council_entries_level BEFORE INSERT ON council_entries FOR EACH ROW EXECUTE FUNCTION app_council_level();

-- Who may pass an item to the Great council: its maintainer, its decision owner, the head of its
-- department or an organization admin — the people who already hold authority over the item.
CREATE FUNCTION app_escalate_council(idea uuid, kind text, why text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i record;
  me uuid := app_membership_id();
  head uuid;
  id uuid;
BEGIN
  SELECT * INTO i FROM public.ideas x WHERE x.id = idea AND x.organization_id = app_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_full_member() OR NOT app_idea_visible(idea) THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = '42501';
  END IF;
  SELECT d.head_membership_id INTO head FROM public.departments d WHERE d.id = i.department_id AND d.organization_id = app_org_id();
  IF NOT (me IN (i.maintainer_membership_id, i.decision_owner_membership_id) OR coalesce(head = me, false)
          OR app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only the maintainer, the decision owner, the head of the department or an admin passes an item to the Great council' USING ERRCODE = '42501';
  END IF;
  IF i.stage NOT IN ('published', 'review', 'development', 'verification', 'decision') THEN
    RAISE EXCEPTION 'only items under consideration go to a council' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.council_escalations e WHERE e.idea_id = idea) THEN
    RAISE EXCEPTION 'the item is already at the Great council' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.council_escalations (organization_id, idea_id, from_department_id, escalated_by_membership_id, reason_kind, reason)
  VALUES (app_org_id(), idea, i.department_id, me, kind, why) RETURNING council_escalations.id INTO id;
  INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (app_org_id(), app_user_id(), 'council.escalated', 'idea', idea, jsonb_build_object('kind', kind, 'from_department', i.department_id));
  RETURN id;
END $$;
REVOKE EXECUTE ON FUNCTION app_escalate_council(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_escalate_council(uuid, text, text) TO modus_app;

-- ---------------------------------------------------------------------------
-- 5. The message «вопрос передан к Большому Круглому столу», proven by the escalation row.
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
   'meeting_rescheduled','meeting_cancelled','deadline_soon','castle_xp',
   'knowledge_submitted','knowledge_in_library','knowledge_archived','knowledge_reverify',
   'council_escalated'));

CREATE FUNCTION app_notify_escalation(esc uuid, recipients uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  e record;
  n integer;
BEGIN
  SELECT * INTO e FROM public.council_escalations x WHERE x.id = esc AND x.organization_id = app_org_id();
  IF NOT FOUND OR NOT app_actor_ok() OR e.escalated_by_membership_id <> app_membership_id() THEN
    RAISE EXCEPTION 'notification is not backed by an escalation' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
  SELECT app_org_id(), m.id, e.escalated_by_membership_id, 'council_escalated', e.idea_id, 'council_escalated:' || esc
    FROM public.memberships m
   WHERE m.id = ANY (recipients) AND m.id <> e.escalated_by_membership_id AND m.organization_id = app_org_id()
     AND m.status = 'active' AND m.access = 'member'
     AND app_notification_enabled(m.id, 'council_escalated', e.idea_id)
  ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_notify_escalation(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_escalation(uuid, uuid[]) TO modus_app;
