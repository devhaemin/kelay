import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMockApi, createMockState } from '@/lib/api/mock';
import { PolicyMatrixCard } from './policy-matrix-card';

describe('Policy matrix', () => {
  it('renders each role’s scopes for the selected collection and its policy SQL', async () => {
    const policy = await createMockApi(createMockState()).getPolicy('ticket-board');
    render(<PolicyMatrixCard policy={policy} />);

    const members = screen.getByRole('row', { name: /Members/ });
    expect(within(members).getAllByRole('cell').map((c) => c.textContent)).toEqual(['All', 'None', 'None', 'None']);

    await userEvent.click(screen.getByRole('button', { name: 'tickets' }));
    expect(within(screen.getByRole('row', { name: /Members/ })).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Own + shared', 'All', 'Own', 'None']);
    expect(within(screen.getByRole('row', { name: /Guests/ })).getAllByRole('cell')[0]).toHaveTextContent('Own + shared');

    await userEvent.click(screen.getByRole('button', { name: 'Show policy SQL' }));
    expect(screen.getByText(/create policy "tickets_read_member"/)).toHaveTextContent('(assignee_id = kelay.uid() or shared)');
  });
});
