import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { TOKEN_COOKIE } from '../auth/kelay-id';
import { createHttpApi } from './http';
import { createMockApi } from './mock';
import type { ConsoleApi } from './types';

export { TOKEN_COOKIE };

export const dataMode = (): 'mock' | 'http' => (process.env.CONSOLE_DATA === 'http' ? 'http' : 'mock');

export async function getConsoleApi(): Promise<ConsoleApi> {
  // Mock data changes at runtime, so no page may be prerendered from it.
  await connection();
  if (dataMode() === 'mock') return createMockApi();
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  // No token and, since the proxy found none to trade, no Kelay ID session either: off to Kelay ID's login page.
  if (!token) redirect('/auth/signin');
  return createHttpApi({
    baseUrl: process.env.CONTROL_API_URL ?? 'http://localhost:4003',
    token,
    appOrigin: process.env.KELAY_APP_ORIGIN ?? 'https://kelay.app',
    mcpBaseUrl: process.env.MCP_PUBLIC_BASE_URL ?? process.env.KELAY_APP_ORIGIN ?? 'https://kelay.app',
    ...(process.env.BUILDER_URL ? { builderUrl: process.env.BUILDER_URL } : {}),
  });
}
