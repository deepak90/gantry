/**
 * Dev-server routes for the call with Remy, on this machine only. The LiveKit key and secret stay here,
 * in the dev server: a tab asks for a short-lived token to its project's call and joins with that. Not
 * part of any build (`apply` is the dev server alone, never tests), and the secret, not being a `VITE_`
 * variable, never reaches the browser. The hosted site answers the same requests from api/call/, for
 * signed-in members only (call-hosted.ts); both mint and send Remy through call-server.ts.
 *
 * - `POST /__call/token` `{ projectId, sessionId, name, color, role, sim?, remy? }` → `{ url, token, remy }`. The
 *   token joins room `project-<projectId>` as the tab's presence session id, publishes the microphone only,
 *   subscribes, sends data, carries name, color, role (and sim) as attributes, and sends Remy's worker
 *   (agent `remy`) when the room is created. A call already going without Remy gets her sent again. With
 *   `remy: false` the join leaves her out (`remy` answers `not-asked`): the people start talking first.
 * - `GET /__call/room?projectId=` → `{ up, people, remy }`: whether the call server answers, the names of
 *   the people on the project's call and whether Remy is there, so a tab can offer "Join".
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { CallServer, UUID } from './call-server.ts';
import { roomFor, tokenRequestOf } from './src/call/protocol.ts';

/** The call server's own API is on this machine: a slow answer means it is not running. */
const API_TIMEOUT_MS = 1500;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Only this dev server's own pages, from this machine, not another site open in the same browser. */
const fromThisMachine = (req: IncomingMessage) =>
  LOOPBACK.has(req.socket.remoteAddress ?? '') && (!req.headers.origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin));

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 10_000) throw new Error('Too long');
  }
  return JSON.parse(body);
}

export function callRoutes(): Plugin {
  return {
    name: 'collab-call-routes',
    apply: (_config, env) => env.command === 'serve' && env.mode !== 'test',
    async configureServer(server) {
      // Loaded by the dev server alone: a build or a test run never needs the server SDK.
      const sdk = await import('livekit-server-sdk');
      const env = loadEnv(server.config.mode, server.config.envDir || process.cwd(), '');
      const key = env.LIVEKIT_API_KEY;
      const secret = env.LIVEKIT_API_SECRET;
      const serverUrl = env.LIVEKIT_URL;
      // The address the browser connects to.
      const browserUrl = env.VITE_LIVEKIT_URL || serverUrl;
      const calls = key && secret && serverUrl ? new CallServer(sdk, { url: serverUrl, key, secret, timeoutMs: API_TIMEOUT_MS }) : null;

      server.middlewares.use('/__call/token', (req, res) => {
        void (async () => {
          if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' });
          if (!fromThisMachine(req)) return reply(res, 403, { error: 'Not from this machine' });
          if (!calls) return reply(res, 503, { error: 'There are no LiveKit keys in .env.local (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)' });
          let body: unknown;
          try {
            body = await readJson(req);
          } catch {
            return reply(res, 400, { error: 'Not JSON' });
          }
          const checked = tokenRequestOf(body);
          if (!checked.ok) return reply(res, 400, { error: checked.error });
          const request = checked.value;
          // Remy comes with the room: the first person to join creates it, and LiveKit sends her worker. A join that
          // asks for no Remy (people talking before they call her in) leaves her out until someone asks again.
          const [token, remy] = await Promise.all([
            calls.mint(request, { remy: request.remy }),
            request.remy ? calls.ensureRemy(roomFor(request.projectId), request.projectId) : Promise.resolve('not-asked'),
          ]);
          reply(res, 200, { url: browserUrl, token, remy });
        })().catch((error: unknown) => reply(res, 500, { error: error instanceof Error ? error.message : String(error) }));
      });

      server.middlewares.use('/__call/room', (req, res) => {
        void (async () => {
          if (req.method !== 'GET') return reply(res, 405, { error: 'GET only' });
          if (!fromThisMachine(req)) return reply(res, 403, { error: 'Not from this machine' });
          const projectId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('projectId') ?? '';
          if (!UUID.test(projectId)) return reply(res, 400, { error: 'Unknown project' });
          if (!calls) return reply(res, 200, { up: false, people: [], remy: false });
          reply(res, 200, await calls.news(roomFor(projectId.toLowerCase())));
        })().catch((error: unknown) => reply(res, 500, { error: error instanceof Error ? error.message : String(error) }));
      });
    },
  };
}
