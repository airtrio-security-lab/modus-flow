-- MODUS FLOW · 0016 · «Великое Содружество»: the game world of an organization (owner clarification 2026-11-11, ADR-0021).
--
-- An organization (a tenant, e.g. ГК «Модус Трейд») is shown in the game as ONE commonwealth. Its name is a setting
-- of the organization; the real company name stays in `organizations.name` for administration and documents.
-- Departments choose civilizations (styles, 0014/0015) — they are never separate organizations or tenants.
-- Additive only: one column with a default, column grants for the existing admin-only update policy.

ALTER TABLE organizations ADD COLUMN realm_name text NOT NULL DEFAULT 'Великое Содружество'
  CHECK (length(btrim(realm_name)) BETWEEN 3 AND 60);
GRANT SELECT (realm_name) ON organizations TO modus_app;
GRANT UPDATE (realm_name) ON organizations TO modus_app;
