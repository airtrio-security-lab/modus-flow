-- MODUS FLOW · 0021 · «Проблема решена» — подтверждает автор (решение владельца 2026-11-13, ADR-0035).
--
-- Closes the open question of ADR-0032 with a NARROW, verifiable criterion:
--   * only an item of kind «problem»;
--   * only after the implementation was confirmed (the castle's implementation award exists — the same
--     confirmed event that already brought +20), so a rejected, closed or withdrawn item never qualifies;
--   * confirmed by the person whose question it is (raised_by, else the author): the one who had the
--     problem says it is gone; nobody else can say it for them;
--   * once per item; append-only; +envoy_xp_resolution (5) to that same person, through the single
--     write path app_envoy_grant. Nothing else changes: no stage, no castle XP, no rights.

CREATE TABLE problem_resolutions (
  idea_id                   uuid PRIMARY KEY,
  organization_id           uuid NOT NULL REFERENCES organizations(id),
  confirmed_by_membership_id uuid NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, confirmed_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER problem_resolutions_append_only BEFORE UPDATE OR DELETE ON problem_resolutions FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE problem_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY problem_resolutions_read ON problem_resolutions FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
CREATE POLICY problem_resolutions_insert ON problem_resolutions FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND confirmed_by_membership_id = app_membership_id() AND app_actor_ok()
              AND app_idea_visible(idea_id));
GRANT SELECT, INSERT ON problem_resolutions TO modus_app;

CREATE FUNCTION app_problem_resolution_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i record;
BEGIN
  SELECT * INTO i FROM public.ideas x WHERE x.id = NEW.idea_id AND x.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'idea not found' USING ERRCODE = '42501';
  END IF;
  IF i.kind <> 'problem' THEN
    RAISE EXCEPTION 'only a problem is confirmed as resolved' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.xp_awards a WHERE a.idea_id = i.id AND a.kind = 'implementation') THEN
    RAISE EXCEPTION 'a problem is confirmed as resolved only after a confirmed implementation' USING ERRCODE = '23514';
  END IF;
  IF NEW.confirmed_by_membership_id IS DISTINCT FROM coalesce(i.raised_by_membership_id, i.author_membership_id) THEN
    RAISE EXCEPTION 'only the person whose question it is confirms that the problem is resolved' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER problem_resolutions_rules BEFORE INSERT ON problem_resolutions FOR EACH ROW EXECUTE FUNCTION app_problem_resolution_rules();

-- The ledger accepts the new basis.
ALTER TABLE envoy_xp_awards DROP CONSTRAINT envoy_xp_awards_source_type_check;
ALTER TABLE envoy_xp_awards ADD CONSTRAINT envoy_xp_awards_source_type_check
  CHECK (source_type IN ('xp_award', 'effect_approval', 'problem_resolution'));

-- The single write path, now pricing «resolution» too (otherwise unchanged from 0020).
CREATE OR REPLACE FUNCTION app_envoy_grant(p_idea uuid, p_kind text, p_source_type text, p_source_id uuid, p_proof uuid,
                                           p_at timestamptz, p_live boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i record;
  o record;
  who uuid;
  pts integer;
  total integer;
  r_before integer;
  r_after integer;
  award uuid;
  at timestamptz := coalesce(p_at, clock_timestamp());
  actor uuid;
BEGIN
  SELECT * INTO i FROM public.ideas x WHERE x.id = p_idea;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  who := coalesce(i.raised_by_membership_id, i.author_membership_id);
  SELECT * INTO o FROM public.organizations x WHERE x.id = i.organization_id;
  pts := CASE p_kind
           WHEN 'implementation' THEN o.envoy_xp_implementation
           WHEN 'effect' THEN o.envoy_xp_effect
           WHEN 'resolution' THEN o.envoy_xp_resolution
           ELSE 0 END;
  IF coalesce(pts, 0) <= 0 THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('envoy:' || who::text, 0));
  INSERT INTO public.envoy_xp_awards (organization_id, membership_id, idea_id, event_kind, xp, source_type, source_id, proof_id, created_at)
  VALUES (i.organization_id, who, i.id, p_kind, pts, p_source_type, p_source_id, p_proof, at)
  ON CONFLICT (idea_id, event_kind) DO NOTHING
  RETURNING id INTO award;
  IF award IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(a.xp), 0)::int INTO total FROM public.envoy_xp_awards a
   WHERE a.organization_id = i.organization_id AND a.membership_id = who;
  r_before := app_envoy_rank(total - pts, o.envoy_rank_thresholds);
  r_after := app_envoy_rank(total, o.envoy_rank_thresholds);
  FOR r IN r_before + 1 .. r_after LOOP
    INSERT INTO public.envoy_rank_ups (organization_id, membership_id, rank, xp, award_id, idea_id, created_at)
    VALUES (i.organization_id, who, r, total, award, i.id, at)
    ON CONFLICT (membership_id, rank) DO NOTHING;
  END LOOP;
  IF NOT p_live THEN
    RETURN award;
  END IF;
  IF app_user_id() IS NOT NULL THEN
    INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
    VALUES (i.organization_id, app_user_id(), 'envoy.xp_awarded', 'idea', i.id,
            jsonb_build_object('award', award, 'kind', p_kind, 'xp', pts, 'idea', i.number, 'recipient', who));
    IF r_after > r_before THEN
      INSERT INTO public.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
      VALUES (i.organization_id, app_user_id(), 'envoy.rank_up', 'membership', who,
              jsonb_build_object('rank', r_after, 'xp', total, 'idea', i.number, 'award', award));
    END IF;
  END IF;
  IF r_after > r_before THEN
    actor := app_membership_id();
    INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
    SELECT i.organization_id, m.id, NULL, 'envoy_rank_up', i.id, 'envoy_rank_up:' || r_after
      FROM public.memberships m
     WHERE m.id = who AND m.organization_id = i.organization_id AND m.status = 'active'
       AND (actor IS NULL OR app_notification_enabled(m.id, 'envoy_rank_up', i.id))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN award;
END $$;
REVOKE ALL ON FUNCTION app_envoy_grant(uuid, text, text, uuid, uuid, timestamptz, boolean) FROM PUBLIC;

CREATE FUNCTION app_envoy_on_resolution() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM app_envoy_grant(NEW.idea_id, 'resolution', 'problem_resolution', NEW.idea_id, NULL, NULL, true);
  RETURN NULL;
END $$;
CREATE TRIGGER problem_resolutions_envoy AFTER INSERT ON problem_resolutions FOR EACH ROW EXECUTE FUNCTION app_envoy_on_resolution();
REVOKE ALL ON FUNCTION app_envoy_on_resolution() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_problem_resolution_rules() FROM PUBLIC;
