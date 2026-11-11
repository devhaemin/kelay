#!/bin/sh
# Creates the Postgres logins and databases the platform services use, as the Aurora master user.
# It runs as the one-off ECS task <name>-db-bootstrap (docs/deploy.md) and can run again at any time:
# after the first apply, and after every change of db_password_version, to give the roles the
# passwords that are in Secrets Manager now.
#
# Environment: PGHOST, PGPORT, PGUSER, PGPASSWORD (the master login), PGDATABASE=postgres,
#   PLATFORM_USER, PLATFORM_PASSWORD   control-api, identity, data-api: owns the control DB and every app database
#   LITELLM_USER, LITELLM_PASSWORD     the LLM gateway
#   CONTROL_DATABASE, LITELLM_DATABASE
set -eu

# role <name> <password> <attributes>
role() {
  psql -X -q -v ON_ERROR_STOP=1 -v name="$1" -v password="$2" -v attributes="$3" <<'SQL'
select format('create role %I', :'name') where not exists (select from pg_roles where rolname = :'name') \gexec
select format('alter role %I with login password %L %s', :'name', :'password', :'attributes') \gexec
-- The master user must be a member of a role to hand a database to it.
select format('grant %I to current_user', :'name') where not pg_has_role(current_user, :'name', 'member') \gexec
SQL
}

# database <name> <owner>
database() {
  psql -X -q -v ON_ERROR_STOP=1 -v name="$1" -v owner="$2" <<'SQL'
select format('create database %I owner %I', :'name', :'owner') where not exists (select from pg_database where datname = :'name') \gexec
select format('alter database %I owner to %I', :'name', :'owner') \gexec
SQL
}

# The control API creates one database per app env, and the kelay_runtime role on the first app migration.
role "$PLATFORM_USER" "$PLATFORM_PASSWORD" 'createdb createrole'
role "$LITELLM_USER" "$LITELLM_PASSWORD" 'nocreatedb nocreaterole'
database "$CONTROL_DATABASE" "$PLATFORM_USER"
database "$LITELLM_DATABASE" "$LITELLM_USER"

echo "db-bootstrap: roles $PLATFORM_USER and $LITELLM_USER, databases $CONTROL_DATABASE and $LITELLM_DATABASE are ready"
