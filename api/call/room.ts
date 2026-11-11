/**
 * `GET /api/call/room?projectId=` with `Authorization: Bearer <Supabase access token>` → `{ up, people, remy }`:
 * whether a call can be joined, who is on the project's call and whether Remy is there, for a member of the project.
 * The checks and the answers are in apps/web/call-hosted.ts.
 */
import { createClient } from '@supabase/supabase-js';
import * as livekit from 'livekit-server-sdk';
import { hostedCall, roomResponse } from '../../apps/web/call-hosted.ts';

const call = hostedCall(process.env, { createClient, livekit });

export default {
  fetch: (request: Request): Promise<Response> => roomResponse(call, request),
};
