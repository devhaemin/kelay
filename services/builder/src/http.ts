// The Builder's HTTP server: its API (src/app.ts) and, on the same port, the preview proxy, which also
// takes the WebSocket upgrades of the previews' HMR sockets.
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import type { PreviewProxy } from './preview/proxy.ts';

export function createBuilderServer(api: { fetch: (request: Request) => Response | Promise<Response> }, preview?: PreviewProxy): Server {
  const listener = getRequestListener(api.fetch);
  const server = createServer((req, res) => {
    if (!preview?.handle(req, res)) void listener(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    if (preview?.upgrade(req, socket, head)) return;
    socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    socket.destroy();
  });
  return server;
}
