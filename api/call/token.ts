/**
 * `POST /api/call/token` `{ projectId, sessionId, remy? }` with `Authorization: Bearer <Supabase access token>`
 * → `{ url, token, remy }`: a place on the project's call with Remy, for a signed-in member of the project. The
 * checks and the answers are in apps/web/call-hosted.ts.
 */
import { createClient } from '@supabase/supabase-js';
import * as livekit from 'livekit-server-sdk';
import { hostedCall, tokenResponse } from '../../apps/web/call-hosted.ts';

const call = hostedCall(process.env, { createClient, livekit });

export default {
  fetch: (request: Request): Promise<Response> => tokenResponse(call, request),
};
