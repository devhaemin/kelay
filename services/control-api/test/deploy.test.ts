import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyCallerToken } from '@kelay/tokens';
import { LocalDeployDriver } from '../src/deploy/driver.ts';
import { CALLER_SECRET, createHarness, seedApp, type Harness } from './harness.ts';

const schema = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/ticket-board/schema.json', import.meta.url), 'utf8'));

let h: Harness;
let builder: string;
let driver: LocalDeployDriver;
const APP = 'ticket-board';
const build = (commit: string) => ({ commit, artifactUrl: `s3://kelay-builds/${APP}/${commit}.zip`, configVersion: `cfg-${commit}`, schema });

beforeAll(async () => {
  driver = new LocalDeployDriver();
  h = await createHarness({ deploy: driver });
  builder = await seedApp(h, 'jeongyun', APP);
});
afterAll(() => h.close());

describe('deploy and publish with the local driver', () => {
  it('deploys builds to dev as numbered versions', async () => {
    const v1 = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: build('a1') });
    expect(v1.status).toBe(201);
    expect(v1.body.version).toMatchObject({ env: 'dev', number: 1, label: 'v1', commit: 'a1', configVersion: 'cfg-a1', lambdaVersion: 'local-1', createdBy: 'jeongyun' });

    // An improvement run deploys to dev through a platform service.
    const v2 = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { caller: await h.service('deploy'), body: build('b2') });
    expect(v2.body.version).toMatchObject({ number: 2, createdBy: 'service:deploy' });
    expect(driver.deployed.map((d) => `${d.env}:${d.number}:${d.commit}`)).toEqual(['dev:1:a1', 'dev:2:b2']);

    const detail = await h.req('GET', `/v1/apps/${APP}`, { token: builder });
    const dev = detail.body.envs.find((e: { name: string }) => e.name === 'dev');
    expect(dev.activeVersion.id).toBe(v2.body.version.id);

    // Each deploy applied its schema to the dev database; a version without rules gets none.
    expect(h.migrations).toHaveLength(2);
    expect(h.migrations[0]).toEqual({ app: APP, env: 'dev', databaseUrl: 'postgres://kelay:kelay@localhost:54320/app_ticket_board_dev', schema, policy: null });
  });

  it('mints the app-runtime caller token and stores only where it went', async () => {
    const res = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: build('t1') });
    expect(await verifyCallerToken(res.body.callerToken, CALLER_SECRET)).toMatchObject({ kind: 'app-runtime', app: APP, env: 'dev' });
    expect(res.body.version).toMatchObject({ number: 3, status: 'deployed', callerTokenRef: 'local:kelay-app-ticket-board-dev' });
    expect(driver.deployed.at(-1)?.callerToken).toBe(res.body.callerToken);
    // The token works as this app's runtime, and only for this app.
    const feedback = await h.req('POST', `/v1/apps/${APP}/feedback`, { token: await h.appUser(APP, 'mina'), caller: res.body.callerToken, body: { text: 'hello' } });
    expect(feedback.status).toBe(201);

    const { rows } = await h.database.pool.query(`select caller_token_ref from versions where app = $1 order by created_at`, [APP]);
    expect(rows.map((r) => r.caller_token_ref)).toEqual(Array(3).fill('local:kelay-app-ticket-board-dev'));
    expect(JSON.stringify((await h.req('GET', `/v1/apps/${APP}/versions`, { token: builder })).body)).not.toContain(res.body.callerToken);
  });

  it('carries the schema over when a build does not send one', async () => {
    const res = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: { commit: 't2', artifactUrl: 's3://kelay-builds/x.zip', configVersion: 'cfg-t2' } });
    expect(res.body.version.number).toBe(4);
    const entry = await h.req('GET', `/internal/v1/apps/${APP}?env=dev`, { caller: await h.service('data-api') });
    expect(entry.body).toMatchObject({ schema: { app: APP }, databaseUrl: 'postgres://kelay:kelay@localhost:54320/app_ticket_board_dev' });
  });

  it('keeps the node bundle of a build, also when the same build is deployed again', async () => {
    const web = `s3://kelay-artifacts/builds/${APP}/n1/web.zip`;
    const nodes = `s3://kelay-artifacts/builds/${APP}/n1/nodes.zip`;
    const first = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: { commit: 'n1', artifactUrl: web, nodesArtifactUrl: nodes, configVersion: 'cfg-n1' } });
    expect(first.body.version).toMatchObject({ artifactUrl: web, nodesArtifactUrl: nodes });
    expect(driver.deployed.at(-1)).toMatchObject({ artifactUrl: web, nodesArtifactUrl: nodes });

    // The console deploys saved access rules by sending the active build again, without the node bundle.
    const again = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: { commit: 'n1', artifactUrl: web, configVersion: 'cfg-n1' } });
    expect(again.body.version).toMatchObject({ artifactUrl: web, nodesArtifactUrl: nodes });

    // Another build without nodes does not inherit them.
    const other = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: build('n2') });
    expect(other.body.version.nodesArtifactUrl).toBeNull();
    expect(driver.deployed.at(-1)?.nodesArtifactUrl).toBeNull();
  });

  it('validates the env and the schema app', async () => {
    expect((await h.req('POST', `/v1/apps/${APP}/envs/staging/deploy`, { token: builder, body: build('c3') })).status).toBe(400);
    const wrong = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: { ...build('c3'), schema: { ...schema, app: 'team-wiki' } } });
    expect(wrong.status).toBe(400);
    expect((await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: { commit: 'x' } })).status).toBe(400);
  });

  it('publishes a dev version to prod, makes the app live, and rolls back by alias', async () => {
    const devVersions = (await h.req('GET', `/v1/apps/${APP}/versions?env=dev`, { token: builder })).body.versions;
    const [v2, v1] = devVersions.slice(-2);
    expect((await h.req('POST', `/v1/apps/${APP}/publish`, { caller: await h.service(), body: { versionId: v1.id } })).status).toBe(401);

    const p1 = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: v1.id } });
    expect(p1.status).toBe(200);
    expect(p1.body.version).toMatchObject({ env: 'prod', number: 1, commit: 'a1', sourceVersionId: v1.id, callerTokenRef: 'local:kelay-app-ticket-board-prod' });
    expect(await verifyCallerToken(p1.body.callerToken, CALLER_SECRET)).toMatchObject({ kind: 'app-runtime', app: APP, env: 'prod' });
    expect(p1.body.app.status).toBe('live');

    const p2 = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: v2.id } });
    expect(p2.body.version).toMatchObject({ env: 'prod', number: 2 });
    const prodMigrations = () => h.migrations.filter((m) => m.env === 'prod');
    expect(prodMigrations()).toHaveLength(2);
    expect(prodMigrations()[0]).toMatchObject({ app: APP, databaseUrl: 'postgres://kelay:kelay@localhost:54320/app_ticket_board_prod', schema: { app: APP } });

    const rollback = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: p1.body.version.id } });
    expect(rollback.body.version.id).toBe(p1.body.version.id);
    // A rollback puts that version's rules back as well.
    expect(prodMigrations()).toHaveLength(3);
    expect(rollback.body.callerToken).toBeUndefined();
    expect(driver.activated).toEqual([{ app: APP, env: 'prod', lambdaVersion: 'local-1', resources: {} }]);

    // Publishing the same dev version again reuses its prod deployment.
    const again = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: v2.id } });
    expect(again.body.version.id).toBe(p2.body.version.id);
    expect(driver.deployed.filter((d) => d.env === 'prod')).toHaveLength(2);

    const prod = await h.req('GET', `/v1/apps/${APP}/versions?env=prod`, { token: builder });
    expect(prod.body.versions.map((v: { label: string }) => v.label)).toEqual(['v2', 'v1']);

    const entry = await h.req('GET', `/internal/v1/apps/${APP}`, { caller: await h.service('data-api') });
    expect(entry.body).toMatchObject({ handle: 'h-jeongyun', databaseUrl: 'postgres://kelay:kelay@localhost:54320/app_ticket_board_prod', schema: { app: APP } });

    expect((await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(404);
    expect((await h.req('POST', `/v1/apps/${APP}/publish`, { token: await h.builder('stranger'), body: { versionId: v1.id } })).status).toBe(403);
  });
});
