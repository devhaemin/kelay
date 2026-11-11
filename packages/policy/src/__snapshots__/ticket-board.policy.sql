ALTER TABLE "app"."projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."projects" FORCE ROW LEVEL SECURITY;

ALTER TABLE "app"."tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."tickets" FORCE ROW LEVEL SECURITY;

ALTER TABLE "app"."comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."comments" FORCE ROW LEVEL SECURITY;

DO $kelay$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'app'
      AND left(policyname, length(tablename) + 1) = tablename || '_'
      AND substr(policyname, length(tablename) + 2) ~ '^(read|create|update|delete)_[a-z][a-z0-9_]*$'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, 'app', p.tablename);
  END LOOP;
END
$kelay$;

CREATE POLICY "projects_read_admin" ON "app"."projects" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "projects_create_admin" ON "app"."projects" AS PERMISSIVE FOR INSERT TO "kelay_runtime"
  WITH CHECK (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "projects_update_admin" ON "app"."projects" AS PERMISSIVE FOR UPDATE TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org())
  WITH CHECK (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "projects_delete_admin" ON "app"."projects" AS PERMISSIVE FOR DELETE TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "projects_read_member" ON "app"."projects" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'member' AND "org_id" = kelay.org());

CREATE POLICY "projects_read_guest" ON "app"."projects" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'guest' AND "org_id" = kelay.org());

CREATE POLICY "tickets_read_admin" ON "app"."tickets" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "tickets_create_admin" ON "app"."tickets" AS PERMISSIVE FOR INSERT TO "kelay_runtime"
  WITH CHECK (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "tickets_update_admin" ON "app"."tickets" AS PERMISSIVE FOR UPDATE TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org())
  WITH CHECK (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "tickets_delete_admin" ON "app"."tickets" AS PERMISSIVE FOR DELETE TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "tickets_read_member" ON "app"."tickets" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'member' AND "org_id" = kelay.org() AND ("assignee_id" = kelay.uid() OR "shared"));

CREATE POLICY "tickets_create_member" ON "app"."tickets" AS PERMISSIVE FOR INSERT TO "kelay_runtime"
  WITH CHECK (kelay.role() = 'member' AND "org_id" = kelay.org());

CREATE POLICY "tickets_update_member" ON "app"."tickets" AS PERMISSIVE FOR UPDATE TO "kelay_runtime"
  USING (kelay.role() = 'member' AND "org_id" = kelay.org() AND "assignee_id" = kelay.uid())
  WITH CHECK (kelay.role() = 'member' AND "org_id" = kelay.org() AND "assignee_id" = kelay.uid());

CREATE POLICY "tickets_read_guest" ON "app"."tickets" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'guest' AND "org_id" = kelay.org() AND ("assignee_id" = kelay.uid() OR "shared"));

CREATE POLICY "comments_read_admin" ON "app"."comments" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "comments_create_admin" ON "app"."comments" AS PERMISSIVE FOR INSERT TO "kelay_runtime"
  WITH CHECK (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "comments_update_admin" ON "app"."comments" AS PERMISSIVE FOR UPDATE TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org())
  WITH CHECK (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "comments_delete_admin" ON "app"."comments" AS PERMISSIVE FOR DELETE TO "kelay_runtime"
  USING (kelay.role() = 'admin' AND "org_id" = kelay.org());

CREATE POLICY "comments_read_member" ON "app"."comments" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'member' AND "org_id" = kelay.org());

CREATE POLICY "comments_create_member" ON "app"."comments" AS PERMISSIVE FOR INSERT TO "kelay_runtime"
  WITH CHECK (kelay.role() = 'member' AND "org_id" = kelay.org());

CREATE POLICY "comments_update_member" ON "app"."comments" AS PERMISSIVE FOR UPDATE TO "kelay_runtime"
  USING (kelay.role() = 'member' AND "org_id" = kelay.org() AND "owner_id" = kelay.uid())
  WITH CHECK (kelay.role() = 'member' AND "org_id" = kelay.org() AND "owner_id" = kelay.uid());

CREATE POLICY "comments_delete_member" ON "app"."comments" AS PERMISSIVE FOR DELETE TO "kelay_runtime"
  USING (kelay.role() = 'member' AND "org_id" = kelay.org() AND "owner_id" = kelay.uid());

CREATE POLICY "comments_read_guest" ON "app"."comments" AS PERMISSIVE FOR SELECT TO "kelay_runtime"
  USING (kelay.role() = 'guest' AND "org_id" = kelay.org());

CREATE POLICY "comments_create_guest" ON "app"."comments" AS PERMISSIVE FOR INSERT TO "kelay_runtime"
  WITH CHECK (kelay.role() = 'guest' AND "org_id" = kelay.org());

CREATE POLICY "comments_update_guest" ON "app"."comments" AS PERMISSIVE FOR UPDATE TO "kelay_runtime"
  USING (kelay.role() = 'guest' AND "org_id" = kelay.org() AND "owner_id" = kelay.uid())
  WITH CHECK (kelay.role() = 'guest' AND "org_id" = kelay.org() AND "owner_id" = kelay.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "app" TO "kelay_runtime";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA "app" TO "kelay_runtime";
