-- MODUS FLOW · 0020 · «Путь Посла» (ADR-0032): personal envoy XP, seven ranks, rank-up events.
--
-- Rules kept here, in the database:
--   * A separate append-only ledger. The castle ledger (xp_awards) is only READ by the triggers below,
--     never written: personal XP and castle XP are two sums of one confirmed fact.
--   * Written only by SECURITY DEFINER triggers on confirmed events; the app role has no INSERT.
--     Nothing for submitting, arriving at an audience, the King's acceptance, comments, rejection or closing.
--   * (idea_id, event_kind) is unique: one item brings each kind of award once, to one person — the one
--     whose question it is (raised_by, else the author). Retries and parallel transactions add nothing.
--   * Awards to one person are serialized by an advisory lock, so a threshold crossing is never lost.
--   * The rank is computed from the ledger; a rank-up is a recorded, unique event. A rank grants nothing.

-- ---------------------------------------------------------------------------
-- 1. Configuration per organization (starting values from the owner brief)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_envoy_thresholds_ok(t integer[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_length(t, 1) = 7 AND t[1] = 0
                  AND (SELECT bool_and(t[k] > t[k - 1]) FROM generate_series(2, 7) k), false)
$$;

ALTER TABLE organizations
  -- «Проблема подтверждённо решена»: the value is kept, but nothing writes it yet (ADR-0032, open question).
  ADD COLUMN envoy_xp_resolution integer NOT NULL DEFAULT 5 CHECK (envoy_xp_resolution BETWEEN 0 AND 1000),
  ADD COLUMN envoy_xp_implementation integer NOT NULL DEFAULT 20 CHECK (envoy_xp_implementation BETWEEN 0 AND 1000),
  ADD COLUMN envoy_xp_effect integer NOT NULL DEFAULT 30 CHECK (envoy_xp_effect BETWEEN 0 AND 1000),
  ADD COLUMN envoy_rank_thresholds integer[] NOT NULL DEFAULT '{0,20,60,140,280,500,800}'
    CHECK (app_envoy_thresholds_ok(envoy_rank_thresholds));
GRANT SELECT (envoy_xp_resolution, envoy_xp_implementation, envoy_xp_effect, envoy_rank_thresholds) ON organizations TO modus_app;

CREATE FUNCTION app_envoy_rank(xp integer, t integer[]) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT greatest(1, (SELECT count(*)::int FROM unnest(t) v WHERE v <= xp))
$$;

-- ---------------------------------------------------------------------------
-- 2. The personal ledger and the rank-up events
-- ---------------------------------------------------------------------------
CREATE TABLE envoy_xp_awards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  membership_id   uuid NOT NULL,
  idea_id         uuid NOT NULL,
  event_kind      text NOT NULL CHECK (event_kind IN ('resolution', 'implementation', 'effect')),
  xp              integer NOT NULL CHECK (xp BETWEEN 1 AND 1000),
  -- What proves it: the castle's implementation award, or the decision owner's effect approval.
  source_type     text NOT NULL CHECK (source_type IN ('xp_award', 'effect_approval')),
  source_id       uuid NOT NULL,
  -- For an effect: the completed verification whose measurement shows the improvement.
  proof_id        uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (idea_id, event_kind),
  CHECK ((event_kind = 'effect') = (proof_id IS NOT NULL)),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id)
);
CREATE INDEX envoy_xp_awards_member ON envoy_xp_awards (organization_id, membership_id, created_at);
CREATE TRIGGER envoy_xp_awards_append_only BEFORE UPDATE OR DELETE ON envoy_xp_awards FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE envoy_xp_awards ENABLE ROW LEVEL SECURITY;
-- One's own envoy always; colleagues' envoys to full members, as the person card (guests see only their own).
CREATE POLICY envoy_xp_awards_read ON envoy_xp_awards FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND (membership_id = app_membership_id() OR app_full_member()));
GRANT SELECT ON envoy_xp_awards TO modus_app;

CREATE TABLE envoy_rank_ups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  membership_id   uuid NOT NULL,
  rank            integer NOT NULL CHECK (rank BETWEEN 2 AND 7),
  xp              integer NOT NULL CHECK (xp >= 0),
  award_id        uuid NOT NULL REFERENCES envoy_xp_awards(id),
  idea_id         uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (membership_id, rank),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id)
);
CREATE TRIGGER envoy_rank_ups_append_only BEFORE UPDATE OR DELETE ON envoy_rank_ups FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE envoy_rank_ups ENABLE ROW LEVEL SECURITY;
CREATE POLICY envoy_rank_ups_read ON envoy_rank_ups FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND (membership_id = app_membership_id() OR app_full_member()));
GRANT SELECT ON envoy_rank_ups TO modus_app;

-- ---------------------------------------------------------------------------
-- 3. Notifications: «Ваш посол достиг нового ранга»
-- ---------------------------------------------------------------------------
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
   'knowledge_submitted','knowledge_in_library','knowledge_archived','knowledge_reverify',
   'council_escalated','idea_deferred','envoy_rank_up'));

-- ---------------------------------------------------------------------------
-- 4. «Измеримый положительный эффект»: the same strict rule as platform/domain/effect.ts.
--    Evidence of completed verifications only. Per metric: the latest «before», the latest «after»
--    not earlier than it, from an «impact» verification, the same unit, conditions stated comparable,
--    a named direction, and a change in that direction. Returns the proving verification or NULL.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_envoy_effect_proof(p_idea uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH ev AS (
    SELECT e.id, e.kind, e.value, e.goal, e.comparable, e.created_at, v.id AS vid, v.purpose,
           lower(regexp_replace(btrim(e.metric), '\s+', ' ', 'g')) AS mk,
           lower(regexp_replace(btrim(coalesce(e.unit, '')), '\s+', ' ', 'g')) AS uk
      FROM public.verification_evidence e
      JOIN public.verifications v ON v.id = e.verification_id AND v.organization_id = e.organization_id
     WHERE v.idea_id = p_idea AND v.status = 'completed'
       AND e.kind IN ('baseline', 'result') AND e.value IS NOT NULL AND btrim(coalesce(e.metric, '')) <> ''
  ), base AS (
    SELECT DISTINCT ON (mk) * FROM ev WHERE kind = 'baseline' ORDER BY mk, created_at DESC, id DESC
  ), res AS (
    SELECT DISTINCT ON (r.mk) r.*, b.goal AS b_goal, b.value AS b_value, b.uk AS b_uk
      FROM ev r JOIN base b ON b.mk = r.mk AND r.created_at >= b.created_at
     WHERE r.kind = 'result'
     ORDER BY r.mk, r.created_at DESC, r.id DESC
  )
  SELECT vid FROM res
   WHERE purpose = 'impact' AND uk = b_uk AND comparable IS TRUE AND b_goal IS NOT NULL
     AND ((b_goal = 'decrease' AND value < b_value) OR (b_goal = 'increase' AND value > b_value))
   ORDER BY created_at, vid
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- 5. The only write path. p_live = false only for the one-time backfill below (no audit, no messages).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_envoy_grant(p_idea uuid, p_kind text, p_source_type text, p_source_id uuid, p_proof uuid,
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
  -- Whose question it is: the colleague it was raised for, else the author (ADR-0007, ADR-0032).
  who := coalesce(i.raised_by_membership_id, i.author_membership_id);
  SELECT * INTO o FROM public.organizations x WHERE x.id = i.organization_id;
  pts := CASE p_kind WHEN 'implementation' THEN o.envoy_xp_implementation WHEN 'effect' THEN o.envoy_xp_effect ELSE 0 END;
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

CREATE FUNCTION app_envoy_try_effect(p_idea uuid, p_at timestamptz, p_live boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ap record;
  proof uuid;
BEGIN
  -- The decision owner's approval with a bonus above zero, and a measured improvement.
  SELECT * INTO ap FROM public.effect_approvals a WHERE a.idea_id = p_idea AND a.xp > 0;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  proof := app_envoy_effect_proof(p_idea);
  IF proof IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN app_envoy_grant(p_idea, 'effect', 'effect_approval', ap.id, proof, p_at, p_live);
END $$;

-- The castle got its award for a confirmed implementation or an approved effect → the envoy too.
CREATE FUNCTION app_envoy_on_castle_award() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'implementation' THEN
    PERFORM app_envoy_grant(NEW.idea_id, 'implementation', 'xp_award', NEW.id, NULL, NULL, true);
  ELSIF NEW.kind = 'effect' THEN
    PERFORM app_envoy_try_effect(NEW.idea_id, NULL, true);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER xp_awards_envoy AFTER INSERT ON xp_awards FOR EACH ROW EXECUTE FUNCTION app_envoy_on_castle_award();

-- A measurement concluded after the effect was approved: whichever comes second awards, once.
CREATE FUNCTION app_envoy_on_verification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM app_envoy_try_effect(NEW.idea_id, NULL, true);
  RETURN NULL;
END $$;
CREATE TRIGGER verifications_envoy AFTER UPDATE OF status ON verifications
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION app_envoy_on_verification();

REVOKE ALL ON FUNCTION app_envoy_effect_proof(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_envoy_grant(uuid, text, text, uuid, uuid, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_envoy_try_effect(uuid, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_envoy_on_castle_award() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_envoy_on_verification() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 6. Confirmed events from before this migration, in the order they happened, with their dates.
--    No audit rows and no messages: these are history, not news.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  e record;
BEGIN
  FOR e IN
    SELECT x.kind, x.idea_id, x.id AS source, x.created_at AS at
      FROM xp_awards x WHERE x.kind = 'implementation'
    UNION ALL
    SELECT 'effect', a.idea_id, a.id,
           greatest(a.created_at, (SELECT v.completed_at FROM verifications v WHERE v.id = app_envoy_effect_proof(a.idea_id)))
      FROM effect_approvals a
     WHERE a.xp > 0 AND app_envoy_effect_proof(a.idea_id) IS NOT NULL
    ORDER BY at, kind DESC
  LOOP
    IF e.kind = 'implementation' THEN
      PERFORM app_envoy_grant(e.idea_id, 'implementation', 'xp_award', e.source, NULL, e.at, false);
    ELSE
      PERFORM app_envoy_try_effect(e.idea_id, e.at, false);
    END IF;
  END LOOP;
END $$;
