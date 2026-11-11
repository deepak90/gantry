/**
 * Remy's call worker: `pnpm remy:call` from the repo root (`dev` mode, on this machine), or `node src/main.ts start` in
 * production (the Dockerfile; `pnpm remy:call:prod` runs it here). It registers as agent `remy`, and LiveKit sends Remy
 * into a room when that room's first token asks for her. Keys come from the root .env.local here, and from the
 * deployment's secrets on LiveKit Cloud: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and OPENAI_API_KEY.
 */
import { fileURLToPath } from 'node:url';
import { cli, ServerOptions, type JobRequest } from '@livekit/agents';
import { AGENT_NAME, DISPLAY_NAME, IDENTITY } from './config.ts';
import { logEvent } from './log.ts';

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is missing: Remy hears and speaks through OpenAI (set it in the root .env.local).');
  process.exit(1);
}

/** On LiveKit Cloud (the Dockerfile sets it): the worker there reports its real load, which Cloud scales by. */
const HOSTED = process.env.GANTRY_HOSTED?.trim() === '1';

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(new URL('./agent.ts', import.meta.url)),
    agentName: AGENT_NAME,
    // On a local machine the app's 3D view or a screen recorder can keep the CPU busy: measured by the machine's CPU,
    // she would read as full and LiveKit would send her nowhere. Her own
    // work is light (speech in, speech out over the network), so she reports none and takes every call. LiveKit Cloud
    // replaces any custom load with its own measure, so the hosted worker leaves it as it is.
    ...(HOSTED ? {} : { loadFunc: async () => 0 }),
    requestFunc: async (request: JobRequest) => {
      logEvent('job_request', { room: request.room?.name ?? null, agentName: AGENT_NAME });
      await request.accept(DISPLAY_NAME, IDENTITY, '', { name: DISPLAY_NAME });
    },
  }),
);
