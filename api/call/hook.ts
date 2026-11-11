/**
 * `POST /api/call/hook`: LiveKit's webhook for the site's calls, set in LiveKit Cloud (Settings, Webhooks) to
 * https://<site>/api/call/hook and signed with the API key the site uses. When Remy leaves a visit's call, or its room
 * closes, the visit's minutes with her are counted then. The checks and the answers are in apps/web/call-hosted.ts.
 */
import { createClient } from '@supabase/supabase-js';
import * as livekit from 'livekit-server-sdk';
import { hookReceiverOf, hookResponse, hostedCall } from '../../apps/web/call-hosted.ts';

const call = hostedCall(process.env, { createClient, livekit });
const receiver = hookReceiverOf(process.env, livekit);

export default {
  fetch: (request: Request): Promise<Response> => hookResponse(call, receiver, request),
};
