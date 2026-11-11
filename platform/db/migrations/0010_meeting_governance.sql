-- MODUS FLOW · 0010 · Meeting governance (owner decisions 2026-11-11, ADR-0015).
--
-- 1. Consent is personal (unchanged since 0009). Without everyone's consent there is
--    no recording; the alternative is a written protocol without recording ('minutes').
-- 2. Retention: recordings 30 days, transcripts 90 days by default, set per organization
--    after a legal review. Expired raw material is purged by a scheduled job.
-- 3. Deletion only by an authorized admin, with a reason, never under legal hold, and
--    every purge is written to an append-only log (no content in the log, only hashes).
-- 4. Confirmed decisions and their execution live in ideas/decisions/xp tables, apart
--    from raw audio. On purge only unconfirmed drafts disappear; confirmed findings stay
--    as the evidence of a decision, governed by corporate policy.

-- ---------------------------------------------------------------------------
-- 1. Written protocol without recording
-- ---------------------------------------------------------------------------
ALTER TABLE meeting_transcripts DROP CONSTRAINT meeting_transcripts_source_check;
ALTER TABLE meeting_transcripts ADD CONSTRAINT meeting_transcripts_source_check CHECK (source IN ('engine', 'manual', 'prepared', 'minutes'));

-- ---------------------------------------------------------------------------
-- 2. Retention settings and legal hold
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN audio_retention_days integer NOT NULL DEFAULT 30 CHECK (audio_retention_days BETWEEN 1 AND 3650),
  ADD COLUMN transcript_retention_days integer NOT NULL DEFAULT 90 CHECK (transcript_retention_days BETWEEN 1 AND 3650);
GRANT SELECT (audio_retention_days, transcript_retention_days) ON organizations TO modus_app;
GRANT UPDATE (audio_retention_days, transcript_retention_days) ON organizations TO modus_app;

ALTER TABLE meetings
  ADD COLUMN legal_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN legal_hold_reason text CHECK (legal_hold_reason IS NULL OR length(btrim(legal_hold_reason)) BETWEEN 5 AND 500),
  ADD CONSTRAINT meetings_hold_reason CHECK (NOT legal_hold OR legal_hold_reason IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. Purgeable raw material: the row stays (who, when, hash), the content goes
-- ---------------------------------------------------------------------------
ALTER TABLE meeting_recordings ALTER COLUMN data DROP NOT NULL;
ALTER TABLE meeting_recordings ADD COLUMN purged_at timestamptz;
ALTER TABLE meeting_recordings ADD CONSTRAINT meeting_recordings_purge CHECK ((purged_at IS NULL) = (data IS NOT NULL));
ALTER TABLE meeting_transcripts ADD COLUMN purged_at timestamptz;
ALTER TABLE meeting_protocols ADD COLUMN purged_at timestamptz;

-- Append-only tables may change only inside the purge functions below. The flag is set
-- with set_config(…, true) by those SECURITY DEFINER functions; the application role has
-- no UPDATE/DELETE grant on these tables, so the flag alone gives it nothing.
CREATE FUNCTION app_forbid_unless_purge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('modus.purge', true) = 'on' AND current_user::text <> 'modus_app' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
DROP TRIGGER meeting_recordings_append_only ON meeting_recordings;
CREATE TRIGGER meeting_recordings_append_only BEFORE UPDATE OR DELETE ON meeting_recordings FOR EACH ROW EXECUTE FUNCTION app_forbid_unless_purge();
DROP TRIGGER meeting_transcripts_append_only ON meeting_transcripts;
CREATE TRIGGER meeting_transcripts_append_only BEFORE UPDATE OR DELETE ON meeting_transcripts FOR EACH ROW EXECUTE FUNCTION app_forbid_unless_purge();
DROP TRIGGER meeting_protocols_append_only ON meeting_protocols;
CREATE TRIGGER meeting_protocols_append_only BEFORE UPDATE OR DELETE ON meeting_protocols FOR EACH ROW EXECUTE FUNCTION app_forbid_unless_purge();
DROP TRIGGER protocol_candidates_no_delete ON protocol_candidates;
CREATE TRIGGER protocol_candidates_no_delete BEFORE DELETE ON protocol_candidates FOR EACH ROW EXECUTE FUNCTION app_forbid_unless_purge();

-- ---------------------------------------------------------------------------
-- 4. The immutable log of purges, holds and retention changes (no content, only hashes)
-- ---------------------------------------------------------------------------
CREATE TABLE retention_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  meeting_id          uuid REFERENCES meetings(id),
  object              text NOT NULL CHECK (object IN ('recording', 'transcript', 'meeting', 'organization')),
  object_id           uuid,
  action              text NOT NULL CHECK (action IN ('purged', 'hold_set', 'hold_released', 'retention_changed')),
  reason              text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  actor_membership_id uuid,
  content_sha256      text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes          integer,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER retention_log_append_only BEFORE UPDATE OR DELETE ON retention_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE retention_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY retention_log_admin_read ON retention_log FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_full_member() AND app_has_role(app_org_id(), 'org_admin'));
GRANT SELECT ON retention_log TO modus_app;

-- Purge one meeting's recording or transcripts. Inner function: no rights check, used by
-- the admin entry point and by the scheduled sweep (actor NULL = system).
CREATE FUNCTION app_purge_media_inner(mtg uuid, what text, why text, actor uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  m record;
  r record;
  n integer := 0;
BEGIN
  SELECT * INTO m FROM public.meetings WHERE id = mtg FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'meeting not found' USING ERRCODE = '42501'; END IF;
  IF m.legal_hold THEN
    RAISE EXCEPTION 'legal hold: deletion is forbidden while the meeting is under hold' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('modus.purge', 'on', true);
  IF what IN ('recording', 'all') THEN
    FOR r IN SELECT id, sha256, size_bytes FROM public.meeting_recordings WHERE meeting_id = mtg AND purged_at IS NULL LOOP
      UPDATE public.meeting_recordings SET data = NULL, purged_at = clock_timestamp() WHERE id = r.id;
      INSERT INTO public.retention_log (organization_id, meeting_id, object, object_id, action, reason, actor_membership_id, content_sha256, size_bytes)
      VALUES (m.organization_id, mtg, 'recording', r.id, 'purged', why, actor, r.sha256, r.size_bytes);
      n := n + 1;
    END LOOP;
  END IF;
  IF what IN ('transcript', 'all') THEN
    FOR r IN SELECT id, sha256, length(text) AS size FROM public.meeting_transcripts WHERE meeting_id = mtg AND purged_at IS NULL LOOP
      -- Unconfirmed drafts go; confirmed findings (accepted into an item or noted) stay as decision evidence.
      DELETE FROM public.protocol_candidates k USING public.meeting_protocols p
       WHERE k.protocol_id = p.id AND p.transcript_id = r.id AND k.status IN ('proposed', 'dismissed');
      UPDATE public.meeting_protocols SET source_text = '[текст удалён по сроку хранения]', purged_at = clock_timestamp()
       WHERE transcript_id = r.id AND purged_at IS NULL;
      UPDATE public.meeting_transcripts SET text = '[расшифровка удалена по сроку хранения]', segments = '[]', purged_at = clock_timestamp() WHERE id = r.id;
      INSERT INTO public.retention_log (organization_id, meeting_id, object, object_id, action, reason, actor_membership_id, content_sha256, size_bytes)
      VALUES (m.organization_id, mtg, 'transcript', r.id, 'purged', why, actor, r.sha256, r.size);
      n := n + 1;
    END LOOP;
  END IF;
  PERFORM set_config('modus.purge', 'off', true);
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_purge_media_inner(uuid, text, text, uuid) FROM PUBLIC;

-- Admin entry point: only an org admin who is a full member; a reason is required.
CREATE FUNCTION app_purge_meeting_media(mtg uuid, what text, why text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (app_full_member() AND app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only an organization admin deletes meeting material' USING ERRCODE = '42501';
  END IF;
  IF what NOT IN ('recording', 'transcript', 'all') OR why IS NULL OR length(btrim(why)) < 5 THEN
    RAISE EXCEPTION 'say what to delete and why (at least 5 characters)' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.meetings WHERE id = mtg AND organization_id = app_org_id()) THEN
    RAISE EXCEPTION 'meeting not found' USING ERRCODE = '42501';
  END IF;
  RETURN app_purge_media_inner(mtg, what, 'удалено администратором: ' || btrim(why), app_membership_id());
END $$;
REVOKE EXECUTE ON FUNCTION app_purge_meeting_media(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_meeting_media(uuid, text, text) TO modus_app;

CREATE FUNCTION app_set_legal_hold(mtg uuid, hold boolean, why text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  m record;
BEGIN
  IF NOT (app_full_member() AND app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only an organization admin sets a legal hold' USING ERRCODE = '42501';
  END IF;
  IF why IS NULL OR length(btrim(why)) < 5 THEN
    RAISE EXCEPTION 'a legal hold needs a reason (at least 5 characters)' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO m FROM public.meetings WHERE id = mtg AND organization_id = app_org_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'meeting not found' USING ERRCODE = '42501'; END IF;
  UPDATE public.meetings SET legal_hold = hold, legal_hold_reason = CASE WHEN hold THEN btrim(why) ELSE NULL END WHERE id = mtg;
  INSERT INTO public.retention_log (organization_id, meeting_id, object, action, reason, actor_membership_id)
  VALUES (m.organization_id, mtg, 'meeting', CASE WHEN hold THEN 'hold_set' ELSE 'hold_released' END, btrim(why), app_membership_id());
  RETURN hold;
END $$;
REVOKE EXECUTE ON FUNCTION app_set_legal_hold(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_legal_hold(uuid, boolean, text) TO modus_app;

-- Retention changes by the admin are logged too (the column update itself goes through RLS).
CREATE FUNCTION app_log_retention_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.audio_retention_days, NEW.transcript_retention_days) IS DISTINCT FROM (OLD.audio_retention_days, OLD.transcript_retention_days) THEN
    INSERT INTO public.retention_log (organization_id, object, object_id, action, reason, actor_membership_id)
    VALUES (NEW.id, 'organization', NEW.id, 'retention_changed',
            format('аудио %s → %s дн., расшифровки %s → %s дн.', OLD.audio_retention_days, NEW.audio_retention_days,
                   OLD.transcript_retention_days, NEW.transcript_retention_days),
            app_membership_id());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_retention_log AFTER UPDATE OF audio_retention_days, transcript_retention_days ON organizations
  FOR EACH ROW EXECUTE FUNCTION app_log_retention_change();

-- Scheduled job (schema owner, e.g. daily cron): purge what expired, skip legal holds, and
-- re-apply purges recorded in the log to content that came back from a backup restore.
CREATE FUNCTION app_retention_sweep(at timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT m.id FROM public.meetings m JOIN public.organizations o ON o.id = m.organization_id
      JOIN public.meeting_recordings x ON x.meeting_id = m.id
     WHERE NOT m.legal_hold AND x.purged_at IS NULL
       AND (x.created_at < at - make_interval(days => o.audio_retention_days)
            OR EXISTS (SELECT 1 FROM public.retention_log l WHERE l.object = 'recording' AND l.object_id = x.id AND l.action = 'purged'))
  LOOP
    n := n + app_purge_media_inner(r.id, 'recording', 'истёк срок хранения записи или повторное удаление после восстановления', NULL);
  END LOOP;
  FOR r IN
    SELECT DISTINCT m.id FROM public.meetings m JOIN public.organizations o ON o.id = m.organization_id
      JOIN public.meeting_transcripts t ON t.meeting_id = m.id
     WHERE NOT m.legal_hold AND t.purged_at IS NULL
       AND (t.created_at < at - make_interval(days => o.transcript_retention_days)
            OR EXISTS (SELECT 1 FROM public.retention_log l WHERE l.object = 'transcript' AND l.object_id = t.id AND l.action = 'purged'))
  LOOP
    n := n + app_purge_media_inner(r.id, 'transcript', 'истёк срок хранения расшифровки или повторное удаление после восстановления', NULL);
  END LOOP;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_retention_sweep(timestamptz) FROM PUBLIC;

-- Admin overview without content: what is stored, until when, and holds.
CREATE FUNCTION app_retention_overview() RETURNS TABLE (
  meeting_id uuid, title text, created_at timestamptz, legal_hold boolean, legal_hold_reason text,
  recording_at timestamptz, recording_bytes integer, recording_purged_at timestamptz, recording_expires_at timestamptz,
  transcripts integer, transcripts_purged integer, transcript_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m.id, m.title, m.created_at, m.legal_hold, m.legal_hold_reason,
         x.created_at, x.size_bytes, x.purged_at,
         CASE WHEN x.id IS NOT NULL AND x.purged_at IS NULL THEN x.created_at + make_interval(days => o.audio_retention_days) END,
         (SELECT count(*)::int FROM public.meeting_transcripts t WHERE t.meeting_id = m.id),
         (SELECT count(*)::int FROM public.meeting_transcripts t WHERE t.meeting_id = m.id AND t.purged_at IS NOT NULL),
         (SELECT min(t.created_at) + make_interval(days => o.transcript_retention_days) FROM public.meeting_transcripts t
           WHERE t.meeting_id = m.id AND t.purged_at IS NULL)
    FROM public.meetings m JOIN public.organizations o ON o.id = m.organization_id
    LEFT JOIN public.meeting_recordings x ON x.meeting_id = m.id
   WHERE m.organization_id = app_org_id() AND app_full_member() AND app_has_role(app_org_id(), 'org_admin')
   ORDER BY m.created_at DESC
$$;
REVOKE EXECUTE ON FUNCTION app_retention_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_retention_overview() TO modus_app;
