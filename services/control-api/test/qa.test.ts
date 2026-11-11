import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QaRunInput, QaRunner } from '../src/qa/runner.ts';
import { createHarness, seedApp, type Harness } from './harness.ts';

let h: Harness;
let builder: string;
let sql: Awaited<ReturnType<Harness['appDatabase']>>['sql'];
const APP = 'ticket-board';

beforeAll(async () => {
  h = await createHarness();
  builder = await seedApp(h, 'jeongyun', APP);
});
afterAll(() => h.close());

describe('QA runs with the access-rule checks', () => {
  it('has no run to show at first, and needs a deployed schema to start one', async () => {
    expect((await h.req('GET', `/v1/apps/${APP}/qa`, { token: builder })).body).toMatchObject({ error: { code: 'not_found' } });
    expect((await h.req('POST', `/v1/apps/${APP}/qa/run`, { token: builder })).body).toMatchObject({ error: { code: 'conflict' } });
  });

  it('checks every role × collection × op against the app database and stores the result', async () => {
    ({ sql } = await h.appDatabase(APP, builder));
    await sql(`INSERT INTO app.projects (org_id, owner_id, name) VALUES ('orum', 'jiwoo', 'Launch')`);

    const res = await h.req('POST', `/v1/apps/${APP}/qa/run`, { token: builder });
    expect(res.status).toBe(201);
    const { qa } = res.body;
    expect(qa).toMatchObject({ app: APP, env: 'dev', status: 'passed', error: null, version: 'v1', startedBy: 'jeongyun', passing: 36, total: 36, errorsReachedUsers7d: 0, incidents: [] });
    expect(qa.checks).toHaveLength(36);
    expect(qa.roles.map((r: { role: string; passing: number; total: number }) => [r.role, r.passing, r.total])).toEqual([
      ['admin', 12, 12],
      ['member', 12, 12],
      ['guest', 12, 12],
    ]);
    const check = (name: string) => qa.checks.find((c: { name: string }) => c.name === name);
    expect(check('member can’t delete tickets')).toEqual({
      name: 'member can’t delete tickets',
      status: 'ok',
      durationMs: expect.any(Number),
      note: null,
      role: 'member',
      collection: 'tickets',
      op: 'delete',
      expected: 'deny',
      actual: 'deny',
    });
    expect(check('member can update tickets')).toMatchObject({ status: 'ok', expected: 'allow', actual: 'allow' });
    expect(check('guest can’t create tickets')).toMatchObject({ status: 'ok', actual: 'deny' });
    expect(check('admin can delete comments')).toMatchObject({ status: 'ok', actual: 'allow' });

    // The probe rows are gone and nothing else changed.
    expect((await sql('SELECT count(*)::int AS n FROM app.tickets')).rows[0].n).toBe(0);
    expect((await sql('SELECT count(*)::int AS n FROM app.projects')).rows[0].n).toBe(1);
    expect((await sql(`SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = 'app.tickets'::regclass`)).rows[0].forced).toBe(true);

    const latest = await h.req('GET', `/v1/apps/${APP}/qa`, { token: builder });
    expect(latest.body.qa).toMatchObject({ id: qa.id, status: 'passed', passing: 36, total: 36 });
  });

  it('fails the run when the database answers differently from the policy', async () => {
    // Someone loosened a rule by hand, and a rule the policy grants is missing.
    await sql(`CREATE POLICY "tickets_delete_member" ON app.tickets FOR DELETE TO kelay_runtime USING (kelay.role() = 'member')`);
    await sql(`DROP POLICY "comments_create_guest" ON app.comments`);
    const { qa } = (await h.req('POST', `/v1/apps/${APP}/qa/run`, { caller: await h.service('scheduler'), body: { env: 'dev' } })).body;
    expect(qa).toMatchObject({ status: 'failed', passing: 34, total: 36, startedBy: 'service:scheduler' });
    expect(qa.checks.filter((c: { status: string }) => c.status === 'bad')).toEqual([
      expect.objectContaining({ name: 'member can’t delete tickets', expected: 'deny', actual: 'allow', note: 'expected deny, the database answered allow' }),
      expect.objectContaining({ name: 'guest can create comments', expected: 'allow', actual: 'deny', note: 'expected allow, the database answered deny' }),
    ]);
    expect(qa.roles.find((r: { role: string }) => r.role === 'guest')).toMatchObject({ passing: 11, total: 12 });
    expect((await h.req('GET', `/v1/apps/${APP}/qa`, { token: builder })).body.qa.id).toBe(qa.id);
    expect((await h.req('GET', `/v1/apps/${APP}/qa?env=prod`, { token: builder })).status).toBe(404);
  });

  it('expects update and delete to fail for a role that cannot read the rows', async () => {
    const blind = { admin: { projects: { read: 'none', create: 'all', update: 'all', delete: 'all' } } };
    await h.req('POST', `/v1/apps/${APP}/envs/dev/deploy`, {
      token: builder,
      body: { commit: 'b2', artifactUrl: `s3://kelay-builds/${APP}/b2.zip`, configVersion: 'cfg-b2', policy: blind },
    });
    await sql(`DROP POLICY "projects_read_admin" ON app.projects`);
    const { qa } = (await h.req('POST', `/v1/apps/${APP}/qa/run`, { token: builder })).body;
    const admin = qa.roles.find((r: { role: string }) => r.role === 'admin').checks.filter((c: { collection: string }) => c.collection === 'projects');
    expect(admin.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
      ['admin can’t read projects', 'ok'],
      ['admin can create projects', 'ok'],
      ['admin can’t update projects', 'ok'],
      ['admin can’t delete projects', 'ok'],
    ]);
    expect(admin[2].note).toBe('admin may update projects but cannot read them, so there is no row to update');
  });

  it('only builders who own the app, or services, may run it', async () => {
    expect((await h.req('POST', `/v1/apps/${APP}/qa/run`, { token: await h.builder('stranger') })).status).toBe(403);
    expect((await h.req('GET', `/v1/apps/${APP}/qa`, { caller: await h.service() })).status).toBe(401);
    expect((await h.req('POST', `/v1/apps/${APP}/qa/run`, { token: builder, body: { env: 'staging' } })).status).toBe(400);
  });
});

describe('QA with another runner', () => {
  class ScriptedRunner implements QaRunner {
    readonly name = 'scripted';
    inputs: QaRunInput[] = [];
    fail = false;
    async run(input: QaRunInput) {
      this.inputs.push(input);
      if (this.fail) throw new Error('browser crashed');
      return [{ role: 'member', collection: 'tickets', op: 'read' as const, expected: 'allow' as const, actual: 'allow' as const, ok: true, ms: 800, note: 'Added after FB-1' }];
    }
  }

  let own: Harness;
  let token: string;
  const runner = new ScriptedRunner();

  beforeAll(async () => {
    own = await createHarness({ qa: runner });
    token = await seedApp(own, 'jeongyun', APP);
    await own.appDatabase(APP, token);
  });
  afterAll(() => own.close());

  it('stores whatever the runner returns', async () => {
    const { qa } = (await own.req('POST', `/v1/apps/${APP}/qa/run`, { token })).body;
    expect(qa).toMatchObject({ status: 'passed', passing: 1, total: 1 });
    expect(qa.checks[0]).toMatchObject({ name: 'member can read tickets', status: 'ok', durationMs: 800, note: 'Added after FB-1' });
    expect(runner.inputs[0]).toMatchObject({ app: APP, env: 'dev', schema: { app: APP }, policy: { guest: expect.any(Object) }, databaseUrl: expect.stringContaining('_app0') });
  });

  it('records a run that could not finish as an error', async () => {
    runner.fail = true;
    const res = await own.req('POST', `/v1/apps/${APP}/qa/run`, { token });
    expect(res.status).toBe(201);
    expect(res.body.qa).toMatchObject({ status: 'error', error: 'browser crashed', passing: 0, total: 0, checks: [] });
    expect((await own.req('GET', `/v1/apps/${APP}/qa`, { token })).body.qa.status).toBe('error');
  });

  it('builds the incident timeline from bug tickets and counts errors that reached users', async () => {
    const send = async (user: string, text: string) =>
      own.req('POST', `/v1/apps/${APP}/feedback`, { token: await own.appUser(APP, user), caller: await own.appCaller(APP), body: { text, route: '/board' } });
    await send('daniel', 'Error when moving a ticket to Done');
    await own.req('POST', `/v1/apps/${APP}/tickets/triage`, { token });
    const report = await own.req('POST', `/v1/apps/${APP}/reports/run`, { token });
    await own.req('POST', `/v1/proposals/${report.body.proposals[0].id}/approve`, { token });
    await own.req('PATCH', `/v1/apps/${APP}/tickets/FB-1`, { token, body: { status: 'done', fixedIn: 'v2' } });
    await own.req('POST', '/internal/v1/runs', {
      caller: await own.service('data-api'),
      body: { runs: [{ app: APP, action: 'tickets_update', userId: 'daniel', status: 'error' }, { app: APP, action: 'tickets_update', status: 'error', caller: { kind: 'agent' } }] },
    });

    const { qa } = (await own.req('GET', `/v1/apps/${APP}/qa`, { token })).body;
    expect(qa.errorsReachedUsers7d).toBe(1);
    expect(qa.incidents).toHaveLength(1);
    const [incident] = qa.incidents;
    expect(incident).toMatchObject({ ticket: 'FB-1', title: 'Caught: Bug: Error when moving a ticket to Done', resolved: true });
    expect(incident.timeline.map((t: { tone: string | null; text: string }) => [t.tone, t.text])).toEqual([
      ['red', '[[FB-1]] reported on `/board`: _Error when moving a ticket to Done_'],
      [null, 'Daily report proposed: Fix Bug: Error when moving a ticket to Done.'],
      [null, 'The fix was approved.'],
      ['green', 'Fixed in **v2**.'],
    ]);
    expect(incident.timeline.every((t: { at: string; when: string }) => t.when === t.at && !Number.isNaN(Date.parse(t.at)))).toBe(true);
  });
});
