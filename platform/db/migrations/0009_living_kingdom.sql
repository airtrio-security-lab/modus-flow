-- MODUS FLOW · 0009 · Living kingdom: game titles, council meetings with recording,
-- transcripts and reviewed findings (ADR-0014). Additive: no existing rule changes.
--
-- Four separate things about a person: job title (directory), system rights
-- (memberships.roles), game title (this file) and achievements (XP of the castle).
-- A game title never grants rights: no policy below or elsewhere reads it.

-- ---------------------------------------------------------------------------
-- 1. Game titles
-- ---------------------------------------------------------------------------
-- Guild titles of a department, senior first; editable by admins. The last one is
-- the default for employees of that department (never a humiliating name).
CREATE FUNCTION app_titles_ok(t text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(t) BETWEEN 1 AND 8 AND coalesce((SELECT bool_and(length(btrim(x)) BETWEEN 2 AND 60) FROM unnest(t) x), false)
$$;
CREATE TABLE guild_titles (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  department_id   uuid NOT NULL,
  titles          text[] NOT NULL CHECK (app_titles_ok(titles)),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, department_id),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id)
);

-- A title assigned to a person by an admin: king (owner), regent (deputy) or a guild title.
CREATE TABLE game_titles (
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  membership_id          uuid NOT NULL,
  rank                   text NOT NULL CHECK (rank IN ('king', 'regent', 'guild')),
  title                  text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 60),
  assigned_by_membership_id uuid NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, membership_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, assigned_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE UNIQUE INDEX game_titles_one_king ON game_titles (organization_id) WHERE rank = 'king';
CREATE UNIQUE INDEX game_titles_one_regent ON game_titles (organization_id) WHERE rank = 'regent';

ALTER TABLE guild_titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_titles ENABLE ROW LEVEL SECURITY;
CREATE POLICY guild_titles_read ON guild_titles FOR SELECT TO modus_app USING (organization_id = app_org_id() AND app_full_member());
CREATE POLICY guild_titles_admin ON guild_titles FOR ALL TO modus_app
  USING (organization_id = app_org_id() AND app_full_member() AND app_has_role(app_org_id(), 'org_admin'))
  WITH CHECK (organization_id = app_org_id() AND app_full_member() AND app_has_role(app_org_id(), 'org_admin'));
CREATE POLICY game_titles_read ON game_titles FOR SELECT TO modus_app USING (organization_id = app_org_id() AND app_full_member());
CREATE POLICY game_titles_admin ON game_titles FOR ALL TO modus_app
  USING (organization_id = app_org_id() AND app_full_member() AND app_has_role(app_org_id(), 'org_admin'))
  WITH CHECK (organization_id = app_org_id() AND app_full_member() AND app_has_role(app_org_id(), 'org_admin')
              AND assigned_by_membership_id = app_membership_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON guild_titles, game_titles TO modus_app;

-- ---------------------------------------------------------------------------
-- 2. Council meetings with consent
-- ---------------------------------------------------------------------------
CREATE TABLE meetings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  scope                    text NOT NULL CHECK (scope IN ('royal', 'castle')),
  department_id            uuid,
  idea_id                  uuid,
  title                    text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  organizer_membership_id  uuid NOT NULL,
  recording_started_at     timestamptz,
  ended_at                 timestamptz,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  CHECK ((scope = 'castle') = (department_id IS NOT NULL)),
  FOREIGN KEY (organization_id, organizer_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id)
);

CREATE TABLE meeting_participants (
  organization_id uuid NOT NULL,
  meeting_id      uuid NOT NULL REFERENCES meetings(id),
  membership_id   uuid NOT NULL,
  consent         text NOT NULL DEFAULT 'pending' CHECK (consent IN ('pending', 'given', 'declined')),
  consent_at      timestamptz,
  PRIMARY KEY (meeting_id, membership_id),
  CHECK ((consent = 'pending') = (consent_at IS NULL)),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id)
);

-- Who may see a meeting, its recording and transcript: its participants only.
CREATE FUNCTION app_meeting_participant(meeting uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_actor_ok() AND EXISTS (
    SELECT 1 FROM public.meeting_participants p JOIN public.meetings m ON m.id = p.meeting_id
     WHERE p.meeting_id = meeting AND p.membership_id = app_membership_id() AND m.organization_id = app_org_id())
$$;
CREATE FUNCTION app_meeting_organizer(meeting uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_actor_ok() AND EXISTS (
    SELECT 1 FROM public.meetings m WHERE m.id = meeting AND m.organization_id = app_org_id()
       AND m.organizer_membership_id = app_membership_id())
$$;
CREATE FUNCTION app_meeting_all_consented(meeting uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.meeting_participants WHERE meeting_id = meeting)
     AND NOT EXISTS (SELECT 1 FROM public.meeting_participants WHERE meeting_id = meeting AND consent <> 'given')
$$;
GRANT EXECUTE ON FUNCTION app_meeting_participant(uuid), app_meeting_organizer(uuid), app_meeting_all_consented(uuid) TO modus_app;

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY meetings_read ON meetings FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND (organizer_membership_id = app_membership_id() OR app_meeting_participant(id)));
-- Only leads call a meeting (maintainer, decision owner, admin; full members).
CREATE POLICY meetings_insert ON meetings FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND organizer_membership_id = app_membership_id() AND app_is_lead()
              AND recording_started_at IS NULL AND ended_at IS NULL);
CREATE POLICY meetings_update ON meetings FOR UPDATE TO modus_app
  USING (organization_id = app_org_id() AND organizer_membership_id = app_membership_id())
  WITH CHECK (organization_id = app_org_id() AND organizer_membership_id = app_membership_id());
GRANT SELECT, INSERT ON meetings TO modus_app;
GRANT UPDATE (recording_started_at, ended_at) ON meetings TO modus_app;

CREATE POLICY meeting_participants_read ON meeting_participants FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND (app_meeting_participant(meeting_id) OR app_meeting_organizer(meeting_id)));
CREATE POLICY meeting_participants_insert ON meeting_participants FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND app_meeting_organizer(meeting_id));
-- Consent is given or declined only by the person themselves.
CREATE POLICY meeting_participants_consent ON meeting_participants FOR UPDATE TO modus_app
  USING (organization_id = app_org_id() AND membership_id = app_membership_id())
  WITH CHECK (organization_id = app_org_id() AND membership_id = app_membership_id());
GRANT SELECT, INSERT ON meeting_participants TO modus_app;
GRANT UPDATE (consent, consent_at) ON meeting_participants TO modus_app;

CREATE FUNCTION app_meeting_rules() RETURNS trigger
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
    IF EXISTS (SELECT 1 FROM public.meetings m WHERE m.id = NEW.meeting_id AND m.recording_started_at IS NOT NULL) THEN
      RAISE EXCEPTION 'consent is fixed once recording started' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- meetings
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
CREATE TRIGGER meeting_participants_rules BEFORE INSERT OR UPDATE ON meeting_participants FOR EACH ROW EXECUTE FUNCTION app_meeting_rules();
CREATE TRIGGER meetings_rules BEFORE UPDATE ON meetings FOR EACH ROW EXECUTE FUNCTION app_meeting_rules();
CREATE TRIGGER meetings_no_delete BEFORE DELETE ON meetings FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER meeting_participants_no_delete BEFORE DELETE ON meeting_participants FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- 3. Recordings (stored in PostgreSQL: same tenant isolation, transactions and backups)
-- ---------------------------------------------------------------------------
CREATE TABLE meeting_recordings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL,
  meeting_id                uuid NOT NULL UNIQUE REFERENCES meetings(id),
  source                    text NOT NULL CHECK (source IN ('microphone', 'upload')),
  content_type              text NOT NULL CHECK (content_type IN ('audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav')),
  size_bytes                integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  duration_ms               integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 14400000),
  sha256                    text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data                      bytea NOT NULL,
  uploaded_by_membership_id uuid NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings(organization_id, id),
  FOREIGN KEY (organization_id, uploaded_by_membership_id) REFERENCES memberships(organization_id, id)
);
ALTER TABLE meeting_recordings ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_recordings_read ON meeting_recordings FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_meeting_participant(meeting_id));
CREATE POLICY meeting_recordings_insert ON meeting_recordings FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND uploaded_by_membership_id = app_membership_id()
              AND app_meeting_organizer(meeting_id) AND app_meeting_all_consented(meeting_id));
GRANT SELECT, INSERT ON meeting_recordings TO modus_app;
CREATE TRIGGER meeting_recordings_append_only BEFORE UPDATE OR DELETE ON meeting_recordings FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- 4. Transcripts: where the text came from is always stored and shown
-- ---------------------------------------------------------------------------
CREATE TABLE meeting_transcripts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  meeting_id               uuid NOT NULL REFERENCES meetings(id),
  source                   text NOT NULL CHECK (source IN ('engine', 'manual', 'prepared')),
  engine                   text CHECK (engine IS NULL OR length(engine) <= 120),
  text                     text NOT NULL CHECK (length(text) BETWEEN 20 AND 100000),
  segments                 jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(segments) = 'array'),
  sha256                   text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (meeting_id, sha256),
  CHECK ((source = 'engine') = (engine IS NOT NULL)),
  FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings(organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES memberships(organization_id, id)
);
ALTER TABLE meeting_transcripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_transcripts_read ON meeting_transcripts FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_meeting_participant(meeting_id));
CREATE POLICY meeting_transcripts_insert ON meeting_transcripts FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND created_by_membership_id = app_membership_id() AND app_meeting_participant(meeting_id)
              AND app_is_lead());
GRANT SELECT, INSERT ON meeting_transcripts TO modus_app;
CREATE TRIGGER meeting_transcripts_append_only BEFORE UPDATE OR DELETE ON meeting_transcripts FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- 5. Findings: the 0008 protocol pipeline, extended (evidence rules unchanged)
-- ---------------------------------------------------------------------------
ALTER TABLE meeting_protocols ADD COLUMN transcript_id uuid REFERENCES meeting_transcripts(id);
-- A meeting transcript may be longer than a typed protocol.
ALTER TABLE meeting_protocols DROP CONSTRAINT meeting_protocols_source_text_check;
ALTER TABLE meeting_protocols ADD CONSTRAINT meeting_protocols_source_text_check
  CHECK (length(source_text) BETWEEN 20 AND CASE WHEN transcript_id IS NULL THEN 20000 ELSE 100000 END);
-- Re-analysing the same transcript by the same method returns the same findings, never duplicates.
CREATE UNIQUE INDEX meeting_protocols_one_per_transcript ON meeting_protocols (transcript_id, method) WHERE transcript_id IS NOT NULL;

ALTER TABLE protocol_candidates
  ADD COLUMN finding_type text NOT NULL DEFAULT 'problem' CHECK (finding_type IN (
    'idea', 'problem', 'task', 'deadline', 'owner_candidate', 'proposed_solution',
    'decision', 'risk', 'objection', 'open_question', 'insight')),
  ADD COLUMN audio_start_ms integer CHECK (audio_start_ms IS NULL OR audio_start_ms >= 0),
  ADD COLUMN speaker_label text CHECK (speaker_label IS NULL OR length(speaker_label) <= 120),
  ADD COLUMN speaker_membership_id uuid,
  ADD COLUMN confidence text CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  ADD COLUMN basis text CHECK (basis IS NULL OR length(basis) <= 200);
-- 'noted': kept in the organization's memory as a reviewed fact, without creating an item.
ALTER TABLE protocol_candidates DROP CONSTRAINT protocol_candidates_status_check;
ALTER TABLE protocol_candidates ADD CONSTRAINT protocol_candidates_status_check CHECK (status IN ('proposed', 'accepted', 'dismissed', 'noted'));
ALTER TABLE protocol_candidates ADD CONSTRAINT protocol_candidates_speaker_fk FOREIGN KEY (organization_id, speaker_membership_id) REFERENCES memberships(organization_id, id);
GRANT UPDATE (status, item_id, decided_by_membership_id, decided_at) ON protocol_candidates TO modus_app;

-- Speaker attribution: only to a participant of that meeting whose name is exactly the
-- label in the transcript. Anything else stays an unmatched label.
CREATE FUNCTION app_candidate_speaker() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  mtg uuid;
BEGIN
  IF NEW.speaker_membership_id IS NULL THEN RETURN NEW; END IF;
  SELECT t.meeting_id INTO mtg FROM public.meeting_protocols p JOIN public.meeting_transcripts t ON t.id = p.transcript_id
   WHERE p.id = NEW.protocol_id;
  IF mtg IS NULL OR NEW.speaker_label IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.meeting_participants mp JOIN public.memberships m ON m.id = mp.membership_id
         JOIN public.users u ON u.id = m.user_id
        WHERE mp.meeting_id = mtg AND mp.membership_id = NEW.speaker_membership_id
          AND lower(u.display_name) = lower(btrim(NEW.speaker_label))) THEN
    RAISE EXCEPTION 'speaker must be a participant named exactly in the transcript' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protocol_candidates_speaker BEFORE INSERT ON protocol_candidates FOR EACH ROW EXECUTE FUNCTION app_candidate_speaker();

-- A transcript-based protocol is readable ONLY by the meeting's participants: the 0008 rule
-- «leads read protocols» must not open a recorded conversation to leads who were not in it.
CREATE POLICY meeting_protocols_transcript_scope ON meeting_protocols AS RESTRICTIVE FOR ALL TO modus_app
  USING (transcript_id IS NULL OR app_meeting_participant((SELECT t.meeting_id FROM meeting_transcripts t WHERE t.id = transcript_id)))
  WITH CHECK (transcript_id IS NULL OR app_meeting_participant((SELECT t.meeting_id FROM meeting_transcripts t WHERE t.id = transcript_id)));
-- Meeting protocols are readable by the meeting's participants as well (in addition to 0008 rules).
CREATE POLICY meeting_protocols_read_participants ON meeting_protocols FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND transcript_id IS NOT NULL
         AND app_meeting_participant((SELECT t.meeting_id FROM meeting_transcripts t WHERE t.id = transcript_id)));

-- ---------------------------------------------------------------------------
-- 6. Notifications about meetings, backed by the meeting record (no forged senders)
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN meeting_id uuid REFERENCES meetings(id);
ALTER TABLE notifications DROP CONSTRAINT notifications_event_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN
  ('idea_published','comment_added','changes_requested','assigned',
   'verification_started','verification_completed','idea_merged',
   'idea_rejected','contribution_confirmed','honor_board_recognition',
   'objection_raised','revision_submitted','suggestion_submitted','suggestion_decided',
   'status_report','implemented','raised_on_behalf','escalated',
   'council_recommendation','council_handoff','castle_level_up',
   'meeting_called','meeting_recording_started','meeting_findings_ready'));

CREATE FUNCTION app_notify_meeting(event text, meeting uuid, recipients uuid[], dedupe text) RETURNS integer
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
    WHEN 'meeting_called' THEN m.organizer_membership_id = actor
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
  ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_notify_meeting(text, uuid, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_meeting(text, uuid, uuid[], text) TO modus_app;
