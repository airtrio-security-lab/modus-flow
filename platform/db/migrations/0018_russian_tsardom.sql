-- MODUS FLOW · 0018 · Русское царство (Moscow, XVI–XVII c.) as a fifth district style.
-- Additive: does not alter existing style selections, XP, rights, decisions, or tenant boundaries.
-- Existing Mongolian districts and all historical audit values remain unchanged.
ALTER TABLE public.departments DROP CONSTRAINT departments_civilization_check;
ALTER TABLE public.departments ADD CONSTRAINT departments_civilization_check
  CHECK (civilization IN ('camelot','japan','mongolia','kazakh','russia'));

CREATE OR REPLACE FUNCTION app_set_civilization(dept uuid, civ text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  d record;
BEGIN
  SELECT * INTO d FROM public.departments
    WHERE id = dept AND organization_id = app_org_id() AND active FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'department not found' USING ERRCODE = '42501';
  END IF;
  IF NOT app_full_member()
     OR NOT (coalesce(d.head_membership_id = app_membership_id(), false)
             OR app_has_role(app_org_id(), 'org_admin')) THEN
    RAISE EXCEPTION 'only the head of the department or an admin chooses its style'
      USING ERRCODE = '42501';
  END IF;
  IF civ IS NULL OR civ NOT IN ('camelot','japan','mongolia','kazakh','russia') THEN
    RAISE EXCEPTION 'unknown civilization' USING ERRCODE = '23514';
  END IF;
  IF d.civilization = civ THEN RETURN civ; END IF;
  UPDATE public.departments SET civilization = civ WHERE id = dept;
  INSERT INTO public.audit_events
    (organization_id, actor_user_id, action, entity_type, entity_id, data)
  VALUES (app_org_id(), app_user_id(), 'castle.civilization_changed', 'department',
          dept, jsonb_build_object('from', d.civilization, 'to', civ));
  RETURN civ;
END $$;

-- The existing function EXECUTE ACL, owned by the same function signature, remains in effect.
