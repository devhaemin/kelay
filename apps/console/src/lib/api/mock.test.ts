import { describe, expect, it } from 'vitest';
import { createMockApi, createMockState } from './mock';

const fresh = () => createMockApi(createMockState(Date.parse('2026-11-11T03:00:00Z')));

describe('mock ConsoleApi', () => {
  it('connects the grant when its proposal is approved, and back when reopened', async () => {
    const api = fresh();
    const decision = await api.approveProposal('prop-133');
    expect(decision.proposal.state).toBe('approved');
    expect(decision.grant).toMatchObject({ id: 'l3', status: 'connected' });
    expect((await api.listGrants()).find((g) => g.id === 'l3')?.status).toBe('connected');

    const reopened = await api.reopenProposal('prop-133');
    expect(reopened.grant?.status).toBe('pending');
  });

  it('approves the proposal behind a grant allowed from the App Graph', async () => {
    const api = fresh();
    await api.allowGrant('l3');
    const [report] = await api.listReports('ticket-board');
    expect(report?.proposals.find((p) => p.id === 'prop-133')?.state).toBe('approved');
  });

  it('drops rejected grants from the graph', async () => {
    const api = fresh();
    await api.rejectGrant('l3');
    expect((await api.listGrants()).map((g) => g.id)).not.toContain('l3');
  });

  it('publishes the next version and clears the unpublished change', async () => {
    const api = fresh();
    const result = await api.publish('ticket-board');
    expect(result).toMatchObject({ env: 'prod', version: 'v13', url: 'https://kelay.app/jeongyun/ticket-board' });
    expect((await api.getApp('ticket-board')).pendingChange).toBeNull();
  });

  it('builds a new draft app from a prompt without reusing a slug', async () => {
    const api = fresh();
    const app = await api.createApp({ prompt: 'A Jira-style ticket board for my team' });
    expect(app).toMatchObject({ id: 'ticket-board-2', name: 'Ticket Board', status: 'draft' });
    expect((await api.getPolicy(app.id)).schema.app).toBe('ticket-board-2');
    expect((await api.getPreview(app.id))?.kind).toBe('fixture');
  });

  it('rejects roles the app schema does not declare', async () => {
    const api = fresh();
    await expect(api.updateMember('ticket-board', 'u1', { role: 'owner' })).rejects.toMatchObject({ status: 400 });
    expect((await api.updateMember('ticket-board', 'u1', { role: 'admin' })).role).toBe('admin');
  });
});
