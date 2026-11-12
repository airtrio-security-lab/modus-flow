-- MODUS FLOW · 0008 · MODUS ADVISOR, the minimal assistant of the Council (ADR-0013).
--
-- What it is allowed to do: propose. What it is never allowed to do: decide,
-- close items, award XP or assign credit. Every proposal keeps the exact source
-- text it came from, and nothing becomes an item or a recommendation until a
-- person confirms it. No external AI service is required: the default method
-- is a labelled rule-based parser; a local model (Ollama) is optional.

-- A lead: full member with a maintainer, decision-owner or admin role in the current organization.
CREATE FUNCTION app_is_lead() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_full_member() AND (app_has_role(app_org_id(), 'maintainer') OR app_has_role(app_org_id(), 'decision_owner')
                                OR app_has_role(app_org_id(), 'org_admin'))
$$;
GRANT EXECUTE ON FUNCTION app_is_lead() TO modus_app;

-- ---------------------------------------------------------------------------
-- 1. Short questionnaire: skills, work preferences, available hours
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_skills_ok(s text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_length(s, 1), 0) <= 12
     AND coalesce((SELECT bool_and(length(btrim(x)) BETWEEN 2 AND 40) FROM unnest(s) x), true)
$$;

CREATE TABLE employee_profiles (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  membership_id   uuid NOT NULL,
  skills          text[] NOT NULL DEFAULT '{}' CHECK (app_skills_ok(skills)),
  preferences     text CHECK (preferences IS NULL OR length(preferences) <= 500),
  weekly_hours    integer CHECK (weekly_hours IS NULL OR weekly_hours BETWEEN 0 AND 60),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, membership_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES memberships(organization_id, id)
);
ALTER TABLE employee_profiles ENABLE ROW LEVEL SECURITY;
-- The person sees and edits their own card; leads read cards to pick executors. Colleagues do not.
CREATE POLICY employee_profiles_read ON employee_profiles FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_actor_ok() AND (membership_id = app_membership_id() OR app_is_lead()));
CREATE POLICY employee_profiles_insert ON employee_profiles FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND app_actor_ok() AND membership_id = app_membership_id());
CREATE POLICY employee_profiles_update ON employee_profiles FOR UPDATE TO modus_app
  USING (organization_id = app_org_id() AND app_actor_ok() AND membership_id = app_membership_id())
  WITH CHECK (organization_id = app_org_id() AND app_actor_ok() AND membership_id = app_membership_id());
GRANT SELECT, INSERT, UPDATE ON employee_profiles TO modus_app;

-- ---------------------------------------------------------------------------
-- 2. Meeting protocols and the tasks found in them, with exact evidence
-- ---------------------------------------------------------------------------
CREATE TABLE meeting_protocols (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  created_by_membership_id uuid NOT NULL,
  title                    text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  source_text              text NOT NULL CHECK (length(source_text) BETWEEN 20 AND 20000),
  source_sha256            text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  method                   text NOT NULL CHECK (method IN ('rules', 'model')),
  model                    text,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((method = 'model') = (model IS NOT NULL)),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER meeting_protocols_append_only BEFORE UPDATE OR DELETE ON meeting_protocols FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE meeting_protocols ENABLE ROW LEVEL SECURITY;
CREATE POLICY meeting_protocols_read ON meeting_protocols FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_actor_ok() AND (created_by_membership_id = app_membership_id() OR app_is_lead()));
CREATE POLICY meeting_protocols_insert ON meeting_protocols FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND created_by_membership_id = app_membership_id() AND app_is_lead());
GRANT SELECT, INSERT ON meeting_protocols TO modus_app;

CREATE TABLE protocol_candidates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  protocol_id           uuid NOT NULL REFERENCES meeting_protocols(id),
  ord                   integer NOT NULL CHECK (ord >= 1),
  quote_start           integer NOT NULL CHECK (quote_start >= 0),
  quote_end             integer NOT NULL,
  quote                 text NOT NULL,
  proposed_title        text NOT NULL CHECK (length(btrim(proposed_title)) BETWEEN 3 AND 160),
  proposed_kind         text NOT NULL CHECK (proposed_kind IN ('problem', 'idea')),
  proposed_raiser       text CHECK (proposed_raiser IS NULL OR length(proposed_raiser) <= 120),
  status                text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'dismissed')),
  item_id               uuid REFERENCES ideas(id),
  decided_by_membership_id uuid,
  decided_at            timestamptz,
  UNIQUE (protocol_id, ord),
  CHECK (quote_end > quote_start),
  CHECK ((status = 'accepted') = (item_id IS NOT NULL)),
  CHECK ((status = 'proposed') = (decided_at IS NULL))
);
ALTER TABLE protocol_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY protocol_candidates_read ON protocol_candidates FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND EXISTS (SELECT 1 FROM meeting_protocols p WHERE p.id = protocol_id));
CREATE POLICY protocol_candidates_insert ON protocol_candidates FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id()
              AND EXISTS (SELECT 1 FROM meeting_protocols p WHERE p.id = protocol_id AND p.created_by_membership_id = app_membership_id()));
CREATE POLICY protocol_candidates_decide ON protocol_candidates FOR UPDATE TO modus_app
  USING (organization_id = app_org_id() AND app_is_lead())
  WITH CHECK (organization_id = app_org_id() AND decided_by_membership_id = app_membership_id());
GRANT SELECT, INSERT, UPDATE (status, item_id, decided_by_membership_id, decided_at) ON protocol_candidates TO modus_app;

-- Evidence integrity: a candidate's quote is exactly the protocol text at its offsets.
-- A decision is final: only proposed → accepted / dismissed, once.
CREATE FUNCTION app_candidate_rules() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  src text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p.source_text INTO src FROM public.meeting_protocols p WHERE p.id = NEW.protocol_id AND p.organization_id = NEW.organization_id;
    IF src IS NULL OR NEW.quote_end > length(src) OR substr(src, NEW.quote_start + 1, NEW.quote_end - NEW.quote_start) <> NEW.quote THEN
      RAISE EXCEPTION 'the quote must be the exact protocol text at its offsets' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'a candidate starts as a proposal' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'the candidate is already decided' USING ERRCODE = '23514';
  END IF;
  IF (NEW.protocol_id, NEW.ord, NEW.quote_start, NEW.quote_end, NEW.quote, NEW.proposed_title, NEW.proposed_kind, NEW.organization_id)
     IS DISTINCT FROM (OLD.protocol_id, OLD.ord, OLD.quote_start, OLD.quote_end, OLD.quote, OLD.proposed_title, OLD.proposed_kind, OLD.organization_id) THEN
    RAISE EXCEPTION 'the evidence of a candidate cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protocol_candidates_rules BEFORE INSERT OR UPDATE ON protocol_candidates FOR EACH ROW EXECUTE FUNCTION app_candidate_rules();
CREATE TRIGGER protocol_candidates_no_delete BEFORE DELETE ON protocol_candidates FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- 3. Executor recommendations confirmed by a person
-- ---------------------------------------------------------------------------
CREATE TABLE executor_confirmations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL REFERENCES organizations(id),
  idea_id                    uuid NOT NULL REFERENCES ideas(id),
  candidate_membership_id    uuid NOT NULL,
  confirmed_by_membership_id uuid NOT NULL,
  reasons                    text[] NOT NULL DEFAULT '{}',
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (idea_id, candidate_membership_id),
  FOREIGN KEY (organization_id, candidate_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, confirmed_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER executor_confirmations_append_only BEFORE UPDATE OR DELETE ON executor_confirmations FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE executor_confirmations ENABLE ROW LEVEL SECURITY;
CREATE POLICY executor_confirmations_read ON executor_confirmations FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
CREATE POLICY executor_confirmations_insert ON executor_confirmations FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND confirmed_by_membership_id = app_membership_id() AND app_idea_visible(idea_id)
              AND EXISTS (SELECT 1 FROM ideas i WHERE i.id = idea_id
                            AND app_membership_id() IN (i.maintainer_membership_id, i.decision_owner_membership_id)
                            AND app_membership_id() <> i.author_membership_id
                            AND app_membership_id() IS DISTINCT FROM i.raised_by_membership_id));
GRANT SELECT, INSERT ON executor_confirmations TO modus_app;
