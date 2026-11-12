-- MODUS FLOW · 0012 · «Наследие Королевства» (owner brief 2026-11-11, ADR-0017).
--
-- One knowledge model with three levels — Летопись (chronicle), Библиотека (library),
-- Высший Архив (archive) — provenance, versions and a history of transitions. Knowledge
-- REFERENCES its sources (items, meetings, findings) instead of copying them, so access
-- rights and retention of the sources keep working. Every transition is a deliberate act
-- of a person with the right system role; nothing moves by likes, XP or views.
-- «Архивариус» is a system role for curation only: it opens no confidential material.

-- ---------------------------------------------------------------------------
-- 1. The archivist role (granted by an admin; curation rights only)
-- ---------------------------------------------------------------------------
ALTER TABLE memberships DROP CONSTRAINT memberships_roles_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_roles_check CHECK (cardinality(roles) > 0
  AND roles <@ ARRAY['employee', 'maintainer', 'decision_owner', 'org_admin', 'archivist']);

CREATE FUNCTION app_set_archivist(member uuid, grant_role boolean) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r text[];
BEGIN
  IF NOT (app_full_member() AND app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only an organization admin grants the archivist role' USING ERRCODE = '42501';
  END IF;
  UPDATE public.memberships
     SET roles = CASE WHEN grant_role THEN (SELECT array_agg(DISTINCT x) FROM unnest(roles || ARRAY['archivist']) x)
                      ELSE array_remove(roles, 'archivist') END
   WHERE id = member AND organization_id = app_org_id() AND access = 'member' AND status = 'active'
  RETURNING roles INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'member not found' USING ERRCODE = '42501'; END IF;
  INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (app_org_id(), app_user_id(), CASE WHEN grant_role THEN 'role.archivist_granted' ELSE 'role.archivist_revoked' END, 'membership', member, '{}');
  RETURN r;
END $$;
REVOKE EXECUTE ON FUNCTION app_set_archivist(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_archivist(uuid, boolean) TO modus_app;

CREATE FUNCTION app_is_archivist() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_full_member() AND app_has_role(app_org_id(), 'archivist')
$$;
-- Approves inclusion into the Higher Archive and opening knowledge to the whole organization.
CREATE FUNCTION app_is_approver() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_full_member() AND (app_has_role(app_org_id(), 'decision_owner') OR app_has_role(app_org_id(), 'org_admin'))
$$;
GRANT EXECUTE ON FUNCTION app_is_archivist(), app_is_approver() TO modus_app;

-- ---------------------------------------------------------------------------
-- 2. The knowledge model
-- ---------------------------------------------------------------------------
CREATE TABLE knowledge_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  level                    text NOT NULL DEFAULT 'chronicle' CHECK (level IN ('chronicle', 'library', 'archive')),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_review', 'outdated')),
  review                   text NOT NULL DEFAULT 'none' CHECK (review IN ('none', 'library_proposed', 'archive_proposed')),
  kind                     text NOT NULL CHECK (kind IN ('problem', 'decision', 'method', 'improvement', 'discovery', 'lesson', 'history')),
  title                    text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  -- 'sources': only people who can open every source; 'organization': opened to all members by an approver.
  visibility               text NOT NULL DEFAULT 'sources' CHECK (visibility IN ('sources', 'organization')),
  current_version          integer NOT NULL DEFAULT 1,
  last_verified_at         timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES memberships(organization_id, id)
);

-- The card: problem, options, arguments, decision, people, reasons, actions, results,
-- positive and negative experience, and for the archive — proof, applicability, last check,
-- grounds of inclusion. Versions are append-only; the reason of every change is kept.
CREATE TABLE knowledge_versions (
  knowledge_id         uuid NOT NULL REFERENCES knowledge_items(id),
  version              integer NOT NULL CHECK (version >= 1),
  organization_id      uuid NOT NULL,
  title                text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  card                 jsonb NOT NULL CHECK (jsonb_typeof(card) = 'object'),
  change_reason        text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 3 AND 500),
  author_membership_id uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (knowledge_id, version),
  FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships(organization_id, id)
);

-- Provenance: what the knowledge rests on. References only — the content stays in its source.
CREATE TABLE knowledge_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL,
  knowledge_id          uuid NOT NULL REFERENCES knowledge_items(id),
  source_type           text NOT NULL CHECK (source_type IN ('idea', 'meeting', 'finding', 'knowledge')),
  source_id             uuid NOT NULL,
  note                  text CHECK (note IS NULL OR length(note) <= 300),
  added_by_membership_id uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (knowledge_id, source_type, source_id),
  FOREIGN KEY (organization_id, added_by_membership_id) REFERENCES memberships(organization_id, id)
);

-- Re-applications of a method to another item; confirmed when that item is implemented.
CREATE TABLE knowledge_applications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  knowledge_id             uuid NOT NULL REFERENCES knowledge_items(id),
  idea_id                  uuid NOT NULL,
  note                     text CHECK (note IS NULL OR length(note) <= 500),
  recorded_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (knowledge_id, idea_id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, recorded_by_membership_id) REFERENCES memberships(organization_id, id)
);

-- The history of every transition: who, what, why, at which version.
CREATE TABLE knowledge_transitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  knowledge_id        uuid NOT NULL REFERENCES knowledge_items(id),
  action              text NOT NULL CHECK (action IN (
                        'registered', 'revised', 'source_added', 'application_added',
                        'library_proposed', 'library_accepted', 'library_rejected',
                        'archive_proposed', 'archive_approved', 'archive_rejected',
                        'reverify_requested', 'reconfirmed', 'outdated', 'opened_to_organization')),
  from_level          text,
  to_level            text,
  from_status         text,
  to_status           text,
  version             integer NOT NULL,
  reason              text CHECK (reason IS NULL OR length(reason) <= 1000),
  actor_membership_id uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE INDEX knowledge_transitions_item ON knowledge_transitions (knowledge_id, created_at);

CREATE TRIGGER knowledge_versions_append_only BEFORE UPDATE OR DELETE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER knowledge_sources_append_only BEFORE UPDATE OR DELETE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER knowledge_applications_append_only BEFORE UPDATE OR DELETE ON knowledge_applications FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER knowledge_transitions_append_only BEFORE UPDATE OR DELETE ON knowledge_transitions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER knowledge_items_no_delete BEFORE DELETE ON knowledge_items FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- 3. Who may see a piece of knowledge: full members who can open every source,
--    unless an approver opened it to the organization. Roles and titles add nothing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_knowledge_visible_for(k uuid, member uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.knowledge_items x
      JOIN public.memberships m ON m.id = member AND m.organization_id = x.organization_id AND m.status = 'active' AND m.access = 'member'
     WHERE x.id = k
       AND (x.visibility = 'organization' OR NOT EXISTS (
             SELECT 1 FROM public.knowledge_sources s
              WHERE s.knowledge_id = x.id
                AND ((s.source_type = 'meeting' AND NOT EXISTS (
                        SELECT 1 FROM public.meeting_participants p WHERE p.meeting_id = s.source_id AND p.membership_id = member AND p.removed_at IS NULL))
                  OR (s.source_type = 'finding' AND NOT EXISTS (
                        SELECT 1 FROM public.protocol_candidates c
                          JOIN public.meeting_protocols pr ON pr.id = c.protocol_id
                          JOIN public.meeting_transcripts t ON t.id = pr.transcript_id
                          JOIN public.meeting_participants p ON p.meeting_id = t.meeting_id
                         WHERE c.id = s.source_id AND p.membership_id = member AND p.removed_at IS NULL))))))
$$;
CREATE FUNCTION app_knowledge_visible(k uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_full_member() AND EXISTS (SELECT 1 FROM public.knowledge_items x WHERE x.id = k AND x.organization_id = app_org_id())
     AND app_knowledge_visible_for(k, app_membership_id())
$$;
REVOKE EXECUTE ON FUNCTION app_knowledge_visible_for(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_knowledge_visible(uuid) TO modus_app;

ALTER TABLE knowledge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_items_read ON knowledge_items FOR SELECT TO modus_app USING (organization_id = app_org_id() AND app_knowledge_visible(id));
CREATE POLICY knowledge_versions_read ON knowledge_versions FOR SELECT TO modus_app USING (organization_id = app_org_id() AND app_knowledge_visible(knowledge_id));
CREATE POLICY knowledge_sources_read ON knowledge_sources FOR SELECT TO modus_app USING (organization_id = app_org_id() AND app_knowledge_visible(knowledge_id));
CREATE POLICY knowledge_applications_read ON knowledge_applications FOR SELECT TO modus_app USING (organization_id = app_org_id() AND app_knowledge_visible(knowledge_id));
CREATE POLICY knowledge_transitions_read ON knowledge_transitions FOR SELECT TO modus_app USING (organization_id = app_org_id() AND app_knowledge_visible(knowledge_id));
-- Read only: every write goes through the functions below.
GRANT SELECT ON knowledge_items, knowledge_versions, knowledge_sources, knowledge_applications, knowledge_transitions TO modus_app;

-- ---------------------------------------------------------------------------
-- 4. Writes, each with its rights check and its history row
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_can_curate() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT app_full_member() AND (app_has_role(app_org_id(), 'archivist') OR app_has_role(app_org_id(), 'maintainer')
                                OR app_has_role(app_org_id(), 'decision_owner') OR app_has_role(app_org_id(), 'org_admin'))
$$;

-- Can the actor open this source? (a person may only cite what they can see)
CREATE FUNCTION app_source_visible(stype text, sid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE stype
    WHEN 'idea' THEN EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = sid AND i.organization_id = app_org_id()) AND app_idea_visible(sid)
    WHEN 'meeting' THEN app_meeting_participant(sid)
    WHEN 'finding' THEN EXISTS (SELECT 1 FROM public.protocol_candidates c JOIN public.meeting_protocols pr ON pr.id = c.protocol_id
                                  JOIN public.meeting_transcripts t ON t.id = pr.transcript_id
                                 WHERE c.id = sid AND app_meeting_participant(t.meeting_id))
    WHEN 'knowledge' THEN app_knowledge_visible(sid)
    ELSE false END
$$;

CREATE FUNCTION app_knowledge_register(kind text, title text, card jsonb, sources jsonb, reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k uuid;
  s jsonb;
BEGIN
  IF NOT app_can_curate() THEN
    RAISE EXCEPTION 'registering in the chronicle needs the archivist role or a lead role' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(sources) <> 'array' OR jsonb_array_length(sources) = 0 THEN
    RAISE EXCEPTION 'a chronicle entry needs at least one source' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.knowledge_items (organization_id, kind, title, created_by_membership_id)
  VALUES (app_org_id(), kind, title, app_membership_id()) RETURNING id INTO k;
  FOR s IN SELECT * FROM jsonb_array_elements(sources) LOOP
    IF NOT app_source_visible(s->>'type', (s->>'id')::uuid) THEN
      RAISE EXCEPTION 'a source is not visible to you' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.knowledge_sources (organization_id, knowledge_id, source_type, source_id, note, added_by_membership_id)
    VALUES (app_org_id(), k, s->>'type', (s->>'id')::uuid, s->>'note', app_membership_id()) ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO public.knowledge_versions (knowledge_id, version, organization_id, title, card, change_reason, author_membership_id)
  VALUES (k, 1, app_org_id(), title, card, coalesce(nullif(btrim(reason), ''), 'зарегистрировано в Летописи'), app_membership_id());
  INSERT INTO public.knowledge_transitions (organization_id, knowledge_id, action, to_level, to_status, version, reason, actor_membership_id)
  VALUES (app_org_id(), k, 'registered', 'chronicle', 'active', 1, reason, app_membership_id());
  RETURN k;
END $$;

CREATE FUNCTION app_knowledge_revise(k uuid, new_title text, card jsonb, reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  x record;
  v integer;
BEGIN
  SELECT * INTO x FROM public.knowledge_items WHERE id = k AND organization_id = app_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_knowledge_visible(k) OR NOT app_can_curate() THEN
    RAISE EXCEPTION 'not allowed to revise this knowledge' USING ERRCODE = '42501';
  END IF;
  -- The Higher Archive changes only through re-verification; a pending review is not edited under the reviewer.
  IF x.level = 'archive' AND x.status = 'active' THEN
    RAISE EXCEPTION 'archived knowledge is revised only after a re-verification request' USING ERRCODE = '23514';
  END IF;
  IF x.review <> 'none' THEN
    RAISE EXCEPTION 'a review is pending: decide it first' USING ERRCODE = '23514';
  END IF;
  v := x.current_version + 1;
  INSERT INTO public.knowledge_versions (knowledge_id, version, organization_id, title, card, change_reason, author_membership_id)
  VALUES (k, v, x.organization_id, new_title, card, reason, app_membership_id());
  UPDATE public.knowledge_items SET current_version = v, title = new_title, updated_at = clock_timestamp() WHERE id = k;
  INSERT INTO public.knowledge_transitions (organization_id, knowledge_id, action, from_level, to_level, from_status, to_status, version, reason, actor_membership_id)
  VALUES (x.organization_id, k, 'revised', x.level, x.level, x.status, x.status, v, reason, app_membership_id());
  RETURN v;
END $$;

CREATE FUNCTION app_knowledge_add_source(k uuid, stype text, sid uuid, note text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE x record;
BEGIN
  SELECT * INTO x FROM public.knowledge_items WHERE id = k AND organization_id = app_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_knowledge_visible(k) OR NOT app_can_curate() OR NOT app_source_visible(stype, sid) THEN
    RAISE EXCEPTION 'not allowed to add this source' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.knowledge_sources (organization_id, knowledge_id, source_type, source_id, note, added_by_membership_id)
  VALUES (x.organization_id, k, stype, sid, note, app_membership_id()) ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.knowledge_transitions (organization_id, knowledge_id, action, from_level, to_level, from_status, to_status, version, reason, actor_membership_id)
    VALUES (x.organization_id, k, 'source_added', x.level, x.level, x.status, x.status, x.current_version, stype || ': ' || coalesce(note, ''), app_membership_id());
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION app_knowledge_add_application(k uuid, idea uuid, note text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE x record;
BEGIN
  SELECT * INTO x FROM public.knowledge_items WHERE id = k AND organization_id = app_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_knowledge_visible(k) OR NOT app_can_curate() OR NOT app_source_visible('idea', idea) THEN
    RAISE EXCEPTION 'not allowed to record this application' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.knowledge_sources s WHERE s.knowledge_id = k AND s.source_type = 'idea' AND s.source_id = idea) THEN
    RAISE EXCEPTION 'the original item is not a re-application' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.knowledge_applications (organization_id, knowledge_id, idea_id, note, recorded_by_membership_id)
  VALUES (x.organization_id, k, idea, note, app_membership_id());
  INSERT INTO public.knowledge_transitions (organization_id, knowledge_id, action, from_level, to_level, from_status, to_status, version, reason, actor_membership_id)
  VALUES (x.organization_id, k, 'application_added', x.level, x.level, x.status, x.status, x.current_version, note, app_membership_id());
  RETURN true;
END $$;

-- Facts from the existing workflow, not new judgements:
--   implemented      — the implementation report was filed (workflow.completeImplementation → audit 'idea.implemented');
--   effect confirmed — the decision owner approved the effect (0007 effect_approvals).
CREATE FUNCTION app_idea_implemented(idea uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.audit_events a WHERE a.entity_id = idea AND a.action = 'idea.implemented')
$$;
CREATE FUNCTION app_idea_effect_confirmed(idea uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.effect_approvals e WHERE e.idea_id = idea)
$$;
GRANT EXECUTE ON FUNCTION app_idea_implemented(uuid), app_idea_effect_confirmed(uuid) TO modus_app;

-- All level and status changes. Rules:
--   library_proposed : curator; card has problem, decision and reasons
--   library_accepted : archivist, not the proposer (human check of provenance and classification)
--   archive_proposed : archivist — the conclusion: proof, applicability, last check, grounds and category;
--                      a method / repeated success needs ≥ 1 implemented re-application on another item,
--                      an improvement needs the effect of its source item confirmed, a lesson needs the negative experience
--   archive_approved : decision owner or admin, not the author of the conclusion
--   reverify_requested / outdated : curator or approver, with a reason; history is never deleted
--   reconfirmed      : archivist for the library; the archive needs a new conclusion and approval
--   opened_to_organization : approver, with a reason (attests that no closed-meeting content is inside)
CREATE FUNCTION app_knowledge_act(k uuid, act text, reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  x record;
  c jsonb;
  me uuid := app_membership_id();
  last_actor uuid;
  new_level text;
  new_status text;
  new_review text;
BEGIN
  SELECT * INTO x FROM public.knowledge_items WHERE id = k AND organization_id = app_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT app_knowledge_visible(k) THEN
    RAISE EXCEPTION 'knowledge not found' USING ERRCODE = '42501';
  END IF;
  SELECT card INTO c FROM public.knowledge_versions WHERE knowledge_id = k AND version = x.current_version;
  new_level := x.level; new_status := x.status; new_review := x.review;
  IF act IN ('library_proposed', 'archive_proposed', 'reverify_requested', 'outdated', 'opened_to_organization', 'library_rejected', 'archive_rejected')
     AND (reason IS NULL OR length(btrim(reason)) < 5) THEN
    RAISE EXCEPTION 'say why (at least 5 characters)' USING ERRCODE = '23514';
  END IF;

  IF act = 'library_proposed' THEN
    IF NOT app_can_curate() THEN RAISE EXCEPTION 'no right to propose' USING ERRCODE = '42501'; END IF;
    IF x.level <> 'chronicle' OR x.review <> 'none' OR x.status = 'outdated' THEN RAISE EXCEPTION 'only an active chronicle entry is proposed to the library' USING ERRCODE = '23514'; END IF;
    IF coalesce(length(btrim(c->>'problem')), 0) < 10 OR coalesce(length(btrim(c->>'decision')), 0) < 10 OR coalesce(length(btrim(c->>'reasons')), 0) < 10 THEN
      RAISE EXCEPTION 'the card needs the problem, the decision and the reasons' USING ERRCODE = '23514';
    END IF;
    new_review := 'library_proposed';
  ELSIF act IN ('library_accepted', 'library_rejected') THEN
    IF NOT app_is_archivist() THEN RAISE EXCEPTION 'the archivist checks entries for the library' USING ERRCODE = '42501'; END IF;
    IF x.review <> 'library_proposed' THEN RAISE EXCEPTION 'nothing proposed' USING ERRCODE = '23514'; END IF;
    SELECT actor_membership_id INTO last_actor FROM public.knowledge_transitions WHERE knowledge_id = k AND action = 'library_proposed' ORDER BY created_at DESC LIMIT 1;
    IF act = 'library_accepted' AND last_actor = me THEN RAISE EXCEPTION 'the proposer does not accept their own proposal' USING ERRCODE = '42501'; END IF;
    new_review := 'none';
    IF act = 'library_accepted' THEN new_level := 'library'; END IF;
  ELSIF act = 'archive_proposed' THEN
    IF NOT app_is_archivist() THEN RAISE EXCEPTION 'the archivist prepares the conclusion' USING ERRCODE = '42501'; END IF;
    IF NOT (x.level = 'library' OR (x.level = 'archive' AND x.status = 'needs_review')) OR x.review <> 'none' OR x.status = 'outdated' THEN
      RAISE EXCEPTION 'only verified library knowledge goes to the Higher Archive' USING ERRCODE = '23514';
    END IF;
    IF coalesce(length(btrim(c->>'proof')), 0) < 10 OR coalesce(length(btrim(c->>'applicability')), 0) < 10
       OR coalesce(length(btrim(c->>'basis')), 0) < 10 OR (c->>'lastChecked') IS NULL
       OR coalesce(c->>'archiveCategory', '') NOT IN ('method', 'improvement', 'reapplied', 'discovery', 'lesson', 'history') THEN
      RAISE EXCEPTION 'the conclusion needs proof, applicability, the date of the last check, grounds and a category' USING ERRCODE = '23514';
    END IF;
    IF c->>'archiveCategory' IN ('method', 'reapplied') AND NOT EXISTS (
         SELECT 1 FROM public.knowledge_applications a WHERE a.knowledge_id = k AND app_idea_implemented(a.idea_id)) THEN
      RAISE EXCEPTION 'a method needs at least one confirmed re-application on another item' USING ERRCODE = '23514';
    END IF;
    IF c->>'archiveCategory' = 'improvement' AND NOT EXISTS (
         SELECT 1 FROM public.knowledge_sources s WHERE s.knowledge_id = k AND s.source_type = 'idea' AND app_idea_effect_confirmed(s.source_id)) THEN
      RAISE EXCEPTION 'an improvement needs the effect of its item confirmed' USING ERRCODE = '23514';
    END IF;
    IF c->>'archiveCategory' = 'lesson' AND coalesce(length(btrim(c->>'negative')), 0) < 10 THEN
      RAISE EXCEPTION 'a lesson needs the negative experience described' USING ERRCODE = '23514';
    END IF;
    new_review := 'archive_proposed';
  ELSIF act IN ('archive_approved', 'archive_rejected') THEN
    IF NOT app_is_approver() THEN RAISE EXCEPTION 'inclusion into the Higher Archive is approved by a decision owner or an admin' USING ERRCODE = '42501'; END IF;
    IF x.review <> 'archive_proposed' THEN RAISE EXCEPTION 'no conclusion to decide' USING ERRCODE = '23514'; END IF;
    SELECT actor_membership_id INTO last_actor FROM public.knowledge_transitions WHERE knowledge_id = k AND action = 'archive_proposed' ORDER BY created_at DESC LIMIT 1;
    IF last_actor = me THEN RAISE EXCEPTION 'the author of the conclusion does not approve it' USING ERRCODE = '42501'; END IF;
    new_review := 'none';
    IF act = 'archive_approved' THEN
      new_level := 'archive'; new_status := 'active';
      UPDATE public.knowledge_items SET last_verified_at = clock_timestamp() WHERE id = k;
    END IF;
  ELSIF act IN ('reverify_requested', 'outdated') THEN
    IF NOT (app_can_curate() OR app_is_approver()) THEN RAISE EXCEPTION 'no right to change the status' USING ERRCODE = '42501'; END IF;
    IF x.review <> 'none' THEN RAISE EXCEPTION 'a review is pending: decide it first' USING ERRCODE = '23514'; END IF;
    new_status := CASE act WHEN 'outdated' THEN 'outdated' ELSE 'needs_review' END;
  ELSIF act = 'reconfirmed' THEN
    IF NOT app_is_archivist() THEN RAISE EXCEPTION 'the archivist reconfirms' USING ERRCODE = '42501'; END IF;
    IF x.status <> 'needs_review' OR x.level = 'archive' THEN RAISE EXCEPTION 'the Higher Archive is reconfirmed through a new conclusion and approval' USING ERRCODE = '23514'; END IF;
    new_status := 'active';
    UPDATE public.knowledge_items SET last_verified_at = clock_timestamp() WHERE id = k;
  ELSIF act = 'opened_to_organization' THEN
    IF NOT app_is_approver() THEN RAISE EXCEPTION 'an approver opens knowledge to the organization' USING ERRCODE = '42501'; END IF;
    UPDATE public.knowledge_items SET visibility = 'organization' WHERE id = k;
  ELSE
    RAISE EXCEPTION 'unknown action' USING ERRCODE = '23514';
  END IF;

  UPDATE public.knowledge_items SET level = new_level, status = new_status, review = new_review, updated_at = clock_timestamp() WHERE id = k;
  INSERT INTO public.knowledge_transitions (organization_id, knowledge_id, action, from_level, to_level, from_status, to_status, version, reason, actor_membership_id)
  VALUES (x.organization_id, k, act, x.level, new_level, x.status, new_status, x.current_version, reason, me);
  RETURN new_level;
END $$;

REVOKE EXECUTE ON FUNCTION app_knowledge_register(text, text, jsonb, jsonb, text), app_knowledge_revise(uuid, text, jsonb, text),
  app_knowledge_add_source(uuid, text, uuid, text), app_knowledge_add_application(uuid, uuid, text), app_knowledge_act(uuid, text, text),
  app_can_curate(), app_source_visible(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_knowledge_register(text, text, jsonb, jsonb, text), app_knowledge_revise(uuid, text, jsonb, text),
  app_knowledge_add_source(uuid, text, uuid, text), app_knowledge_add_application(uuid, uuid, text), app_knowledge_act(uuid, text, text),
  app_can_curate(), app_source_visible(text, uuid) TO modus_app;

-- ---------------------------------------------------------------------------
-- 5. Royal messages about knowledge, proven by the transition and visible to the recipient
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN knowledge_id uuid REFERENCES knowledge_items(id);
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
   'knowledge_submitted','knowledge_in_library','knowledge_archived','knowledge_reverify'));

CREATE FUNCTION app_notify_knowledge(event text, k uuid, recipients uuid[], dedupe text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := app_membership_id();
  n integer;
  proven boolean;
BEGIN
  IF NOT app_actor_ok() OR NOT app_knowledge_visible(k) THEN
    RAISE EXCEPTION 'notification not allowed' USING ERRCODE = '42501';
  END IF;
  proven := EXISTS (SELECT 1 FROM public.knowledge_transitions t WHERE t.knowledge_id = k AND t.actor_membership_id = actor
                      AND t.action = CASE event WHEN 'knowledge_submitted' THEN 'archive_proposed'
                                                WHEN 'knowledge_in_library' THEN 'library_accepted'
                                                WHEN 'knowledge_archived' THEN 'archive_approved'
                                                WHEN 'knowledge_reverify' THEN 'reverify_requested' END);
  IF NOT proven THEN
    RAISE EXCEPTION 'notification is not backed by a knowledge record' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, knowledge_id, dedupe_key)
  SELECT app_org_id(), m.id, actor, event, k, event || ':' || dedupe
    FROM public.memberships m
   WHERE m.id = ANY (recipients) AND m.id <> actor AND m.organization_id = app_org_id()
     AND app_knowledge_visible_for(k, m.id)
     AND app_notification_enabled(m.id, event, NULL)
  ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_notify_knowledge(text, uuid, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_knowledge(text, uuid, uuid[], text) TO modus_app;

CREATE INDEX knowledge_versions_search ON knowledge_versions USING gin (to_tsvector('russian', title || ' ' || card::text));
