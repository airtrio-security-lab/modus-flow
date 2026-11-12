-- MODUS FLOW · 0017 · Royal envoy audience (additive; no workflow or permission changes)
-- A royal audience is a ceremonial, server-confirmed receipt of an existing idea.
-- It NEVER approves an idea, awards XP, creates a meeting, or grants authority.

CREATE TABLE royal_audiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  idea_id uuid NOT NULL,
  requester_membership_id uuid NOT NULL,
  king_membership_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_at timestamptz,
  accepted_by_membership_id uuid,
  UNIQUE (idea_id, requester_membership_id),
  CHECK (requester_membership_id <> king_membership_id),
  CHECK ((accepted_at IS NULL) = (accepted_by_membership_id IS NULL)),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, requester_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, king_membership_id) REFERENCES memberships(organization_id, id),
  FOREIGN KEY (organization_id, accepted_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE INDEX royal_audiences_inbox ON royal_audiences (organization_id, king_membership_id, requested_at DESC);
CREATE INDEX royal_audiences_sender ON royal_audiences (organization_id, requester_membership_id, requested_at DESC);

ALTER TABLE royal_audiences ENABLE ROW LEVEL SECURITY;
CREATE POLICY royal_audiences_view ON royal_audiences FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_actor_ok()
    AND app_idea_visible(idea_id)
    AND app_membership_id() IN (requester_membership_id, king_membership_id));
CREATE POLICY royal_audiences_send ON royal_audiences FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND app_full_member()
    AND requester_membership_id = app_membership_id()
    AND app_idea_visible(idea_id));
CREATE POLICY royal_audiences_accept ON royal_audiences FOR UPDATE TO modus_app
  USING (organization_id = app_org_id() AND app_full_member()
    AND king_membership_id = app_membership_id() AND app_idea_visible(idea_id))
  WITH CHECK (organization_id = app_org_id() AND app_full_member()
    AND king_membership_id = app_membership_id() AND app_idea_visible(idea_id));
GRANT SELECT, INSERT ON royal_audiences TO modus_app;
GRANT UPDATE (accepted_at, accepted_by_membership_id) ON royal_audiences TO modus_app;

-- The guard checks the facts independently of the UI and always uses the DB clock.
-- It also protects against SQL written outside the HTTP module under the app role.
CREATE FUNCTION app_royal_audience_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  idea_row ideas%ROWTYPE;
BEGIN
  IF NOT app_actor_ok() OR NEW.organization_id IS DISTINCT FROM app_org_id() OR NOT app_full_member() THEN
    RAISE EXCEPTION 'audience forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO idea_row FROM public.ideas
    WHERE id = NEW.idea_id AND organization_id = NEW.organization_id;
  IF NOT FOUND OR NOT app_idea_visible(NEW.idea_id) THEN
    RAISE EXCEPTION 'audience idea not visible' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.requester_membership_id IS DISTINCT FROM app_membership_id()
       OR (NEW.requester_membership_id IS DISTINCT FROM idea_row.author_membership_id
           AND NEW.requester_membership_id IS DISTINCT FROM idea_row.raised_by_membership_id)
       OR idea_row.stage = 'closed'
       OR NEW.accepted_at IS NOT NULL OR NEW.accepted_by_membership_id IS NOT NULL THEN
      RAISE EXCEPTION 'only the originator of an active idea may send an envoy' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF (NEW.organization_id, NEW.idea_id, NEW.requester_membership_id, NEW.king_membership_id, NEW.requested_at, NEW.id)
       IS DISTINCT FROM
       (OLD.organization_id, OLD.idea_id, OLD.requester_membership_id, OLD.king_membership_id, OLD.requested_at, OLD.id)
       OR OLD.accepted_at IS NOT NULL
       OR NEW.king_membership_id IS DISTINCT FROM app_membership_id()
       OR NEW.accepted_at IS NULL
       OR NEW.accepted_by_membership_id IS DISTINCT FROM app_membership_id() THEN
      RAISE EXCEPTION 'only the designated king may accept the audience once' USING ERRCODE = '42501';
    END IF;
    NEW.accepted_at := clock_timestamp();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.game_titles g JOIN public.memberships m
      ON m.id = g.membership_id AND m.organization_id = g.organization_id
    WHERE g.organization_id = NEW.organization_id AND g.membership_id = NEW.king_membership_id
      AND g.rank = 'king' AND m.status = 'active' AND m.access = 'member'
  ) THEN
    RAISE EXCEPTION 'king is not appointed or no longer active' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN NEW.requested_at := clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_royal_audience_guard() FROM PUBLIC;
CREATE TRIGGER royal_audience_guard_before BEFORE INSERT OR UPDATE ON royal_audiences
  FOR EACH ROW EXECUTE FUNCTION app_royal_audience_guard();
