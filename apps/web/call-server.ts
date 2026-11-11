/**
 * The call's server side, shared by the dev server's routes (call-dev.ts) and the hosted site's functions (api/call/,
 * through call-hosted.ts): the token that joins a project's call, Remy sent to it, and who is on it. The page never
 * loads this file. The LiveKit server SDK is handed in, so the dev server still loads it only once it starts.
 */
import type * as LiveKit from 'livekit-server-sdk';
import { attributesOf, REMY, roomFor, type TokenRequest } from './src/call/protocol.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A token is for joining; once in, LiveKit keeps the connection's own token fresh. */
export const TOKEN_TTL = '15m';
/** Remy was sent this recently and is still on her way: don't send a second one. */
export const STARTING_GRACE_MS = 15_000;
/** A Remy on the call this long with no state of hers to show is stuck (her job hung): she counts as gone. */
export const REMY_STALE_MS = 15_000;
/** Remy's attributes: her state, as her voice session sets it, and her mark when she starts leaving (her worker's). */
export const AGENT_STATE_ATTRIBUTE = 'lk.agent.state';
export const LEAVING_ATTRIBUTE = 'remy.leaving';
const AGENT_KIND = 4; // ParticipantInfo.Kind.AGENT
const SHOWN_STATES = new Set(['listening', 'thinking', 'speaking', 'idle']);

/** The parts of livekit-server-sdk used here. */
export type LiveKitSdk = Pick<typeof LiveKit, 'AccessToken' | 'AgentDispatchClient' | 'RoomAgentDispatch' | 'RoomConfiguration' | 'RoomServiceClient' | 'TrackSource'>;

/** A participant as the call server lists it. */
export interface Person {
  identity: string;
  kind?: number;
  attributes?: Record<string, string>;
  name?: string;
  permission?: { hidden?: boolean };
  /** When they joined: in seconds (`joinedAt`), and in ms (`joinedAtMs`) from servers that say. */
  joinedAt?: bigint | number;
  joinedAtMs?: bigint | number;
}

/** A room as the call server lists it. */
export interface RoomInfo {
  name: string;
  numParticipants: number;
  /** When it was made, in ms; 0 when not known. */
  createdAtMs: number;
}

export const isRemy = (person: Person) => person.identity === REMY || person.kind === AGENT_KIND;
export const isOnScreen = (person: Person) => !person.permission?.hidden && !person.identity.startsWith('recorder-');

/** When someone joined, in ms since the epoch; 0 when the call server didn't say. */
export function joinedAtMsOf(person: Person): number {
  const ms = Number(person.joinedAtMs ?? 0);
  if (ms > 0) return ms;
  const seconds = Number(person.joinedAt ?? 0);
  return seconds > 0 ? seconds * 1000 : 0;
}

/**
 * Remy is in the room but not there for anyone: on her way out (`remy.leaving`), or with no state of hers to show
 * REMY_STALE_MS after she joined (a job that hung while starting, or one closing for a minute). She counts as gone, so
 * the next join sends her again; a new Remy joining as `remy` replaces the old one.
 */
export function remyGone(person: Person, now: number): boolean {
  if (person.attributes?.[LEAVING_ATTRIBUTE] === '1') return true;
  const state = person.attributes?.[AGENT_STATE_ATTRIBUTE];
  if (state && SHOWN_STATES.has(state)) return false;
  const joined = joinedAtMsOf(person);
  return joined > 0 && now - joined > REMY_STALE_MS;
}

/** Remy on the call, there for everyone. */
export const remyHere = (person: Person, now: number): boolean => isRemy(person) && !remyGone(person, now);

/** The call server's HTTP API, from its WebSocket address. */
export const httpUrl = (url: string) => url.replace(/^ws(s?):\/\//, 'http$1://');

/**
 * What bringing Remy to a room takes: nothing (she is `present`, or `starting`: sent a moment ago), the joining token's
 * own dispatch (`on-create`: there is no room yet, and the first join makes it), or a `dispatch` now.
 */
export type RemyNeed = 'present' | 'starting' | 'on-create' | 'dispatch';

/** Whether the call server answers, the names of the people on the project's call, and whether Remy is on it. */
export interface RoomNews {
  up: boolean;
  people: string[];
  remy: boolean;
}

/** What the screen says about a room's people: the names of those on screen, and whether Remy is there for them. */
export function newsOf(people: readonly Person[], now: number): RoomNews {
  const shown = people.filter(isOnScreen);
  return {
    up: true,
    people: shown.filter((person) => !isRemy(person)).map((person) => person.attributes?.name || person.name || 'Someone'),
    remy: shown.some((person) => remyHere(person, now)),
  };
}

/** What a room is made with when a hosted join creates it. */
export interface RoomLimits {
  maxParticipants: number;
  /** Seconds a new room stays open while nobody has joined it. */
  emptyTimeoutS: number;
}

export interface CallServerOptions {
  /** The call server's address (wss://…, or ws:// for a local one). */
  url: string;
  key: string;
  secret: string;
  /** How long the call server's API may take before it counts as down. */
  timeoutMs: number;
}

const dispatchMetadata = (projectId: string) => JSON.stringify({ projectId });
const notFound = (error: unknown) => (error as { status?: number }).status === 404;

export class CallServer {
  readonly url: string;
  readonly #sdk: LiveKitSdk;
  readonly #key: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #rooms: LiveKit.RoomServiceClient;
  readonly #dispatches: LiveKit.AgentDispatchClient;

  constructor(sdk: LiveKitSdk, { url, key, secret, timeoutMs }: CallServerOptions) {
    this.url = url;
    this.#sdk = sdk;
    this.#key = key;
    this.#secret = secret;
    this.#timeoutMs = timeoutMs;
    this.#rooms = new sdk.RoomServiceClient(httpUrl(url), key, secret);
    this.#dispatches = new sdk.AgentDispatchClient(httpUrl(url), key, secret);
  }

  /**
   * A token that joins `room` (the project's: roomFor) as the person in `request`, whose identity is their tab's presence
   * session id: it publishes the microphone only, subscribes, sends data, and carries name, color and role (and sim) as
   * attributes the person can't change. `remy` sends her worker when this join creates the room; `limits` are what that
   * new room is made with.
   */
  mint(request: TokenRequest, { remy, limits, room = roomFor(request.projectId) }: { remy: boolean; limits?: RoomLimits; room?: string }): Promise<string> {
    const { AccessToken, RoomAgentDispatch, RoomConfiguration, TrackSource } = this.#sdk;
    const token = new AccessToken(this.#key, this.#secret, { identity: request.sessionId, name: request.name, attributes: attributesOf(request), ttl: TOKEN_TTL });
    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: true,
      // Name, color and role are the token's: a tab can't rename itself on the call.
      canUpdateOwnMetadata: false,
    });
    if (remy || limits) {
      token.roomConfig = new RoomConfiguration({
        ...(limits ? { maxParticipants: limits.maxParticipants, emptyTimeout: limits.emptyTimeoutS } : {}),
        ...(remy ? { agents: [new RoomAgentDispatch({ agentName: REMY, metadata: dispatchMetadata(request.projectId) })] } : {}),
      });
    }
    return token.toJwt();
  }

  /** Every room on the call server. Throws when it doesn't answer. */
  async listRooms(): Promise<RoomInfo[]> {
    const rooms = await this.#timed(this.#rooms.listRooms());
    return rooms.map((room) => ({
      name: room.name,
      numParticipants: room.numParticipants,
      createdAtMs: Number(room.creationTimeMs ?? 0n) || Number(room.creationTime ?? 0n) * 1000,
    }));
  }

  /** Who is in a room now; null when there is no such room. Throws when the call server doesn't answer. */
  async listPeople(room: string): Promise<Person[] | null> {
    try {
      return (await this.#timed(this.#rooms.listParticipants(room))) as unknown as Person[];
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  /** Who is in the room now; null when there is no such room. Throws when the call server doesn't answer. */
  async peopleIn(room: string): Promise<Person[] | null> {
    const found = await this.#timed(this.#rooms.listRooms([room]));
    if (found.length === 0) return null;
    return this.listPeople(room);
  }

  /** Takes someone off a call (gone already: nothing to do). Throws when the call server doesn't answer. */
  async removePerson(room: string, identity: string): Promise<void> {
    try {
      await this.#timed(this.#rooms.removeParticipant(room, identity));
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  /** Ends a call for everyone in it (gone already: nothing to do). Throws when the call server doesn't answer. */
  async deleteRoom(room: string): Promise<void> {
    try {
      await this.#timed(this.#rooms.deleteRoom(room));
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  /** What bringing Remy to the room takes, given who is in it (null: no room). Throws when the call server doesn't answer. */
  async remyNeedIn(room: string, people: readonly Person[] | null, now = Date.now()): Promise<RemyNeed> {
    if (people === null) return 'on-create';
    if (people.some((person) => remyHere(person, now))) return 'present';
    const sent = await this.#timed(this.#dispatches.listDispatch(room));
    if (sent.some((dispatch) => dispatch.agentName === REMY && now - Number(dispatch.state?.createdAt ?? 0n) / 1e6 < STARTING_GRACE_MS)) return 'starting';
    return 'dispatch';
  }

  /** What bringing Remy to the room takes. Throws when the call server doesn't answer. */
  async remyNeed(room: string): Promise<RemyNeed> {
    return this.remyNeedIn(room, await this.peopleIn(room));
  }

  /** Sends Remy's worker to a room that is going without her. */
  async dispatchRemy(room: string, projectId: string): Promise<void> {
    await this.#timed(this.#dispatches.createDispatch(room, REMY, { metadata: dispatchMetadata(projectId) }));
  }

  /**
   * Remy, for a call that is going without her. A new room gets her from the token's own dispatch; a room that lost her
   * (her worker restarted, or wasn't running when the call started, or she is on her way out) gets a new one, unless one
   * was sent a moment ago and she is still on her way. Never fails: `unavailable` when the call server doesn't answer.
   */
  async ensureRemy(room: string, projectId: string): Promise<RemyNeed | 'dispatched' | 'unavailable'> {
    try {
      const need = await this.remyNeed(room);
      if (need !== 'dispatch') return need;
      await this.dispatchRemy(room, projectId);
      return 'dispatched';
    } catch {
      return 'unavailable';
    }
  }

  /** How many rooms have Remy in them now. Throws when the call server doesn't answer. */
  async callsWithRemy(): Promise<number> {
    const rooms = await this.#timed(this.#rooms.listRooms());
    const lists = await Promise.all(
      rooms
        .filter((room) => room.numParticipants > 0)
        // A room that closed since it was listed has nobody in it.
        .map(async (room) => (await this.listPeople(room.name)) ?? []),
    );
    return lists.filter((people) => people.some(isRemy)).length;
  }

  /** The people on a call and whether Remy is there; `up: false` when the call server doesn't answer. */
  async news(room: string): Promise<RoomNews> {
    try {
      return newsOf((await this.peopleIn(room)) ?? [], Date.now());
    } catch {
      return { up: false, people: [], remy: false };
    }
  }

  #timed<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The call server did not answer')), this.#timeoutMs);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }
}
