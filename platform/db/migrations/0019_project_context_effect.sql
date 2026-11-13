-- MODUS FLOW · Product refinement (ADR-0031): where the problem arose, which other departments it
-- touches, and a measured effect on the existing evidence engine.
--
-- Additive only: two tables, four nullable columns on verification_evidence, and one guard relaxed so
-- that the existing «impact» verification can also be started after the implementation is confirmed.
-- No existing row is changed or removed.

-- ---------------------------------------------------------------------------
-- 1. Where the problem arose: an optional note on the item, written once.
--    It is NOT a project entity: no budgets, contracts or schedules.
-- ---------------------------------------------------------------------------
CREATE TABLE idea_contexts (
  idea_id                  uuid PRIMARY KEY,
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  project_ref              text CHECK (project_ref IS NULL OR length(btrim(project_ref)) BETWEEN 1 AND 160),
  work_stage               text CHECK (work_stage IS NULL OR work_stage IN
                             ('design','procurement','installation','commissioning','operation','internal','other')),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (project_ref IS NOT NULL OR work_stage IS NOT NULL),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE TRIGGER idea_contexts_append_only BEFORE UPDATE OR DELETE ON idea_contexts FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE idea_contexts ENABLE ROW LEVEL SECURITY;
CREATE POLICY idea_contexts_read ON idea_contexts FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
-- Written by the people of the item: the one who filed it (or on whose behalf), its lead, its decision owner.
CREATE POLICY idea_contexts_insert ON idea_contexts FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND created_by_membership_id = app_membership_id() AND app_actor_ok()
              AND app_idea_visible(idea_id)
              AND EXISTS (SELECT 1 FROM ideas i WHERE i.id = idea_id AND app_membership_id() IN
                           (i.author_membership_id, i.raised_by_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)));
GRANT SELECT, INSERT ON idea_contexts TO modus_app;

-- ---------------------------------------------------------------------------
-- 2. Other departments the problem touches. Kept apart from ideas.department_id, which stays the
--    department responsible for routing; an affected department gets no rights over the item.
-- ---------------------------------------------------------------------------
CREATE TABLE idea_affected_departments (
  idea_id                uuid NOT NULL,
  department_id          uuid NOT NULL,
  organization_id        uuid NOT NULL REFERENCES organizations(id),
  added_by_membership_id uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (idea_id, department_id),
  FOREIGN KEY (organization_id, idea_id) REFERENCES ideas(organization_id, id),
  FOREIGN KEY (organization_id, department_id) REFERENCES departments(organization_id, id),
  FOREIGN KEY (organization_id, added_by_membership_id) REFERENCES memberships(organization_id, id)
);
CREATE INDEX idea_affected_departments_department ON idea_affected_departments (department_id);
CREATE TRIGGER idea_affected_departments_append_only BEFORE UPDATE OR DELETE ON idea_affected_departments FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION idea_affected_departments_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ideas i WHERE i.id = NEW.idea_id AND i.department_id = NEW.department_id) THEN
    RAISE EXCEPTION 'the responsible department is not listed among the affected ones' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.id = NEW.department_id AND d.active) THEN
    RAISE EXCEPTION 'the affected department must be an active department' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idea_affected_departments_guard BEFORE INSERT ON idea_affected_departments
  FOR EACH ROW EXECUTE FUNCTION idea_affected_departments_guard();

ALTER TABLE idea_affected_departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY idea_affected_departments_read ON idea_affected_departments FOR SELECT TO modus_app
  USING (organization_id = app_org_id() AND app_idea_visible(idea_id));
CREATE POLICY idea_affected_departments_insert ON idea_affected_departments FOR INSERT TO modus_app
  WITH CHECK (organization_id = app_org_id() AND added_by_membership_id = app_membership_id() AND app_actor_ok()
              AND app_idea_visible(idea_id)
              AND EXISTS (SELECT 1 FROM ideas i WHERE i.id = idea_id AND app_membership_id() IN
                           (i.author_membership_id, i.raised_by_membership_id, i.maintainer_membership_id, i.decision_owner_membership_id)));
GRANT SELECT, INSERT ON idea_affected_departments TO modus_app;

-- ---------------------------------------------------------------------------
-- 3. Measurements «before» and «after» on the existing, append-only evidence.
--    period     — when or under which conditions the value was measured;
--    source     — where the number comes from;
--    goal       — on a baseline: is a lower or a higher value the improvement;
--    comparable — on a result: the person who measured states that the conditions match the baseline.
-- ---------------------------------------------------------------------------
ALTER TABLE verification_evidence
  ADD COLUMN period     text CHECK (period IS NULL OR length(btrim(period)) BETWEEN 1 AND 200),
  ADD COLUMN source     text CHECK (source IS NULL OR length(btrim(source)) BETWEEN 1 AND 300),
  ADD COLUMN goal       text CHECK (goal IS NULL OR goal IN ('decrease','increase')),
  ADD COLUMN comparable boolean,
  ADD CONSTRAINT verification_evidence_goal_on_baseline CHECK (goal IS NULL OR kind = 'baseline'),
  ADD CONSTRAINT verification_evidence_comparable_on_result CHECK (comparable IS NULL OR kind = 'result');

-- ---------------------------------------------------------------------------
-- 4. The «impact» verification (0001) could be started only while the implementation is under way.
--    A measurement after the implementation is confirmed is the same verification started one stage
--    later. Nothing else changes: who may start, record and conclude stays as it was.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verifications_guard_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ideas i
                  WHERE i.id = NEW.idea_id AND i.current_revision_number = NEW.revision_number
                    AND ((NEW.purpose = 'hypothesis' AND i.stage IN ('review','verification'))
                         OR (NEW.purpose = 'impact' AND i.stage IN ('adoption','impact_verification')))) THEN
    RAISE EXCEPTION 'verification must target the current revision at the right stage' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
