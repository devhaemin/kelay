import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMockApi, createMockState } from '@/lib/api/mock';
import { AppsView } from './apps-view';

async function setup() {
  const api = createMockApi(createMockState());
  const [me, apps] = await Promise.all([api.getMe(), api.listApps()]);
  render(<AppsView me={me} apps={apps} now={Date.now()} />);
}

describe('My Apps', () => {
  it('filters by status', async () => {
    await setup();
    expect(screen.getByText('Ticket Board')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Draft' }));
    expect(screen.getByRole('button', { name: 'Draft' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Ticket Board')).not.toBeInTheDocument();
    expect(screen.getByText('Lead Qualifier')).toBeInTheDocument();
  });

  it('shares the store page with live apps listed and drafts hidden', async () => {
    await setup();
    await userEvent.click(screen.getByRole('button', { name: /Share store page/ }));
    const dialog = screen.getByRole('dialog', { name: 'Share your store page' });
    expect(within(dialog).getByText('https://kelay.app/jeongyun')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Listed')).toHaveLength(3);
    expect(within(dialog).getByText('Hidden · draft')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
