// The Home prompt: creates the app at the Control API, then asks the Builder for a workspace and the
// first build. Answers `{ app, workspace, turn }`; progress comes from `…/workspaces/:app/events`.
import { z } from 'zod';
import { builderProxy } from '@/lib/api/builder-server';
import { isApiError } from '@/lib/api/errors';
import { dataMode, getConsoleApi } from '@/lib/api/server';

const Body = z.object({ prompt: z.string().trim().min(1).max(4000) });

const error = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });

export async function POST(request: Request) {
  if (dataMode() !== 'http') return error('not_found', 'The Builder is only available with CONSOLE_DATA=http.', 404);
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return error('invalid_request', 'Describe the app to build.', 400);

  let app;
  try {
    app = await (await getConsoleApi()).createApp({ prompt: body.data.prompt });
  } catch (e) {
    if (isApiError(e)) return error(e.code, e.message, e.status);
    throw e;
  }
  const started = await builderProxy('/v1/workspaces', { method: 'POST', body: JSON.stringify({ app: app.id, prompt: body.data.prompt }) });
  const json = await started.json().catch(() => null);
  // The app exists either way; with its id the caller can open it and ask the Builder again from the chat.
  if (!started.ok) return Response.json({ ...(json ?? { error: { code: 'internal', message: 'The Builder did not start.' } }), app }, { status: started.status });
  return Response.json({ app, ...json }, { status: 202 });
}
