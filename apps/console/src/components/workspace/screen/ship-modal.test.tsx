import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, createMockState } from '@/lib/api/mock';
import { ShipModal } from './ship-modal';

describe('Ship modal', () => {
  it('publishes, walks the steps and hands back the production link', async () => {
    const api = createMockApi(createMockState());
    const app = await api.getApp('ticket-board');
    const onPublish = vi.fn(async () => ({ ok: true as const, data: await api.publish('ticket-board') }));

    render(<ShipModal app={app} closeHref="/app/ticket-board/screen" team="Orum Studio" ruleCount={25} checkCount={24} onPublish={onPublish} />);

    expect(screen.getByRole('dialog', { name: 'Shipping Ticket Board…' })).toBeInTheDocument();
    expect(screen.getByText('Apply 25 access rules')).toBeInTheDocument();
    expect(onPublish).toHaveBeenCalledTimes(1);

    expect(await screen.findByRole('heading', { name: 'Ticket Board is live' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('kelay.app/jeongyun/ticket-board')).toBeInTheDocument();
    expect(screen.getByText(/v13 · live in 18s/)).toBeInTheDocument();
  });

  it('stops at the failing step and shows why', async () => {
    const app = await createMockApi(createMockState()).getApp('ticket-board');
    render(
      <ShipModal app={app} closeHref="/" team="" ruleCount={null} checkCount={null} onPublish={async () => ({ ok: false, error: '2 interaction checks failed' })} />,
    );
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('2 interaction checks failed');
    expect(screen.queryByRole('heading', { name: /is live/ })).not.toBeInTheDocument();
  });
});
