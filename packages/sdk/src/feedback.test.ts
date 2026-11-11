import { describe, expect, it } from 'vitest';
import { KelayError } from './errors.ts';
import { sendFeedback } from './feedback.ts';
import { auth, json, mockFetch, sentRequest, ticketBoard } from './test-helpers.ts';

describe('sendFeedback', () => {
  it('posts text to the control API and returns the ticket id', async () => {
    const fetch = mockFetch(() => json(201, { ticketId: 'tk_1' }));
    const res = await sendFeedback({ controlApiUrl: 'http://localhost:4003', app: 'ticket-board', fetch, ...auth, text: 'Label is clipped' });
    expect(res).toEqual({ ticketId: 'tk_1' });
    const req = sentRequest(fetch);
    expect(req.url).toBe('http://localhost:4003/v1/apps/ticket-board/feedback');
    expect(req.method).toBe('POST');
    expect(req.headers).toMatchObject({ authorization: 'Bearer user-tok', 'x-kelay-caller': 'caller-tok' });
    expect(req.body).toEqual({ text: 'Label is clipped' });
  });

  it('sends route and context, and accepts a defined app', async () => {
    const fetch = mockFetch(() => json(200, { ticketId: 'tk_2' }));
    await sendFeedback({
      controlApiUrl: 'http://localhost:4003/',
      app: ticketBoard,
      fetch,
      ...auth,
      text: 'Cannot move ticket',
      route: '/tickets/t2',
      context: { role: 'member', build: 'v12' },
    });
    expect(sentRequest(fetch)).toMatchObject({
      url: 'http://localhost:4003/v1/apps/ticket-board/feedback',
      body: { text: 'Cannot move ticket', route: '/tickets/t2', context: { role: 'member', build: 'v12' } },
    });
  });

  it('rejects empty text without sending', async () => {
    const fetch = mockFetch(() => json(200, { ticketId: 'x' }));
    await expect(sendFeedback({ controlApiUrl: 'http://c', app: 'ticket-board', fetch, ...auth, text: '  ' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps errors and malformed responses to KelayError', async () => {
    const limited = mockFetch(() => json(429, { error: { code: 'rate_limited', message: 'later' } }));
    await expect(sendFeedback({ controlApiUrl: 'http://c', app: 'ticket-board', fetch: limited, ...auth, text: 'hi' })).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    const malformed = mockFetch(() => json(200, { id: 'tk' }));
    await expect(sendFeedback({ controlApiUrl: 'http://c', app: 'ticket-board', fetch: malformed, ...auth, text: 'hi' })).rejects.toBeInstanceOf(
      KelayError,
    );
  });
});
