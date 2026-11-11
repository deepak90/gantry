/**
 * The one place Remy reaches into agents-js internals (pinned at @livekit/agents 1.9.3).
 *
 * 1. Several sessions in one room. `AgentSession.start({ room })` builds a RoomIO and a remote-session
 *    transport, and the transport claims the room's `lk.agent.session` byte-stream handler, so a
 *    second session in the same room throws ("A byte stream handler for topic "lk.agent.session" has
 *    already been set"). Remy's mouth starts first and keeps that ordinary path. Each ear (one
 *    session per person) gets a RoomIO built here (a public class) and set on the session's internal
 *    `_roomIO` before `start()`; `start()` then skips its own RoomIO and transport
 *    (agent_session.js `_startImpl`: `else if (room && !this._roomIO)`). This only works for a
 *    session without audio output: with audio out, `RoomIO.start()` reads the session's current
 *    agent, which throws until the session runs.
 * 2. Remy's state. Every RoomIO mirrors its own session's state into the `lk.agent.state` attribute.
 *    The ears' sessions are always "listening" and the mouth's is never "thinking", so the worker
 *    publishes Remy's state itself and switches that mirror off (RoomIO's private listener
 *    `onAgentStateChanged`).
 *
 * Re-check both on any agents-js upgrade: test/room-io.test.ts fails on another version.
 */
import { voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';

export const PINNED_AGENTS_VERSION = '1.9.3';

export interface RoomIOSetup {
  /** The person whose microphone this session hears; none for the mouth. */
  participant?: string | null;
  inputOptions: Partial<voice.RoomInputOptions>;
  outputOptions: Partial<voice.RoomOutputOptions>;
}

type StateListener = (event: voice.AgentStateChangedEvent) => void;

/** Builds and starts an ear's RoomIO (no audio output); call before `session.start({ room })`. */
export function attachRoomIO(session: voice.AgentSession, room: Room, setup: RoomIOSetup): voice.RoomIO {
  if (setup.outputOptions.audioEnabled) throw new Error('attachRoomIO is for sessions without audio output; start the mouth the ordinary way');
  const roomIO = new voice.RoomIO({
    agentSession: session,
    room,
    participant: setup.participant ?? null,
    inputOptions: setup.inputOptions,
    outputOptions: setup.outputOptions,
  });
  session._roomIO = roomIO;
  roomIO.start();
  if (!muteStateMirror(session, roomIO)) {
    throw new Error(`agents-js changed: RoomIO.onAgentStateChanged is gone (pinned ${PINNED_AGENTS_VERSION}); see room-io.ts`);
  }
  return roomIO;
}

/** After `session.start({ room })`: stops the RoomIO the session built from writing `lk.agent.state`. */
export function muteStartedSession(session: voice.AgentSession): void {
  const roomIO = session._roomIO;
  if (!roomIO || !muteStateMirror(session, roomIO)) {
    throw new Error(`agents-js changed: no RoomIO state mirror to switch off (pinned ${PINNED_AGENTS_VERSION}); see room-io.ts`);
  }
}

/** Stops this RoomIO from writing its session's state to `lk.agent.state`. False if the listener isn't there. */
export function muteStateMirror(session: voice.AgentSession, roomIO: voice.RoomIO): boolean {
  const listener = (roomIO as unknown as { onAgentStateChanged?: unknown }).onAgentStateChanged;
  if (typeof listener !== 'function') return false;
  session.off(voice.AgentSessionEventTypes.AgentStateChanged, listener as StateListener);
  return true;
}
