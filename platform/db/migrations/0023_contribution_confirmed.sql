-- MODUS FLOW · 0023 · «Ваш вклад признан» — подтверждение вклада (решение владельца 2026-11-13, ADR-0042).
--
-- The schema has carried a confirmed state for contributions since 0001 (recorded → confirmed, by the
-- item's maintainer or decision owner, never by the contributor — RLS + CHECK), and the event
-- `contribution_confirmed` has been allowed since 0001, but nothing ever confirmed a contribution or
-- told the person. This migration adds the two missing rules and the one write path for the message:
--   * authorship is a fact of registration, not something a lead «recognises»: it is never confirmed;
--   * a verification owner's contribution is confirmed only after that verification is completed
--     (the row is written when the run starts, before any work is done);
--   * the confirmation time is the database's;
--   * `app_notify_contribution` tells the contributor, proven by the confirmed row itself.
-- Nothing else changes: no XP (castles still grow only from implemented items), no stage, no rights.
-- Additive only: one trigger function + trigger, one SECURITY DEFINER function.

CREATE FUNCTION app_contribution_confirm_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
    IF OLD.kind = 'authorship' THEN
      RAISE EXCEPTION 'authorship is a fact of registration and is not confirmed' USING ERRCODE = '23514';
    END IF;
    IF OLD.source_type = 'verification' AND NOT EXISTS (
         SELECT 1 FROM public.verifications v WHERE v.id = OLD.source_id AND v.status = 'completed') THEN
      RAISE EXCEPTION 'a verification contribution is confirmed only after the verification is completed' USING ERRCODE = '23514';
    END IF;
    NEW.confirmed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contributions_confirm_rules BEFORE UPDATE ON contributions
  FOR EACH ROW EXECUTE FUNCTION app_contribution_confirm_rules();

-- «Вклад подтверждён»: to the contributor only, once per contribution, sent by the person who
-- confirmed it. The row proves the event: it must be confirmed, and by the caller.
CREATE FUNCTION app_notify_contribution(p_contribution uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k record;
  n integer;
BEGIN
  SELECT x.*, i.maintainer_membership_id, i.decision_owner_membership_id
    INTO k FROM public.contributions x JOIN public.ideas i ON i.id = x.idea_id
   WHERE x.id = p_contribution AND x.organization_id = app_org_id();
  IF NOT FOUND OR NOT app_actor_ok() OR k.status <> 'confirmed'
     OR k.confirmed_by_membership_id IS DISTINCT FROM app_membership_id() THEN
    RAISE EXCEPTION 'notification is not backed by a confirmed contribution' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
  SELECT app_org_id(), m.id, k.confirmed_by_membership_id, 'contribution_confirmed', k.idea_id, 'contribution_confirmed:' || p_contribution
    FROM public.memberships m
   WHERE m.id = k.membership_id AND m.id <> k.confirmed_by_membership_id
     AND m.organization_id = app_org_id() AND m.status = 'active'
     -- an invited guest reads only items they lead (ADR-0007)
     AND (m.access = 'member' OR m.id IN (k.maintainer_membership_id, k.decision_owner_membership_id))
     AND app_notification_enabled(m.id, 'contribution_confirmed', k.idea_id)
  ON CONFLICT (recipient_membership_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION app_notify_contribution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify_contribution(uuid) TO modus_app;
