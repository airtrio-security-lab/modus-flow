-- MODUS FLOW · 0014 · «Живое Королевство»: the city of departments (owner brief 2026-11-11, ADR-0019).
--
-- Only one new fact is stored: the architectural style («цивилизация») a department chose for
-- its district. Everything else on the city screen is computed from existing tables. The style is
-- a picture: it changes no XP, no level, no role and no right. Every change is logged.

ALTER TABLE departments ADD COLUMN civilization text NOT NULL DEFAULT 'europe'
  CHECK (civilization IN ('europe', 'japan', 'mongolia', 'kazakh'));

-- The head of the department or an organization admin chooses; the change goes to the audit log.
CREATE FUNCTION app_set_civilization(dept uuid, civ text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d record;
BEGIN
  SELECT * INTO d FROM public.departments WHERE id = dept AND organization_id = app_org_id() AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'department not found' USING ERRCODE = '42501'; END IF;
  IF NOT app_full_member() OR NOT (coalesce(d.head_membership_id = app_membership_id(), false) OR app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only the head of the department or an admin chooses its style' USING ERRCODE = '42501';
  END IF;
  IF civ IS NULL OR civ NOT IN ('europe', 'japan', 'mongolia', 'kazakh') THEN
    RAISE EXCEPTION 'unknown civilization' USING ERRCODE = '23514';
  END IF;
  IF d.civilization = civ THEN RETURN civ; END IF;
  UPDATE public.departments SET civilization = civ WHERE id = dept;
  INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (app_org_id(), app_user_id(), 'castle.civilization_changed', 'department', dept, jsonb_build_object('from', d.civilization, 'to', civ));
  RETURN civ;
END $$;
REVOKE EXECUTE ON FUNCTION app_set_civilization(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_civilization(uuid, text) TO modus_app;

-- The history of a district's style, readable by every full member (no content beyond the styles).
CREATE FUNCTION app_civilization_history(dept uuid) RETURNS TABLE (at timestamptz, from_civ text, to_civ text, actor text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.created_at, a.data->>'from', a.data->>'to', u.display_name
    FROM public.audit_events a LEFT JOIN public.users u ON u.id = a.actor_user_id
   WHERE app_full_member() AND a.organization_id = app_org_id() AND a.entity_id = dept AND a.action = 'castle.civilization_changed'
   ORDER BY a.created_at DESC
$$;
REVOKE EXECUTE ON FUNCTION app_civilization_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_civilization_history(uuid) TO modus_app;
