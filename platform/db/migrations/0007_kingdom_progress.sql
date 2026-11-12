-- MODUS FLOW · 0007 · Kingdom progress (XP, levels, rating) and the round-table council.
--
-- Owner brief 2026-11-11: the kingdom must look like a game and work like the
-- corporate system it sits on. Rules kept here, in the database:
--   * XP is never a separate source of truth: it is written only by triggers
--     on confirmed workflow events (implementation confirmed; effect approved
--     by the decision owner). Nothing is awarded for submitting, reviewing or
--     rejecting. (idea_id, kind) is unique, so re-opening, re-saving or
--     replaying a step can never award twice.
--   * Castles belong to departments; there is no personal score.
--   * Council entries (arguments, recommendations, dissent, hand-off) are
--     advice and history, append-only; they never change a status on their own.
--     The decision stays with the decision owner (ADR-0007, ADR-0012).

-- ---------------------------------------------------------------------------
-- 1. Configuration: levels and XP amounts per organization (starting values)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_levels_ok(t integer[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_length(t, 1) = 5 AND t[1] = 0 AND t[1] < t[2] AND t[2] < t[3] AND t[3] < t[4] AND t[4] < t[5], false)
$$;
CREATE FUNCTION app_level_names_ok(n text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_length(n, 1) = 5 AND (SELECT bool_and(length(btrim(x)) BETWEEN 2 AND 40) FROM unnest(n) x), false)
$$;

ALTER TABLE organizations
  ADD COLUMN xp_per_implementation integer NOT NULL DEFAULT 100 CHECK (xp_per_implementation BETWEEN 0 AND 1000),
  ADD COLUMN xp_effect_max integer NOT NULL DEFAULT 50 CHECK (xp_effect_max BETWEEN 0 AND 1000),
  ADD COLUMN level_thresholds integer[] NOT NULL DEFAULT '{0,100,250,500,900}' CHECK (app_levels_ok(level_thresholds)),
  ADD COLUMN level_names text[] NOT NULL
    DEFAULT '{Поселение,Крепость,Цитадель,Королевский замок,Легендарная крепость}' CHECK (app_level_names_ok(level_names));
GRANT SELECT (xp_per_implementation, xp_effect_max, level_thresholds, level_names) ON organizations TO modus_app;
GRANT UPDATE (xp_per_implementation, xp_effect_max, level_thresholds, level_names) ON organizations TO modus_app;

-- Department size for normalized rating (XP per 10 people); set by the admin, optional.
ALTER TABLE departments ADD COLUMN headcount integer CHECK (headcount IS NULL OR headcount BETWEEN 1 AND 100000);
GRANT UPDATE (headcount) ON departments TO modus_app;

-- ---------------------------------------------------------------------------
-- 2. XP ledger: written only by triggers below
-- ---------------------------------------------------------------------------
CREATE TABLE xp_awards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  department_id   uuid,
  idea_id         uuid NOT NULL REFERENCES ideas(id),
  kind            text NOT NULL CHECK (kind IN ('implementation', 'effect')),
  xp              integer NOT NULL CHECK (xp BETWEEN 0 AND 1000),
  source_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (idea_id, kind),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id)
);
CREATE INDEX xp_awards_department ON xp_awards (organization_id, department_id, created_at);
CREATE TRIGGER xp_awards_append_only BEFORE UPDATE OR DELETE ON xp_awards FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE xp_awards ENABLE ROW LEVEL SECURITY;
CREATE POLICY xp_awards_read ON xp_awards FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_full_member());
GRANT SELECT ON xp_awards TO modus_app;

-- Confirmed implementation: the idea reached impact_verification (completeImplementation).
CREATE FUNCTION app_award_implementation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.xp_awards (organization_id, department_id, idea_id, kind, xp)
  SELECT NEW.organization_id, NEW.department_id, NEW.id, 'implementation', o.xp_per_implementation
    FROM public.organizations o WHERE o.id = NEW.organization_id
  ON CONFLICT (idea_id, kind) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER ideas_award_implementation AFTER UPDATE OF stage ON ideas
  FOR EACH ROW WHEN (NEW.stage = 'impact_verification' AND OLD.stage IS DISTINCT FROM NEW.stage)
  EXECUTE FUNCTION app_award_implementation();

-- Items implemented before this migration earn their XP once, at the time they were confirmed.
INSERT INTO xp_awards (organization_id, department_id, idea_id, kind, xp, created_at)
SELECT i.organization_id, i.department_id, i.id, 'implementation', o.xp_per_implementation,
       coalesce((SELECT max(a.created_at) FROM audit_events a WHERE a.entity_id = i.id AND a.action = 'idea.implemented'), i.updated_at)
  FROM ideas i JOIN organizations o ON o.id = i.organization_id
 WHERE i.stage = 'impact_verification'
    OR (i.stage = 'closed' AND EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_id = i.id AND a.action = 'idea.implemented'))
ON CONFLICT (idea_id, kind) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Effect approval: up to xp_effect_max, by the decision owner, once per item
-- ---------------------------------------------------------------------------
CREATE TABLE effect_approvals (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES organizations(id),
  idea_id                   uuid NOT NULL UNIQUE REFERENCES ideas(id),
  approved_by_membership_id uuid NOT NULL,
  xp                        integer NOT NULL CHECK (xp BETWEEN 0 AND 1000),
  rationale                 text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 20 AND 3000),
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, approved_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER effect_approvals_append_only BEFORE UPDATE OR DELETE ON effect_approvals FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE effect_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY effect_approvals_read ON effect_approvals FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
CREATE POLICY effect_approvals_insert ON effect_approvals FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND approved_by_membership_id = app_membership_id() AND app_idea_visible(idea_id));
GRANT SELECT, INSERT ON effect_approvals TO modus_app;

CREATE FUNCTION app_effect_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i record;
  cap integer;
BEGIN
  SELECT * INTO i FROM public.ideas x WHERE x.id = NEW.idea_id AND x.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'idea not found' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.xp_awards a WHERE a.idea_id = i.id AND a.kind = 'implementation') THEN
    RAISE EXCEPTION 'effect can be approved only for a confirmed implementation' USING ERRCODE = '23514';
  END IF;
  IF NEW.approved_by_membership_id IS DISTINCT FROM i.decision_owner_membership_id
     OR NEW.approved_by_membership_id IN (i.author_membership_id, coalesce(i.raised_by_membership_id, i.author_membership_id)) THEN
    RAISE EXCEPTION 'only the decision owner, not an originator, approves the effect' USING ERRCODE = '42501';
  END IF;
  SELECT o.xp_effect_max INTO cap FROM public.organizations o WHERE o.id = NEW.organization_id;
  IF NEW.xp > cap THEN
    RAISE EXCEPTION 'effect bonus above the organization maximum' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER effect_approvals_rules BEFORE INSERT ON effect_approvals FOR EACH ROW EXECUTE FUNCTION app_effect_rules();

CREATE FUNCTION app_award_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.xp_awards (organization_id, department_id, idea_id, kind, xp, source_id)
  SELECT NEW.organization_id, i.department_id, NEW.idea_id, 'effect', NEW.xp, NEW.id
    FROM public.ideas i WHERE i.id = NEW.idea_id
  ON CONFLICT (idea_id, kind) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER effect_approvals_award AFTER INSERT ON effect_approvals FOR EACH ROW EXECUTE FUNCTION app_award_effect();

-- ---------------------------------------------------------------------------
-- 4. Round-table council: arguments, recommendations, dissent, hand-off
-- ---------------------------------------------------------------------------
CREATE TABLE council_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  idea_id              uuid NOT NULL REFERENCES ideas(id),
  author_membership_id uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('argument_for', 'argument_against', 'recommendation', 'dissent', 'handoff')),
  recommendation       text CHECK (recommendation IN ('implement', 'pilot', 'clarify', 'reject', 'rework')),
  body                 text NOT NULL CHECK (length(btrim(body)) BETWEEN 3 AND 3000),
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'recommendation') = (recommendation IS NOT NULL)),
  CHECK (kind NOT IN ('recommendation', 'dissent', 'handoff') OR length(btrim(body)) >= 10),
  FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE INDEX council_entries_idea ON council_entries (idea_id, created_at);
CREATE TRIGGER council_entries_append_only BEFORE UPDATE OR DELETE ON council_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE council_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY council_entries_read ON council_entries FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
CREATE POLICY council_entries_insert ON council_entries FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND author_membership_id = app_membership_id() AND app_idea_visible(idea_id));
GRANT SELECT, INSERT ON council_entries TO modus_app;

CREATE FUNCTION app_council_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i record;
BEGIN
  SELECT * INTO i FROM public.ideas x WHERE x.id = NEW.idea_id AND x.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'idea not found' USING ERRCODE = '42501';
  END IF;
  IF i.stage NOT IN ('published', 'review', 'development', 'verification', 'decision') THEN
    RAISE EXCEPTION 'the council discusses only items under consideration' USING ERRCODE = '23514';
  END IF;
  -- Conflict of interest: an originator argues for their item but never recommends or hands it off.
  IF NEW.kind IN ('recommendation', 'handoff')
     AND NEW.author_membership_id IN (i.author_membership_id, coalesce(i.raised_by_membership_id, i.author_membership_id)) THEN
    RAISE EXCEPTION 'an originator does not recommend their own item' USING ERRCODE = '42501';
  END IF;
  IF NEW.kind = 'handoff' AND NEW.author_membership_id IS DISTINCT FROM i.maintainer_membership_id THEN
    RAISE EXCEPTION 'only the maintainer hands the item to the decision owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER council_entries_rules BEFORE INSERT ON council_entries FOR EACH ROW EXECUTE FUNCTION app_council_rules();

-- ---------------------------------------------------------------------------
-- 5. Notifications: council recommendation, hand-off, castle level-up
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT notifications_event_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_event_type_check CHECK (event_type IN
  ('idea_published','comment_added','changes_requested','assigned',
   'verification_started','verification_completed','idea_merged',
   'idea_rejected','contribution_confirmed','honor_board_recognition',
   'objection_raised','revision_submitted','suggestion_submitted','suggestion_decided',
   'status_report','implemented','raised_on_behalf','escalated',
   'council_recommendation','council_handoff','castle_level_up'));

CREATE OR REPLACE FUNCTION app_notify(event text, idea uuid, recipients uuid[], dedupe text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  actor uuid := app_membership_id();
  org uuid := app_org_id();
  proven boolean;
  n integer;
  i record;
BEGIN
  IF NOT app_actor_ok() OR idea IS NULL OR NOT app_idea_visible(idea) THEN
    RAISE EXCEPTION 'notification not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO i FROM public.ideas x WHERE x.id = idea AND x.organization_id = org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'notification not allowed' USING ERRCODE = '42501';
  END IF;
  proven := CASE event
    WHEN 'idea_published' THEN i.author_membership_id = actor
    WHEN 'raised_on_behalf' THEN i.author_membership_id = actor AND i.raised_by_membership_id IS NOT NULL
    WHEN 'assigned' THEN EXISTS (SELECT 1 FROM public.audit_events a WHERE a.entity_id = idea
                                    AND a.action = 'idea.assigned' AND a.actor_user_id = app_user_id())
    WHEN 'comment_added' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND (r.author_membership_id = actor OR r.resolved_by_membership_id = actor))
    WHEN 'changes_requested' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND r.kind = 'request_changes' AND r.author_membership_id = actor)
    WHEN 'objection_raised' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND r.kind = 'objection' AND r.author_membership_id = actor)
    WHEN 'status_report' THEN EXISTS (SELECT 1 FROM public.reviews r WHERE r.idea_id = idea
                                    AND r.kind = 'progress' AND r.author_membership_id = actor)
    WHEN 'implemented' THEN i.stage IN ('impact_verification','closed')
                            AND actor IN (i.implementer_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)
    WHEN 'revision_submitted' THEN EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea
                                    AND r.origin = 'author_update' AND r.author_membership_id = actor)
    WHEN 'suggestion_submitted' THEN EXISTS (SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea
                                    AND r.origin = 'suggestion' AND r.author_membership_id = actor)
    WHEN 'suggestion_decided' THEN i.author_membership_id = actor AND EXISTS (
                                    SELECT 1 FROM public.idea_revisions r WHERE r.idea_id = idea
                                      AND r.origin = 'suggestion' AND r.status IN ('current','superseded','declined'))
    WHEN 'verification_started' THEN EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = idea
                                    AND v.created_by_membership_id = actor)
    WHEN 'verification_completed' THEN EXISTS (SELECT 1 FROM public.verifications v WHERE v.idea_id = idea
                                    AND v.concluded_by_membership_id = actor AND v.status = 'completed')
    WHEN 'idea_merged' THEN EXISTS (SELECT 1 FROM public.decisions d WHERE d.idea_id = idea
                                    AND d.decided_by_membership_id = actor AND d.outcome = 'merge')
    WHEN 'idea_rejected' THEN EXISTS (SELECT 1 FROM public.decisions d WHERE d.idea_id = idea
                                    AND d.decided_by_membership_id = actor AND d.outcome IN ('reject','close'))
    WHEN 'council_recommendation' THEN EXISTS (SELECT 1 FROM public.council_entries e WHERE e.idea_id = idea
                                    AND e.author_membership_id = actor AND e.kind IN ('recommendation','dissent'))
    WHEN 'council_handoff' THEN i.stage = 'decision' AND EXISTS (SELECT 1 FROM public.council_entries e WHERE e.idea_id = idea
                                    AND e.author_membership_id = actor AND e.kind = 'handoff')
    WHEN 'castle_level_up' THEN EXISTS (SELECT 1 FROM public.xp_awards a WHERE a.idea_id = idea)
                            AND actor IN (i.implementer_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)
    ELSE false
  END;
  IF NOT coalesce(proven, false) THEN
    RAISE EXCEPTION 'notification is not backed by a workflow record' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.notifications (organization_id, recipient_membership_id, actor_membership_id, event_type, idea_id, dedupe_key)
  SELECT org, m.id, actor, event, idea, event || ':' || dedupe
    FROM public.memberships m
   WHERE m.id = ANY (recipients) AND m.id <> actor AND m.organization_id = org AND m.status = 'active'
     AND (m.access = 'member' OR m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id))
     AND CASE event
           WHEN 'assigned' THEN m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id, i.implementer_membership_id)
           WHEN 'raised_on_behalf' THEN m.id = i.raised_by_membership_id
           WHEN 'idea_published' THEN m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id)
                                   OR (i.maintainer_membership_id IS NULL
                                       AND (m.roles && ARRAY['maintainer','decision_owner']
                                            OR m.id = (SELECT o.escalation_membership_id FROM public.organizations o WHERE o.id = org)))
           WHEN 'council_recommendation' THEN m.id IN (i.maintainer_membership_id, i.decision_owner_membership_id)
           WHEN 'council_handoff' THEN m.id = i.decision_owner_membership_id
           WHEN 'castle_level_up' THEN m.id IN (i.author_membership_id, i.raised_by_membership_id)
           ELSE app_is_participant(idea, m.id)
         END
     AND app_notification_enabled(m.id, event, idea)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
