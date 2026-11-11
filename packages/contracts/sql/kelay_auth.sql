-- Contract §3: helpers every app database installs before its tables and policies.
-- The Data API sets `request.jwt.claims` (SET LOCAL) to the verified Kelay ID claims,
-- then `SET LOCAL ROLE kelay_runtime`. Policies only ever read claims through these functions.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS kelay;
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION kelay.claims() RETURNS jsonb
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

CREATE OR REPLACE FUNCTION kelay.uid() RETURNS text LANGUAGE sql STABLE AS $$ SELECT kelay.claims() ->> 'sub' $$;
CREATE OR REPLACE FUNCTION kelay.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT kelay.claims() ->> 'role' $$;
CREATE OR REPLACE FUNCTION kelay.org() RETURNS text LANGUAGE sql STABLE AS $$ SELECT kelay.claims() ->> 'org' $$;
CREATE OR REPLACE FUNCTION kelay.plan() RETURNS text LANGUAGE sql STABLE AS $$ SELECT kelay.claims() ->> 'plan' $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kelay_runtime') THEN
    CREATE ROLE kelay_runtime NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA kelay, app TO kelay_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA kelay TO kelay_runtime;
