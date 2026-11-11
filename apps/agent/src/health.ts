/**
 * The hosted service's health check: `GET /healthz` answers 200 while the service runs, with where it stands (waiting
 * for the lock, as it does while another instance answers, or answering) and how many projects it answers in, and 503
 * once it failed to start. Started only on the hosted site (main.ts).
 */
import { createServer, type Server } from 'node:http';
import type { Logger } from './log';

export interface Health {
  ok: boolean;
  [detail: string]: unknown;
}

export function startHealthServer(port: number, health: () => Health, log: Logger): Server {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || (request.url ?? '').split('?')[0] !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    const body = health();
    response.writeHead(body.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  });
  server.on('error', (error) => log.warn(`the health check could not listen on port ${port}`, error));
  server.listen(port, () => log.info(`health check on :${port}/healthz`));
  return server;
}
