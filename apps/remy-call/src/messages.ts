/**
 * What Remy's worker and the app say to each other on the call. Data messages are JSON on topic
 * `remy` with reliable delivery, one object per message: `{ kind, ...body }`. The host's tab
 * hands Remy a line with the `remy.say` RPC, which answers at once; the end of playout comes
 * later as a `said` message, because the callee only ever gets a 1 s RPC timeout.
 */
import { z } from 'zod';

export const TOPIC = 'remy';
export const SAY_METHOD = 'remy.say';
export const STATE_ATTRIBUTE = 'lk.agent.state';
/**
 * Remy's attribute with the moment the call ends (ms since the epoch, by the worker's clock): set once she is ready,
 * on a call with a time limit (limits.ts). Attributes reach people who join later too, so every tab counts down to the
 * same moment. A call without a limit has none.
 */
export const ENDS_AT_ATTRIBUTE = 'remy.ends_at';
/**
 * Set to `1` the moment Remy starts leaving, before she is gone: the token route and the tabs count her as gone (she
 * takes no more lines), so the next call sends her again instead of waiting on one who is on her way out.
 */
export const LEAVING_ATTRIBUTE = 'remy.leaving';

const PROJECT_ROOM = /^project-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(\d{1,16}))?$/i;

/**
 * The project a call's room is for: `project-<id>` on a local run, `project-<id>-<lease>` on the hosted site,
 * which has one room per visit of a copy (the lease is when it was claimed, in ms). Null for any other room.
 */
export function projectOfRoom(name: string): string | null {
  return PROJECT_ROOM.exec(name)?.[1]?.toLowerCase() ?? null;
}

export const REMY_STATES = ['listening', 'thinking', 'speaking'] as const;
export type RemyState = (typeof REMY_STATES)[number];

/** A person's finished turn, as transcribed; `at` is when their speech ended (ms since the epoch). */
export const heardMessage = z.object({
  kind: z.literal('heard'),
  identity: z.string().min(1),
  text: z.string(),
  addressed: z.boolean(),
  final: z.literal(true),
  at: z.number(),
});
export const stateMessage = z.object({ kind: z.literal('state'), state: z.enum(REMY_STATES) });
/** Playout of a `remy.say` line ended, played out or cut off. */
export const saidMessage = z.object({ kind: z.literal('said'), id: z.string().min(1), interrupted: z.boolean() });
export const fillerMessage = z.object({ kind: z.literal('filler'), text: z.string().min(1) });

export const remyMessage = z.discriminatedUnion('kind', [heardMessage, stateMessage, saidMessage, fillerMessage]);
export type RemyMessage = z.infer<typeof remyMessage>;
export type HeardMessage = z.infer<typeof heardMessage>;

/**
 * A line's proof that the assistant service wrote it (line-proof.ts): the reply as signed, the part of it said, and the
 * signature. A stored reply is at most 4,000 characters, and the whole request stays under LiveKit's 15 KiB.
 */
export const lineProof = z.object({
  turn: z.string().min(1).max(64),
  whole: z.string().min(1).max(4000),
  part: z.string().min(1).max(4000),
  sig: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** `to`: the identity whose line this answers, when the host knows it. `proof`: who wrote it, on the hosted site. */
export const sayRequest = z.object({ id: z.string().min(1).max(128), text: z.string(), to: z.string().min(1).optional(), proof: lineProof.optional() });
export type SayRequest = z.infer<typeof sayRequest>;
export const sayResponse = z.object({ id: z.string(), accepted: z.boolean(), reason: z.string().optional() });
export type SayResponse = z.infer<typeof sayResponse>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeMessage(message: RemyMessage): Uint8Array {
  return encoder.encode(JSON.stringify(remyMessage.parse(message)));
}

/** Null for anything that isn't one of the messages above. */
export function decodeMessage(payload: Uint8Array): RemyMessage | null {
  try {
    const parsed = remyMessage.safeParse(JSON.parse(decoder.decode(payload)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type SayParse = { ok: true; request: SayRequest } | { ok: false; id: string | null; reason: string };

/** Reads a `remy.say` payload; a payload without a usable id can't be answered and is refused outright. */
export function parseSayRequest(payload: string): SayParse {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { ok: false, id: null, reason: 'payload is not JSON' };
  }
  const parsed = sayRequest.safeParse(raw);
  if (parsed.success) return { ok: true, request: parsed.data };
  const id = raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' && raw.id ? raw.id : null;
  return { ok: false, id, reason: 'expected { id, text, to?, proof? }' };
}
