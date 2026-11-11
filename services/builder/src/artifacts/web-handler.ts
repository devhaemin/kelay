// Entry of an app's web function. It is bundled into every `web.zip` as `index.handler`, in front of
// the handler OpenNext generated. No CDN or bucket sits in front of an app function (the Router Worker
// forwards every request under /<handle>/<app> to its function URL), so the files OpenNext would put
// in a bucket travel in the zip and are answered here; everything else goes to Next.js.
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mime from 'mime';

/** A Lambda function URL request (the API Gateway v2 HTTP event), as far as this handler reads it. */
export interface WebEvent {
  rawPath?: string;
  requestContext?: { http?: { method?: string; path?: string; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}

export interface WebResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  [key: string]: unknown;
}

export type WebHandler = (event: WebEvent, context?: unknown) => Promise<WebResult>;

export interface WebHandlerOptions {
  /** Folder of the static files, laid out by request path. */
  assetsDir: URL | string;
  /** The app's Next.js basePath (`/<handle>/<app>`), or '' when it is served from the root. */
  basePath: string;
}

/** A function URL answers at most 6 MB, and base64 adds a third. */
const MAX_ASSET_BYTES = 4 * 1024 * 1024;

const cacheControl = (path: string) =>
  // Files under _next/static carry a content hash in their name.
  path.includes('/_next/static/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';

export function createWebHandler(app: WebHandler, opts: WebHandlerOptions): WebHandler {
  const root = (typeof opts.assetsDir === 'string' ? opts.assetsDir : fileURLToPath(opts.assetsDir)).replace(/\/+$/, '');
  const prefix = opts.basePath.replace(/\/+$/, '');

  const asset = async (event: WebEvent): Promise<WebResult | null> => {
    const method = event.requestContext?.http?.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return null;
    let path: string;
    try {
      path = decodeURIComponent(event.rawPath ?? event.requestContext?.http?.path ?? '/');
    } catch {
      return null;
    }
    // The files are laid out without the base path the browser asks for them under.
    if (prefix) {
      if (!path.startsWith(`${prefix}/`)) return null;
      path = path.slice(prefix.length);
    }
    // Only plain file paths: no dot segments, nothing that could leave the assets folder.
    if (!path.startsWith('/') || path.endsWith('/') || path.includes('\0') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.')) return null;
    const file = `${root}${path}`;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) return null;
      const headers = { 'content-type': mime.getType(file) ?? 'application/octet-stream', 'cache-control': cacheControl(path), 'content-length': String(info.size) };
      if (method === 'HEAD') return { statusCode: 200, headers };
      return { statusCode: 200, headers, body: (await readFile(file)).toString('base64'), isBase64Encoded: true };
    } catch {
      return null;
    }
  };

  return async (event, context) => (await asset(event)) ?? app(event, context);
}
