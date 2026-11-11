/**
 * Where the call's token and room news come from. On this machine, the dev server's routes (call-dev.ts):
 * `/__call/token` and `/__call/room`, asked every 4 s. On the hosted site, the site's own routes, with the same
 * request and answer: `/api/call/token` and `/api/call/room`, signed with the person's Supabase access token (the
 * server takes their name, color and role from their membership), asked every 15 s.
 *
 * On the hosted site, a refusal (403 or 409, with `{ error }` in plain words) comes back as a CallRefusedError carrying
 * those words; the dev server's answers stay plain errors, as they always were.
 */
import { roomMinutesOf } from './minutes';
import type { TokenRequest } from './protocol';
import type { CallToken } from './session';
import type { RoomNews } from './view';

export interface CallEndpoints {
  hosted: boolean;
  tokenUrl: string;
  roomUrl(projectId: string): string;
  /** How often a tab not on the call asks whether one is going. */
  pollMs: number;
  /** What goes with each request: the access token, on the hosted site. */
  headers(): Promise<Record<string, string>>;
  /** The call server to use when the token's answer doesn't name one. */
  fallbackUrl: string | null;
}

export const DEV_POLL_MS = 4_000;
export const HOSTED_POLL_MS = 15_000;

export interface EndpointOptions {
  hosted: boolean;
  /** The signed-in person's Supabase access token (hosted). */
  accessToken?: () => Promise<string | null>;
  /** VITE_LIVEKIT_URL (hosted). */
  livekitUrl?: string | null;
}

export function callEndpoints({ hosted, accessToken, livekitUrl = null }: EndpointOptions): CallEndpoints {
  if (!hosted) {
    return {
      hosted,
      tokenUrl: '/__call/token',
      roomUrl: (projectId) => `/__call/room?projectId=${encodeURIComponent(projectId)}`,
      pollMs: DEV_POLL_MS,
      headers: async () => ({}),
      fallbackUrl: null,
    };
  }
  return {
    hosted,
    tokenUrl: '/api/call/token',
    roomUrl: (projectId) => `/api/call/room?projectId=${encodeURIComponent(projectId)}`,
    pollMs: HOSTED_POLL_MS,
    headers: async (): Promise<Record<string, string>> => {
      const token = await accessToken?.().catch(() => null);
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    fallbackUrl: livekitUrl,
  };
}

/** The server said no, in its own words (403: not allowed; 409: not now, as when Remy is on as many calls as she takes). */
export class CallRefusedError extends Error {
  readonly status: number;
  /** Why, when the server said (call-hosted.ts: remy_busy, allowance_spent, calls_off). */
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'CallRefusedError';
    this.status = status;
    this.code = code;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const REFUSALS = new Set([403, 409]);

/** A place on the project's call: a token to join with, from the dev server or the site. */
export async function requestCallToken(endpoints: CallEndpoints, request: TokenRequest, fetcher: Fetch = (input, init) => fetch(input, init)): Promise<CallToken> {
  const response = await fetcher(endpoints.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await endpoints.headers()) },
    body: JSON.stringify(request),
  });
  const answer = (await response.json().catch(() => ({}))) as Partial<CallToken> & { error?: unknown; code?: unknown };
  const words = typeof answer.error === 'string' && answer.error.trim() !== '' ? answer.error.trim() : null;
  const code = typeof answer.code === 'string' && /^[a-z_]{1,40}$/.test(answer.code) ? answer.code : null;
  if (endpoints.hosted && REFUSALS.has(response.status) && words) throw new CallRefusedError(words, response.status, code);
  const url = typeof answer.url === 'string' && answer.url !== '' ? answer.url : endpoints.fallbackUrl;
  if (!response.ok || typeof answer.token !== 'string' || !url) throw new Error(words ?? `the ${endpoints.hosted ? 'server' : 'dev server'} answered ${response.status}`);
  return { url, token: answer.token, remy: typeof answer.remy === 'string' ? answer.remy : null };
}

/** Whether a call is going on the project, and who is on it; null when nobody could say. */
export async function requestRoom(endpoints: CallEndpoints, projectId: string, fetcher: Fetch = (input, init) => fetch(input, init)): Promise<RoomNews | null> {
  try {
    const response = await fetcher(endpoints.roomUrl(projectId), { headers: await endpoints.headers() });
    if (!response.ok) return null;
    const answer = (await response.json()) as Partial<RoomNews> & { minutes?: unknown };
    const minutes = roomMinutesOf(answer.minutes);
    return {
      up: answer.up === true,
      people: Array.isArray(answer.people) ? answer.people.filter((name): name is string => typeof name === 'string') : [],
      remy: answer.remy === true,
      ...(minutes ? { minutes } : {}),
    };
  } catch {
    return null;
  }
}
