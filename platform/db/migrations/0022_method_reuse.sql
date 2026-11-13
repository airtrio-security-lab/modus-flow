-- MODUS FLOW · 0022 · «Применить этот метод» (ADR-0040).
--
-- A person finds a verified method in the Great Library and starts an ORDINARY item from it. This
-- migration keeps one fact and nothing more: «this item was started on the basis of that knowledge».
--
--   * It is an intention, not a result. The existing `knowledge_applications` (0012) stays the only
--     record of a re-application, written by a curator and confirmed only when the item is implemented.
--     Nothing here counts as an application, raises a level, or satisfies the archive's rule
--     «a method needs at least one confirmed re-application».
--   * No experience: neither castle XP nor envoy XP is granted for starting from a method.
--   * No new right: the item goes through the same intake, routing and decision rules as any other.
--   * Only the author of the item links it, only to knowledge they can open, only to knowledge that
--     has passed the archivist's check (Library or Higher Archive) and is not outdated. Once per item.
--   * Append-only. Read only by those who can open BOTH the item and the knowledge: the link never
--     reveals the title of a source its reader may not see.

CREATE TABLE idea_method_links (
  idea_id                  uuid PRIMARY KEY,
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  knowledge_id             uuid NOT NULL,
  -- The version of the card the person was reading when they started.
  knowledge_version        integer NOT NULL CHECK (knowledge_version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, knowledge_id) REFERENCES knowledge_items(organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE INDEX idea_method_links_knowledge ON idea_method_links (knowledge_id, created_at);

CREATE TRIGGER idea_method_links_append_only BEFORE UPDATE OR DELETE ON idea_method_links FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE idea_method_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY idea_method_links_read ON idea_method_links FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id) AND app_knowledge_visible(knowledge_id));
-- Read only: the single write path is the function below.
GRANT SELECT ON idea_method_links TO modus_app;

CREATE FUNCTION app_idea_link_method(idea uuid, k uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i record;
  x record;
BEGIN
  IF NOT app_actor_ok() THEN
    RAISE EXCEPTION 'not allowed to start from this method' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO i FROM public.ideas WHERE id = idea AND organization_id = app_org_id();
  IF NOT FOUND OR i.author_membership_id <> app_membership_id() THEN
    RAISE EXCEPTION 'only the author starts their item from a method' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO x FROM public.knowledge_items WHERE id = k AND organization_id = app_org_id();
  IF NOT FOUND OR NOT app_knowledge_visible(k) THEN
    RAISE EXCEPTION 'not allowed to start from this method' USING ERRCODE = '42501';
  END IF;
  IF x.level = 'chronicle' OR x.status = 'outdated' THEN
    RAISE EXCEPTION 'only verified knowledge that is not outdated is applied' USING ERRCODE = '23514';
  END IF;
  -- The item the knowledge itself rests on is its source, not a new use of it.
  IF EXISTS (SELECT 1 FROM public.knowledge_sources s WHERE s.knowledge_id = k AND s.source_type = 'idea' AND s.source_id = idea) THEN
    RAISE EXCEPTION 'the original item is not a re-application' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.idea_method_links l WHERE l.idea_id = idea) THEN
    RAISE EXCEPTION 'the item is already started from a method' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.idea_method_links (idea_id, organization_id, knowledge_id, knowledge_version, created_by_membership_id)
  VALUES (idea, i.organization_id, k, x.current_version, app_membership_id());
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION app_idea_link_method(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_idea_link_method(uuid, uuid) TO modus_app;
