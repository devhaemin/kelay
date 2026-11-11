// In-app /feedback: POST {controlApiUrl}/v1/apps/:app/feedback, answered with { ticketId }.
import { appSlug } from './client.ts';
import { KelayError } from './errors.ts';
import { joinUrl, postJson, type AuthOptions } from './http.ts';
import type { AppRef } from './types.ts';

export interface SendFeedbackOptions extends AuthOptions {
  controlApiUrl: string;
  app: AppRef;
  text: string;
  /** Screen route the feedback was sent from, e.g. `/tickets/123`. */
  route?: string;
  /** Extra JSON the triage worker may use (screen state, client version, …). */
  context?: Record<string, unknown>;
}

export async function sendFeedback(options: SendFeedbackOptions): Promise<{ ticketId: string }> {
  const { controlApiUrl, app, text, route, context } = options;
  if (!text.trim()) throw new KelayError('invalid_request', 'feedback text is empty');
  const body = { text, ...(route === undefined ? {} : { route }), ...(context === undefined ? {} : { context }) };
  const res = (await postJson(joinUrl(controlApiUrl, `/v1/apps/${appSlug(app)}/feedback`), body, options)) as { ticketId?: unknown } | null;
  if (typeof res?.ticketId !== 'string') throw new KelayError('internal', 'feedback response has no ticketId', { status: 200 });
  return { ticketId: res.ticketId };
}
