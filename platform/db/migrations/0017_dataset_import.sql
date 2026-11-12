-- MODUS FLOW · 0017 · Import of an external data set into its own namespace (owner brief 2026-11-11, ADR-0022).
--
-- The organizer's official synthetic set (A-001—A-020) is loaded through the real services: every row
-- becomes an ordinary item with its own history. This table is only the namespace: it remembers which
-- item came from which row and keeps the row's ORIGINAL type, category, priority and conditional status,
-- so they are shown as they were given and never silently replaced by the product's own statuses.
-- Re-import is idempotent: (organization, dataset, external_id) is the key.
-- No XP is ever written here. `demo_confirmed_at` only marks rows whose implementation was confirmed
-- through the real workflow by an explicitly requested DEMO confirmation (the label shown in the UI).
-- Additive only: one new table, read policy, two SECURITY DEFINER functions for the organization admin.

CREATE TABLE dataset_items (
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  dataset           text NOT NULL CHECK (dataset ~ '^[a-z0-9-]{2,60}$'),
  external_id       text NOT NULL CHECK (external_id ~ '^[A-Z]{1,3}-[0-9]{1,6}$'),
  idea_id           uuid NOT NULL UNIQUE REFERENCES ideas(id),
  original_type     text NOT NULL CHECK (length(original_type) BETWEEN 1 AND 80),
  original_category text NOT NULL CHECK (length(original_category) BETWEEN 1 AND 120),
  original_priority text NOT NULL CHECK (length(original_priority) BETWEEN 1 AND 40),
  original_status   text NOT NULL CHECK (length(original_status) BETWEEN 1 AND 60),
  original_author   text NOT NULL CHECK (length(original_author) BETWEEN 1 AND 120),
  original_owner    text NOT NULL CHECK (length(original_owner) BETWEEN 1 AND 120),
  original_next     text CHECK (original_next IS NULL OR length(original_next) <= 1000),
  routed_by         text NOT NULL CHECK (routed_by IN ('category_rule', 'fallback')),
  demo_confirmed_at timestamptz,
  imported_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset, external_id)
);
ALTER TABLE dataset_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY dataset_items_read ON dataset_items FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
GRANT SELECT ON dataset_items TO modus_app;

-- Register one imported row. Returns false when the row is already registered (idempotent re-import).
CREATE FUNCTION app_register_dataset_item(
  p_dataset text, p_external_id text, p_idea uuid, p_type text, p_category text, p_priority text, p_status text,
  p_author text, p_owner text, p_next text, p_routed_by text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE org uuid := public.app_org_id();
BEGIN
  IF NOT (public.app_actor_ok() AND public.app_full_member() AND public.app_has_role(org, 'org_admin')) THEN
    RAISE EXCEPTION 'dataset import: organization admin only' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = p_idea AND i.organization_id = org) THEN
    RAISE EXCEPTION 'dataset import: item of another organization' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.dataset_items (organization_id, dataset, external_id, idea_id, original_type, original_category,
      original_priority, original_status, original_author, original_owner, original_next, routed_by)
    VALUES (org, p_dataset, p_external_id, p_idea, p_type, p_category, p_priority, p_status, p_author, p_owner, nullif(p_next, ''), p_routed_by)
    ON CONFLICT (organization_id, dataset, external_id) DO NOTHING;
  RETURN FOUND;
END $$;

-- Mark a row as confirmed by the explicit demo confirmation. The XP itself comes only from the real
-- workflow trigger (0007) when the implementation is confirmed; this function writes no XP.
CREATE FUNCTION app_mark_dataset_demo_confirmed(p_dataset text, p_external_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE org uuid := public.app_org_id();
BEGIN
  IF NOT (public.app_actor_ok() AND public.app_full_member() AND public.app_has_role(org, 'org_admin')) THEN
    RAISE EXCEPTION 'dataset import: organization admin only' USING ERRCODE = '42501';
  END IF;
  UPDATE public.dataset_items SET demo_confirmed_at = clock_timestamp()
    WHERE organization_id = org AND dataset = p_dataset AND external_id = p_external_id AND demo_confirmed_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app_register_dataset_item(text, text, uuid, text, text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_mark_dataset_demo_confirmed(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_register_dataset_item(text, text, uuid, text, text, text, text, text, text, text, text) TO modus_app;
GRANT EXECUTE ON FUNCTION app_mark_dataset_demo_confirmed(text, text) TO modus_app;
