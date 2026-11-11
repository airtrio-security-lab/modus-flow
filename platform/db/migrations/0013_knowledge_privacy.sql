-- MODUS FLOW · 0013 · Personal data in organizational memory (owner brief 2026-11-11, ADR-0018).
--
-- Knowledge keeps every version and transition (0012). When there is a legal basis, an
-- organization admin can erase content or pseudonymize a person without destroying the
-- history of WHO decided WHAT and WHEN:
--   * erasure works on locations — (version, card field), a transition reason, a source or
--     application note — and replaces the text with a fixed marker in every targeted row;
--   * pseudonymization of an employee removes their references from all cards and shows
--     «Сотрудник (обезличен)» wherever knowledge names them;
--   * the log records the fact: basis, request reference, locations, counts — never the erased text;
--   * a legal hold on a source meeting blocks erasure;
--   * the retention sweep re-applies every logged erasure, so content restored from a backup is
--     erased again; the log itself can be exported to a ledger kept outside database backups.

-- Erasure and pseudonymization use the purge bypass of 0010: allowed only inside SECURITY
-- DEFINER functions (current_user is the owner), never for the application role.
DROP TRIGGER knowledge_versions_append_only ON knowledge_versions;
CREATE TRIGGER knowledge_versions_append_only BEFORE UPDATE OR DELETE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION app_forbid_unless_purge();
DROP TRIGGER knowledge_sources_append_only ON knowledge_sources;
CREATE TRIGGER knowledge_sources_append_only BEFORE UPDATE OR DELETE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION app_forbid_unless_purge();
DROP TRIGGER knowledge_applications_append_only ON knowledge_applications;
CREATE TRIGGER knowledge_applications_append_only BEFORE UPDATE OR DELETE ON knowledge_applications FOR EACH ROW EXECUTE FUNCTION app_forbid_unless_purge();
DROP TRIGGER knowledge_transitions_append_only ON knowledge_transitions;
CREATE TRIGGER knowledge_transitions_append_only BEFORE UPDATE OR DELETE ON knowledge_transitions FOR EACH ROW EXECUTE FUNCTION app_forbid_unless_purge();
-- Rows are still never deleted: only fields are overwritten.
CREATE FUNCTION app_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER knowledge_versions_keep_rows BEFORE DELETE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION app_forbid_delete();
CREATE TRIGGER knowledge_transitions_keep_rows BEFORE DELETE ON knowledge_transitions FOR EACH ROW EXECUTE FUNCTION app_forbid_delete();
CREATE TRIGGER knowledge_sources_keep_rows BEFORE DELETE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION app_forbid_delete();
CREATE TRIGGER knowledge_applications_keep_rows BEFORE DELETE ON knowledge_applications FOR EACH ROW EXECUTE FUNCTION app_forbid_delete();

ALTER TABLE knowledge_transitions DROP CONSTRAINT knowledge_transitions_action_check;
ALTER TABLE knowledge_transitions ADD CONSTRAINT knowledge_transitions_action_check CHECK (action IN (
  'registered', 'revised', 'source_added', 'application_added',
  'library_proposed', 'library_accepted', 'library_rejected',
  'archive_proposed', 'archive_approved', 'archive_rejected',
  'reverify_requested', 'reconfirmed', 'outdated', 'opened_to_organization',
  'personal_data_erased'));

-- ---------------------------------------------------------------------------
-- The log of erasures: the fact, never the content
-- ---------------------------------------------------------------------------
CREATE TABLE knowledge_redactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  scope                 text NOT NULL CHECK (scope IN ('content', 'person')),
  knowledge_id          uuid REFERENCES knowledge_items(id),
  -- Internal pseudonymous id of the person (scope 'person'); never a name.
  subject_membership_id uuid,
  legal_basis           text NOT NULL CHECK (legal_basis IN ('subject_request', 'consent_withdrawn', 'retention_expired', 'unlawful_processing', 'authority_order')),
  request_ref           text NOT NULL CHECK (length(btrim(request_ref)) BETWEEN 3 AND 80),
  -- [{"t":"version","v":2,"f":"problem"} | {"t":"transition","id":…} | {"t":"source","id":…} | {"t":"application","id":…}]
  targets               jsonb NOT NULL CHECK (jsonb_typeof(targets) = 'array'),
  rows_changed          integer NOT NULL CHECK (rows_changed >= 0),
  actor_membership_id   uuid,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope = 'content' AND knowledge_id IS NOT NULL AND subject_membership_id IS NULL)
      OR (scope = 'person' AND subject_membership_id IS NOT NULL)),
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER knowledge_redactions_append_only BEFORE UPDATE OR DELETE ON knowledge_redactions FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE knowledge_redactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_redactions_admin_read ON knowledge_redactions FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_full_member() AND app_has_role(app_org_id(), 'org_admin'));
GRANT SELECT ON knowledge_redactions TO modus_app;

CREATE FUNCTION app_knowledge_erased_text() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '[удалено: персональные данные]'::text $$;
CREATE FUNCTION app_knowledge_erased_title() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '[название удалено]'::text $$;

-- How knowledge shows a person: pseudonymized people are never named again.
CREATE FUNCTION app_knowledge_person(member uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN member IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.knowledge_redactions r WHERE r.scope = 'person' AND r.subject_membership_id = member) THEN 'Сотрудник (обезличен)'
    ELSE (SELECT e.display_name FROM public.employees e WHERE e.membership_id = member) END
$$;
GRANT EXECUTE ON FUNCTION app_knowledge_person(uuid) TO modus_app;

-- Applies one target. Idempotent: applying it again changes nothing. Returns rows changed.
CREATE FUNCTION app_knowledge_apply_target(k uuid, t jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n integer := 0;
  f text := t->>'f';
BEGIN
  PERFORM set_config('modus.purge', 'on', true);
  IF t->>'t' = 'version' THEN
    IF f = 'title' THEN
      UPDATE public.knowledge_versions SET title = app_knowledge_erased_title()
       WHERE knowledge_id = k AND version = (t->>'v')::int AND title <> app_knowledge_erased_title();
      GET DIAGNOSTICS n = ROW_COUNT;
      UPDATE public.knowledge_items x SET title = v.title
        FROM public.knowledge_versions v WHERE x.id = k AND v.knowledge_id = k AND v.version = x.current_version AND x.title <> v.title;
    ELSIF f = 'actions' OR f IN ('initiator', 'responsible') THEN
      UPDATE public.knowledge_versions SET card = card - f
       WHERE knowledge_id = k AND version = (t->>'v')::int AND card ? f;
      GET DIAGNOSTICS n = ROW_COUNT;
    ELSIF f = 'change_reason' THEN
      UPDATE public.knowledge_versions SET change_reason = app_knowledge_erased_text()
       WHERE knowledge_id = k AND version = (t->>'v')::int AND change_reason <> app_knowledge_erased_text();
      GET DIAGNOSTICS n = ROW_COUNT;
    ELSE
      UPDATE public.knowledge_versions SET card = jsonb_set(card, ARRAY[f], to_jsonb(app_knowledge_erased_text()))
       WHERE knowledge_id = k AND version = (t->>'v')::int AND card ? f AND card->>f <> app_knowledge_erased_text();
      GET DIAGNOSTICS n = ROW_COUNT;
    END IF;
  ELSIF t->>'t' = 'transition' THEN
    UPDATE public.knowledge_transitions SET reason = app_knowledge_erased_text()
     WHERE id = (t->>'id')::uuid AND knowledge_id = k AND reason IS DISTINCT FROM app_knowledge_erased_text();
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSIF t->>'t' = 'source' THEN
    UPDATE public.knowledge_sources SET note = app_knowledge_erased_text()
     WHERE id = (t->>'id')::uuid AND knowledge_id = k AND note IS DISTINCT FROM app_knowledge_erased_text();
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSIF t->>'t' = 'application' THEN
    UPDATE public.knowledge_applications SET note = app_knowledge_erased_text()
     WHERE id = (t->>'id')::uuid AND knowledge_id = k AND note IS DISTINCT FROM app_knowledge_erased_text();
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    RAISE EXCEPTION 'unknown erasure target' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('modus.purge', 'off', true);
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_knowledge_apply_target(uuid, jsonb) FROM PUBLIC;

CREATE FUNCTION app_knowledge_check_erasure(k uuid, basis text, ref text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (app_full_member() AND app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only an organization admin erases personal data' USING ERRCODE = '42501';
  END IF;
  IF basis IS NULL OR basis NOT IN ('subject_request', 'consent_withdrawn', 'retention_expired', 'unlawful_processing', 'authority_order') THEN
    RAISE EXCEPTION 'a legal basis is required' USING ERRCODE = '23514';
  END IF;
  IF ref IS NULL OR length(btrim(ref)) < 3 THEN
    RAISE EXCEPTION 'a request reference is required' USING ERRCODE = '23514';
  END IF;
  IF k IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.knowledge_sources s JOIN public.meetings m ON m.id = s.source_id
        WHERE s.knowledge_id = k AND s.source_type = 'meeting' AND m.legal_hold) THEN
    RAISE EXCEPTION 'a source meeting is under legal hold' USING ERRCODE = '23514';
  END IF;
END $$;

-- Erase locations of one piece of knowledge. Visibility is not required: an admin can erase
-- what they cannot read (locations come from the content-free privacy scan).
CREATE FUNCTION app_knowledge_erase(k uuid, basis text, ref text, targets jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  x record;
  t jsonb;
  n integer := 0;
BEGIN
  SELECT * INTO x FROM public.knowledge_items WHERE id = k AND organization_id = app_org_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'knowledge not found' USING ERRCODE = '42501'; END IF;
  PERFORM app_knowledge_check_erasure(k, basis, ref);
  IF jsonb_typeof(targets) <> 'array' OR jsonb_array_length(targets) = 0 THEN
    RAISE EXCEPTION 'nothing to erase' USING ERRCODE = '23514';
  END IF;
  FOR t IN SELECT * FROM jsonb_array_elements(targets) LOOP
    IF t->>'t' = 'version' AND NOT EXISTS (SELECT 1 FROM public.knowledge_versions v WHERE v.knowledge_id = k AND v.version = (t->>'v')::int) THEN
      RAISE EXCEPTION 'unknown erasure target' USING ERRCODE = '23514';
    END IF;
    IF t->>'t' = 'version' AND t->>'f' NOT IN ('title', 'change_reason', 'problem', 'options', 'argumentsFor', 'argumentsAgainst', 'decision', 'reasons',
         'actions', 'results', 'positive', 'negative', 'evidence', 'proof', 'applicability', 'basis', 'initiator', 'responsible') THEN
      RAISE EXCEPTION 'unknown erasure target' USING ERRCODE = '23514';
    END IF;
    n := n + app_knowledge_apply_target(k, t);
  END LOOP;
  INSERT INTO public.knowledge_redactions (organization_id, scope, knowledge_id, legal_basis, request_ref, targets, rows_changed, actor_membership_id)
  VALUES (x.organization_id, 'content', k, basis, ref, targets, n, app_membership_id());
  INSERT INTO public.knowledge_transitions (organization_id, knowledge_id, action, from_level, to_level, from_status, to_status, version, reason, actor_membership_id)
  VALUES (x.organization_id, k, 'personal_data_erased', x.level, x.level, x.status, x.status, x.current_version,
          'основание: ' || basis || '; мест: ' || jsonb_array_length(targets), app_membership_id());
  RETURN n;
END $$;

-- Pseudonymize an employee in all knowledge of the organization: references removed from every
-- card version, the name replaced on display. Text locations naming the person are passed in
-- by the caller (found by the scan) and erased in the same transaction.
CREATE FUNCTION app_knowledge_pseudonymize(member uuid, basis text, ref text, text_targets jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n integer := 0;
  c integer;
  r record;
BEGIN
  PERFORM app_knowledge_check_erasure(NULL, basis, ref);
  IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.id = member AND m.organization_id = app_org_id()) THEN
    RAISE EXCEPTION 'member not found' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.knowledge_redactions kr WHERE kr.scope = 'person' AND kr.subject_membership_id = member) THEN
    RAISE EXCEPTION 'already pseudonymized' USING ERRCODE = '23514';
  END IF;
  -- Knowledge whose source meeting is under legal hold is left untouched.
  IF EXISTS (SELECT 1 FROM public.knowledge_versions v JOIN public.knowledge_sources s ON s.knowledge_id = v.knowledge_id AND s.source_type = 'meeting'
               JOIN public.meetings m ON m.id = s.source_id
              WHERE v.organization_id = app_org_id() AND m.legal_hold
                AND (v.card->>'initiator' = member::text OR v.card->'responsible' ? member::text)) THEN
    RAISE EXCEPTION 'a source meeting is under legal hold' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('modus.purge', 'on', true);
  UPDATE public.knowledge_versions SET card = card - 'initiator'
   WHERE organization_id = app_org_id() AND card->>'initiator' = member::text;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  UPDATE public.knowledge_versions
     SET card = jsonb_set(card, '{responsible}', coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(card->'responsible') e WHERE e #>> '{}' <> member::text), '[]'::jsonb))
   WHERE organization_id = app_org_id() AND jsonb_typeof(card->'responsible') = 'array' AND card->'responsible' ? member::text;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  PERFORM set_config('modus.purge', 'off', true);
  FOR r IN SELECT DISTINCT (e->>'k')::uuid AS k FROM jsonb_array_elements(coalesce(text_targets, '[]'::jsonb)) e LOOP
    IF EXISTS (SELECT 1 FROM public.knowledge_sources s JOIN public.meetings m ON m.id = s.source_id
                WHERE s.knowledge_id = r.k AND s.source_type = 'meeting' AND m.legal_hold) THEN
      RAISE EXCEPTION 'a source meeting is under legal hold' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  FOR r IN SELECT e AS t FROM jsonb_array_elements(coalesce(text_targets, '[]'::jsonb)) e LOOP
    IF NOT EXISTS (SELECT 1 FROM public.knowledge_items x WHERE x.id = (r.t->>'k')::uuid AND x.organization_id = app_org_id()) THEN
      RAISE EXCEPTION 'knowledge not found' USING ERRCODE = '42501';
    END IF;
    n := n + app_knowledge_apply_target((r.t->>'k')::uuid, r.t);
  END LOOP;
  INSERT INTO public.knowledge_redactions (organization_id, scope, subject_membership_id, legal_basis, request_ref, targets, rows_changed, actor_membership_id)
  VALUES (app_org_id(), 'person', member, basis, ref, coalesce(text_targets, '[]'::jsonb), n, app_membership_id());
  RETURN n;
END $$;

REVOKE EXECUTE ON FUNCTION app_knowledge_erase(uuid, text, text, jsonb), app_knowledge_pseudonymize(uuid, text, text, jsonb),
  app_knowledge_check_erasure(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_knowledge_erase(uuid, text, text, jsonb), app_knowledge_pseudonymize(uuid, text, text, jsonb) TO modus_app;

-- Material for the privacy scan: every text location of the organization's knowledge, for an
-- admin only. The server scans it and returns locations and kinds — never the text.
CREATE FUNCTION app_knowledge_privacy_material() RETURNS TABLE (knowledge_id uuid, loc jsonb, body text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (app_full_member() AND app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only an organization admin scans knowledge for personal data' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT v.knowledge_id, jsonb_build_object('t', 'version', 'v', v.version, 'f', 'title'), v.title FROM public.knowledge_versions v WHERE v.organization_id = app_org_id()
    UNION ALL
    SELECT v.knowledge_id, jsonb_build_object('t', 'version', 'v', v.version, 'f', 'change_reason'), v.change_reason FROM public.knowledge_versions v WHERE v.organization_id = app_org_id()
    UNION ALL
    SELECT v.knowledge_id, jsonb_build_object('t', 'version', 'v', v.version, 'f', e.key), e.value #>> '{}'
      FROM public.knowledge_versions v, jsonb_each(v.card) e
     WHERE v.organization_id = app_org_id() AND jsonb_typeof(e.value) = 'string' AND e.key NOT IN ('initiator', 'archiveCategory', 'lastChecked')
    UNION ALL
    SELECT v.knowledge_id, jsonb_build_object('t', 'version', 'v', v.version, 'f', 'actions'), (SELECT string_agg(a->>'what', E'\n') FROM jsonb_array_elements(v.card->'actions') a)
      FROM public.knowledge_versions v WHERE v.organization_id = app_org_id() AND jsonb_typeof(v.card->'actions') = 'array'
    UNION ALL
    SELECT t.knowledge_id, jsonb_build_object('t', 'transition', 'id', t.id), t.reason FROM public.knowledge_transitions t WHERE t.organization_id = app_org_id() AND t.reason IS NOT NULL
    UNION ALL
    SELECT s.knowledge_id, jsonb_build_object('t', 'source', 'id', s.id), s.note FROM public.knowledge_sources s WHERE s.organization_id = app_org_id() AND s.note IS NOT NULL
    UNION ALL
    SELECT a.knowledge_id, jsonb_build_object('t', 'application', 'id', a.id), a.note FROM public.knowledge_applications a WHERE a.organization_id = app_org_id() AND a.note IS NOT NULL;
END $$;
REVOKE EXECUTE ON FUNCTION app_knowledge_privacy_material() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_knowledge_privacy_material() TO modus_app;

-- The list of the organization's knowledge for the scan: hall always, title only if the admin may read it.
CREATE FUNCTION app_knowledge_privacy_items() RETURNS TABLE (id uuid, level text, title text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT (app_full_member() AND app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only an organization admin scans knowledge for personal data' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT x.id, x.level, CASE WHEN app_knowledge_visible(x.id) THEN x.title END FROM public.knowledge_items x WHERE x.organization_id = app_org_id();
END $$;
REVOKE EXECUTE ON FUNCTION app_knowledge_privacy_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_knowledge_privacy_items() TO modus_app;

-- Closed-meeting material a card is compared with before it is opened to the organization.
-- Returned to the server only; access: the actor must be an approver who may see the knowledge.
CREATE FUNCTION app_knowledge_meeting_material(k uuid) RETURNS TABLE (body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.text FROM public.knowledge_sources s JOIN public.meeting_transcripts t ON t.meeting_id = s.source_id
   WHERE s.knowledge_id = k AND s.source_type = 'meeting' AND t.purged_at IS NULL AND t.text IS NOT NULL AND app_knowledge_visible(k)
  UNION ALL
  SELECT t.text FROM public.knowledge_sources s JOIN public.protocol_candidates c ON c.id = s.source_id
    JOIN public.meeting_protocols p ON p.id = c.protocol_id JOIN public.meeting_transcripts t ON t.id = p.transcript_id
   WHERE s.knowledge_id = k AND s.source_type = 'finding' AND t.purged_at IS NULL AND t.text IS NOT NULL AND app_knowledge_visible(k)
  UNION ALL
  SELECT c.quote FROM public.knowledge_sources s JOIN public.protocol_candidates c ON c.id = s.source_id
   WHERE s.knowledge_id = k AND s.source_type = 'finding' AND c.quote IS NOT NULL AND app_knowledge_visible(k)
$$;
REVOKE EXECUTE ON FUNCTION app_knowledge_meeting_material(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_knowledge_meeting_material(uuid) TO modus_app;

-- All text of one piece of knowledge (every version and note), for the check before opening it.
CREATE FUNCTION app_knowledge_all_text(k uuid) RETURNS TABLE (loc jsonb, body text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('t', 'version', 'v', v.version, 'f', 'title'), v.title FROM public.knowledge_versions v WHERE v.knowledge_id = k AND app_knowledge_visible(k)
  UNION ALL
  SELECT jsonb_build_object('t', 'version', 'v', v.version, 'f', 'change_reason'), v.change_reason FROM public.knowledge_versions v WHERE v.knowledge_id = k AND app_knowledge_visible(k)
  UNION ALL
  SELECT jsonb_build_object('t', 'version', 'v', v.version, 'f', e.key), e.value #>> '{}'
    FROM public.knowledge_versions v, jsonb_each(v.card) e
   WHERE v.knowledge_id = k AND jsonb_typeof(e.value) = 'string' AND e.key NOT IN ('initiator', 'archiveCategory', 'lastChecked') AND app_knowledge_visible(k)
  UNION ALL
  SELECT jsonb_build_object('t', 'version', 'v', v.version, 'f', 'actions'), (SELECT string_agg(a->>'what', E'\n') FROM jsonb_array_elements(v.card->'actions') a)
    FROM public.knowledge_versions v WHERE v.knowledge_id = k AND jsonb_typeof(v.card->'actions') = 'array' AND app_knowledge_visible(k)
  UNION ALL
  SELECT jsonb_build_object('t', 'transition', 'id', t.id), t.reason FROM public.knowledge_transitions t WHERE t.knowledge_id = k AND t.reason IS NOT NULL AND app_knowledge_visible(k)
  UNION ALL
  SELECT jsonb_build_object('t', 'source', 'id', s.id), s.note FROM public.knowledge_sources s WHERE s.knowledge_id = k AND s.note IS NOT NULL AND app_knowledge_visible(k)
  UNION ALL
  SELECT jsonb_build_object('t', 'application', 'id', a.id), a.note FROM public.knowledge_applications a WHERE a.knowledge_id = k AND a.note IS NOT NULL AND app_knowledge_visible(k)
$$;
REVOKE EXECUTE ON FUNCTION app_knowledge_all_text(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_knowledge_all_text(uuid) TO modus_app;

-- ---------------------------------------------------------------------------
-- After a restore: re-apply every logged erasure (called by the daily retention job)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_knowledge_reapply_erasures() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
  t jsonb;
  n integer := 0;
  c integer;
BEGIN
  FOR r IN SELECT * FROM public.knowledge_redactions ORDER BY created_at LOOP
    FOR t IN SELECT * FROM jsonb_array_elements(r.targets) LOOP
      IF EXISTS (SELECT 1 FROM public.knowledge_items x WHERE x.id = coalesce(r.knowledge_id, (t->>'k')::uuid)) THEN
        n := n + app_knowledge_apply_target(coalesce(r.knowledge_id, (t->>'k')::uuid), t);
      END IF;
    END LOOP;
    IF r.scope = 'person' THEN
      PERFORM set_config('modus.purge', 'on', true);
      UPDATE public.knowledge_versions SET card = card - 'initiator'
       WHERE organization_id = r.organization_id AND card->>'initiator' = r.subject_membership_id::text;
      GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
      UPDATE public.knowledge_versions
         SET card = jsonb_set(card, '{responsible}', coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(card->'responsible') e WHERE e #>> '{}' <> r.subject_membership_id::text), '[]'::jsonb))
       WHERE organization_id = r.organization_id AND jsonb_typeof(card->'responsible') = 'array' AND card->'responsible' ? r.subject_membership_id::text;
      GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
      PERFORM set_config('modus.purge', 'off', true);
    END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_knowledge_reapply_erasures() FROM PUBLIC;
