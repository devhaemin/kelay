-- Hand-written stand-in for the policy compiler's output for the ticket-board fixture
-- (packages/contracts/fixtures/ticket-board), following contract §2 (tables) and §3 (RLS).
-- Apply packages/contracts/sql/kelay_auth.sql first. Re-applying resets the schema.
DROP TABLE IF EXISTS app.comments, app.tickets, app.projects;

CREATE TABLE app.projects (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     text        NOT NULL DEFAULT kelay.org(),
  owner_id   text        NOT NULL DEFAULT kelay.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  name       text        NOT NULL,
  starts_on  timestamptz,
  ends_on    timestamptz
);

CREATE TABLE app.tickets (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      text        NOT NULL DEFAULT kelay.org(),
  owner_id    text        NOT NULL DEFAULT kelay.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  shared      boolean     NOT NULL DEFAULT false,
  title       text        NOT NULL,
  status      text        NOT NULL,
  assignee_id text,
  due_on      timestamptz,
  project_id  uuid        REFERENCES app.projects(id)
);

CREATE TABLE app.comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     text        NOT NULL DEFAULT kelay.org(),
  owner_id   text        NOT NULL DEFAULT kelay.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ticket_id  uuid        NOT NULL REFERENCES app.tickets(id),
  body       text        NOT NULL
);

ALTER TABLE app.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE app.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tickets FORCE ROW LEVEL SECURITY;
ALTER TABLE app.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.comments FORCE ROW LEVEL SECURITY;

-- admin: all on every collection.
CREATE POLICY projects_read_admin ON app.projects FOR SELECT
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY projects_create_admin ON app.projects FOR INSERT
  WITH CHECK (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY projects_update_admin ON app.projects FOR UPDATE
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true)
  WITH CHECK (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY projects_delete_admin ON app.projects FOR DELETE
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true);

CREATE POLICY tickets_read_admin ON app.tickets FOR SELECT
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY tickets_create_admin ON app.tickets FOR INSERT
  WITH CHECK (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY tickets_update_admin ON app.tickets FOR UPDATE
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true)
  WITH CHECK (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY tickets_delete_admin ON app.tickets FOR DELETE
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true);

CREATE POLICY comments_read_admin ON app.comments FOR SELECT
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY comments_create_admin ON app.comments FOR INSERT
  WITH CHECK (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY comments_update_admin ON app.comments FOR UPDATE
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true)
  WITH CHECK (kelay.role() = 'admin' AND org_id = kelay.org() AND true);
CREATE POLICY comments_delete_admin ON app.comments FOR DELETE
  USING (kelay.role() = 'admin' AND org_id = kelay.org() AND true);

-- member: projects read all; tickets read mine_shared, create all, update mine, delete none;
-- comments read all, create all, update mine, delete mine. Tickets' ownerField is assignee_id.
CREATE POLICY projects_read_member ON app.projects FOR SELECT
  USING (kelay.role() = 'member' AND org_id = kelay.org() AND true);

CREATE POLICY tickets_read_member ON app.tickets FOR SELECT
  USING (kelay.role() = 'member' AND org_id = kelay.org() AND (assignee_id = kelay.uid() OR shared));
CREATE POLICY tickets_create_member ON app.tickets FOR INSERT
  WITH CHECK (kelay.role() = 'member' AND org_id = kelay.org() AND true);
CREATE POLICY tickets_update_member ON app.tickets FOR UPDATE
  USING (kelay.role() = 'member' AND org_id = kelay.org() AND assignee_id = kelay.uid())
  WITH CHECK (kelay.role() = 'member' AND org_id = kelay.org() AND assignee_id = kelay.uid());

CREATE POLICY comments_read_member ON app.comments FOR SELECT
  USING (kelay.role() = 'member' AND org_id = kelay.org() AND true);
CREATE POLICY comments_create_member ON app.comments FOR INSERT
  WITH CHECK (kelay.role() = 'member' AND org_id = kelay.org() AND true);
CREATE POLICY comments_update_member ON app.comments FOR UPDATE
  USING (kelay.role() = 'member' AND org_id = kelay.org() AND owner_id = kelay.uid())
  WITH CHECK (kelay.role() = 'member' AND org_id = kelay.org() AND owner_id = kelay.uid());
CREATE POLICY comments_delete_member ON app.comments FOR DELETE
  USING (kelay.role() = 'member' AND org_id = kelay.org() AND owner_id = kelay.uid());

-- guest: projects read all; tickets read mine_shared only; comments read all, create all, update mine.
CREATE POLICY projects_read_guest ON app.projects FOR SELECT
  USING (kelay.role() = 'guest' AND org_id = kelay.org() AND true);

CREATE POLICY tickets_read_guest ON app.tickets FOR SELECT
  USING (kelay.role() = 'guest' AND org_id = kelay.org() AND (assignee_id = kelay.uid() OR shared));

CREATE POLICY comments_read_guest ON app.comments FOR SELECT
  USING (kelay.role() = 'guest' AND org_id = kelay.org() AND true);
CREATE POLICY comments_create_guest ON app.comments FOR INSERT
  WITH CHECK (kelay.role() = 'guest' AND org_id = kelay.org() AND true);
CREATE POLICY comments_update_guest ON app.comments FOR UPDATE
  USING (kelay.role() = 'guest' AND org_id = kelay.org() AND owner_id = kelay.uid())
  WITH CHECK (kelay.role() = 'guest' AND org_id = kelay.org() AND owner_id = kelay.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO kelay_runtime;
