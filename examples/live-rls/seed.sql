DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO kelay_runtime;
CREATE TABLE app.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL DEFAULT kelay.org(),
  owner_id text NOT NULL DEFAULT kelay.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  shared boolean NOT NULL DEFAULT false,
  title text NOT NULL,
  status text NOT NULL,
  assignee_id text,
  due_on timestamptz
);
ALTER TABLE app.tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tickets FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.tickets TO kelay_runtime;
-- admin: all
CREATE POLICY tickets_read_admin ON app.tickets FOR SELECT USING (kelay.role() = 'admin' AND org_id = kelay.org());
CREATE POLICY tickets_update_admin ON app.tickets FOR UPDATE USING (kelay.role() = 'admin' AND org_id = kelay.org()) WITH CHECK (org_id = kelay.org());
-- member: read mine + shared, update mine
CREATE POLICY tickets_read_member ON app.tickets FOR SELECT USING (kelay.role() = 'member' AND org_id = kelay.org() AND (assignee_id = kelay.uid() OR shared));
CREATE POLICY tickets_update_member ON app.tickets FOR UPDATE USING (kelay.role() = 'member' AND org_id = kelay.org() AND assignee_id = kelay.uid()) WITH CHECK (assignee_id = kelay.uid());
-- guest: read mine + shared only
CREATE POLICY tickets_read_guest ON app.tickets FOR SELECT USING (kelay.role() = 'guest' AND org_id = kelay.org() AND (assignee_id = kelay.uid() OR shared));
INSERT INTO app.tickets (org_id, owner_id, title, status, assignee_id, shared, due_on) VALUES
 ('orum','seoyeon','Polish payment failure copy','todo','junho',false, now() - interval '1 day'),
 ('orum','seoyeon','Accessibility check for settings','todo','junho',false, now() + interval '3 day'),
 ('orum','seoyeon','Onboarding emails (3)','doing','junho',false, now() + interval '1 day'),
 ('orum','seoyeon','Sort comments on ticket detail','review','junho',false, now()),
 ('orum','seoyeon','Fix login error copy','done','junho',false, now() - interval '4 day'),
 ('orum','seoyeon','November release notes','todo','seoyeon',true, now() + interval '4 day'),
 ('orum','seoyeon','Clean up payment logs','doing','minjae',true, now() + interval '2 day'),
 ('orum','seoyeon','Design QA checklist','done','sua',true, now() - interval '5 day'),
 ('orum','seoyeon','Q4 pricing review','todo','seoyeon',false, now() + interval '7 day'),
 ('orum','seoyeon','Vendor contract renewal','doing','seoyeon',false, now() + interval '9 day'),
 ('orum','seoyeon','Hiring plan draft','review','minjae',false, now() + interval '2 day'),
 ('other-team','x','Another team''s secret ticket','todo','x',true, now());
