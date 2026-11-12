-- Local development only (mounted by docker-compose). Creates the
-- unprivileged API login role. Production: create an equivalent role with a
-- strong secret managed outside the repository.
CREATE ROLE modus_app NOLOGIN;
CREATE ROLE modus_api LOGIN PASSWORD 'modus-api-local-only' IN ROLE modus_app;
