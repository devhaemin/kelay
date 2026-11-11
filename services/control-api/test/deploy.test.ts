import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LocalDeployDriver } from '../src/deploy/driver.ts';
import { createHarness, seedApp, type Harness } from './harness.ts';

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
  });

  it('validates the env and the schema app', async () => {
    expect((await h.req('POST', `/v1/apps/${APP}/envs/staging/deploy`, { token: builder, body: build('c3') })).status).toBe(400);
    const wrong = await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: { ...build('c3'), schema: { ...schema, app: 'team-wiki' } } });
    expect(wrong.status).toBe(400);
    expect((await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, { token: builder, body: { commit: 'x' } })).status).toBe(400);
  });

  it('publishes a dev version to prod, makes the app live, and rolls back by alias', async () => {
    const devVersions = (await h.req('GET', `/v1/apps/${APP}/versions?env=dev`, { token: builder })).body.versions;
    const [v2, v1] = devVersions;
    expect((await h.req('POST', `/v1/apps/${APP}/publish`, { caller: await h.service(), body: { versionId: v1.id } })).status).toBe(401);

    const p1 = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: v1.id } });
    expect(p1.status).toBe(200);
    expect(p1.body.version).toMatchObject({ env: 'prod', number: 1, commit: 'a1', sourceVersionId: v1.id });
    expect(p1.body.app.status).toBe('live');

    const p2 = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: v2.id } });
    expect(p2.body.version).toMatchObject({ env: 'prod', number: 2 });

    const rollback = await h.req('POST', `/v1/apps/${APP}/publish`, { token: builder, body: { versionId: p1.body.version.id } });
    expect(rollback.body.version.id).toBe(p1.body.version.id);
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
