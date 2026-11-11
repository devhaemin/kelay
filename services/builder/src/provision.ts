// The database of an app env. The Control API applies the schema and the access rules on deploy, but
// the database itself has to exist first (its README: "a provisioner calls PUT /internal/v1/apps/:app/envs/:env").
import pg from 'pg';

export interface DatabaseProvisioner {
  /** Makes sure the env's database exists and returns its URL. */
  ensure(app: string, env: 'dev' | 'prod'): Promise<string>;
}

/**
 * For the local stack: creates `app_<app>_<env>` on the Postgres server named by the template
 * (APP_DATABASE_URL_TEMPLATE, the same placeholders the Control API uses).
 */
export class PgDatabaseProvisioner implements DatabaseProvisioner {
  constructor(private readonly template: string) {}

  async ensure(app: string, env: 'dev' | 'prod'): Promise<string> {
    const url = this.template.replaceAll('{app}', app.replaceAll('-', '_')).replaceAll('{env}', env);
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    // The name comes from an app slug, and `create database` takes no parameters.
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`refusing to create database ${JSON.stringify(name)}`);
    const maintenance = new URL(url);
    maintenance.pathname = '/postgres';
    const client = new pg.Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (!rowCount) await client.query(`create database ${name}`);
    } finally {
      await client.end();
    }
    return url;
  }
}
