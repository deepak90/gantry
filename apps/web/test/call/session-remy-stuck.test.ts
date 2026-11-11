/**
 * A call that couldn't restart: Remy in the room but not there for anyone (on her way out, a job that hung with no
 * state, or one that turns lines down as not ready). The call session notices, so the call bar offers "Call Remy"
 * again instead of waiting on her; being taken off a call by the site is an ordinary end. A stand-in for
 * livekit-client plays the room.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lk = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class Participant {
    identity: string;
    name = '';
    attributes: Record<string, string> = {};
    isAgent = false;
    isSpeaking = false;
    isMicrophoneEnabled = false;
    audioLevel = 0;
    trackPublications = new Map<string, unknown>();
    participantInfo: { joinedAtMs: number } | undefined;
    joinedAt: Date | undefined;
    /** What Remy answers to `remy.say`. */
    static sayReply: Record<string, unknown> = { accepted: true };
    /** Whether her worker tells of each line taken that it has been played, and whether cut off. */
    static played: { interrupted: boolean } | null = null;
    rpcs: { method: string; payload: string }[] = [];
    room: Room | null = null;

    constructor(identity: string) {
      this.identity = identity;
    }

    async performRpc({ method, payload }: { method: string; payload: string }): Promise<string> {
      this.rpcs.push({ method, payload });
      const id = JSON.parse(payload).id;
      const played = Participant.played;
      if (played && Participant.sayReply.accepted) {
        queueMicrotask(() => this.room?.emit('dataReceived', new TextEncoder().encode(JSON.stringify({ kind: 'said', id, ...played })), { identity: 'remy' }, undefined, 'remy'));
      }
      return JSON.stringify({ id, ...Participant.sayReply });
    }
  }

  class Room {
    static made: Room[] = [];
    name = 'project-test';
    localParticipant = new Participant('');
    remoteParticipants = new Map<string, Participant>();
    canPlaybackAudio = true;
    #listeners = new Map<string, Listener[]>();

    constructor() {
      Room.made.push(this);
      this.localParticipant.room = this;
    }

    on(event: string, listener: Listener): this {
      this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.#listeners.get(event) ?? []) listener(...args);
    }

    registerTextStreamHandler(): void {}

    async connect(): Promise<void> {
      this.localParticipant.identity = 'me';
      this.localParticipant.participantInfo = { joinedAtMs: Date.now() };
      this.emit('signalConnected');
    }

    async startAudio(): Promise<void> {}

    async disconnect(): Promise<void> {}

    removeAllListeners(): void {
      this.#listeners.clear();
    }

    join(participant: Participant): void {
      this.remoteParticipants.set(participant.identity, participant);
      this.emit('participantConnected', participant);
    }

    leave(identity: string): void {
      const participant = this.remoteParticipants.get(identity);
      this.remoteParticipants.delete(identity);
      this.emit('participantDisconnected', participant);
    }

    setAttributes(participant: Participant, changed: Record<string, string>): void {
      participant.attributes = { ...participant.attributes, ...changed };
      this.emit('participantAttributesChanged', changed, participant);
    }
  }

  const RoomEvent = {
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    TrackMuted: 'trackMuted',
    TrackUnmuted: 'trackUnmuted',
    LocalTrackPublished: 'localTrackPublished',
    LocalTrackUnpublished: 'localTrackUnpublished',
    ActiveSpeakersChanged: 'activeSpeakersChanged',
    ParticipantAttributesChanged: 'participantAttributesChanged',
    SignalConnected: 'signalConnected',
    AudioPlaybackStatusChanged: 'audioPlaybackChanged',
    ConnectionStateChanged: 'connectionStateChanged',
    Disconnected: 'disconnected',
    DataReceived: 'dataReceived',
  };
  return { Room, Participant, RoomEvent };
});

vi.mock('livekit-client', () => ({
  Room: lk.Room,
  RoomEvent: lk.RoomEvent,
  ConnectionState: { Connected: 'connected', Reconnecting: 'reconnecting', SignalReconnecting: 'signalReconnecting' },
  DisconnectReason: { DUPLICATE_IDENTITY: 2, SERVER_SHUTDOWN: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 },
  Track: { Kind: { Audio: 'audio' } },
}));

import { CallSession, REMY_STATE_WAIT_MS } from '../../src/call/session';
import { speakable } from '../../src/call/speech';

const NOW = 1_794_400_000_000;
const PROOF = { turn: 'turn-4', whole: 'Sure. The crane is idle from Mon, Nov 30. It costs $1,200.00 a day. The steel is late. Pay Granite on Friday.', sig: 'a'.repeat(43) };

function remy(attributes: Record<string, string> = {}) {
  const participant = new lk.Participant('remy');
  participant.isAgent = true;
  participant.attributes = attributes;
  return participant;
}

/** A host's tab on the call: it joined first, so it speaks for Remy. */
async function joined(maxLineChars?: number) {
  const fetchToken = vi.fn(async () => ({ url: 'ws://call.test', token: 'token', remy: 'present' }));
  const session = new CallSession({ me: 'me', fetchToken, ...(maxLineChars ? { maxLineChars } : {}) });
  await session.join({ mic: false });
  return { session, room: lk.Room.made.at(-1)!, fetchToken };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  lk.Room.made = [];
  lk.Participant.sayReply = { accepted: true };
  lk.Participant.played = null;
});

describe('a line handed to Remy', () => {
  const requests = (room: InstanceType<typeof lk.Room>) => room.localParticipant.rpcs.map((rpc) => JSON.parse(rpc.payload) as { id: string; text: string; proof?: Record<string, string> });

  it('goes with the proof of the reply it is part of: its own words as the part, and the words for her voice', async () => {
    lk.Participant.played = { interrupted: false };
    const { session, room } = await joined();
    room.join(remy({ 'lk.agent.state': 'listening' }));
    await session.say('It costs $1,200.00 a day.', { proof: PROOF });
    const [request] = requests(room);
    expect(request).toMatchObject({ text: 'It costs $1,200 a day.', proof: { turn: 'turn-4', whole: PROOF.whole, part: 'It costs $1,200.00 a day.', sig: PROOF.sig } });
  });

  it('goes without one where there is none, as on the owner’s machine', async () => {
    lk.Participant.played = { interrupted: false };
    const { session, room } = await joined();
    room.join(remy({ 'lk.agent.state': 'listening' }));
    await session.say('Done.');
    expect(requests(room)[0]).not.toHaveProperty('proof');
  });

  it('goes in parts on the hosted site when longer than the worker takes, each part with the proof', async () => {
    lk.Participant.played = { interrupted: false };
    const { session, room } = await joined(40);
    room.join(remy({ 'lk.agent.state': 'listening' }));
    await session.say(PROOF.whole, { proof: PROOF });
    const sent = requests(room);
    expect(sent.length).toBeGreaterThan(2);
    for (const request of sent) {
      expect(request.text.length).toBeLessThanOrEqual(40);
      expect(request.text).toBe(speakable(request.proof!.part!));
      expect(PROOF.whole).toContain(request.proof!.part);
    }
    expect(sent.map((request) => request.proof!.part).join(' ')).toBe(PROOF.whole);
  });

  it('stops handing parts once one is cut off', async () => {
    lk.Participant.played = { interrupted: true };
    const { session, room } = await joined(40);
    room.join(remy({ 'lk.agent.state': 'listening' }));
    expect(await session.say(PROOF.whole, { proof: PROOF })).toMatchObject({ interrupted: true });
    expect(requests(room)).toHaveLength(1);
  });
});
afterEach(() => vi.useRealTimers());

describe('a Remy who is in the room but not there', () => {
  it('is fine while she shows a state', async () => {
    const { session, room } = await joined();
    room.join(remy({ 'lk.agent.state': 'listening' }));
    await vi.advanceTimersByTimeAsync(REMY_STATE_WAIT_MS * 3);
    expect(session.snapshot.remy).toBe('listening');
    expect(session.snapshot.remyStuck).toBe(false);
  });

  it('is stuck when she has shown no state six seconds after she came, counted from her arrival', async () => {
    const { session, room } = await joined();
    await vi.advanceTimersByTimeAsync(10_000);
    room.join(remy());
    expect(session.snapshot.remy).toBe('joining');
    await vi.advanceTimersByTimeAsync(REMY_STATE_WAIT_MS - 1);
    expect(session.snapshot.remyStuck).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(session.snapshot.remyStuck).toBe(true);
    // Her state comes after all: she is there.
    room.setAttributes(room.remoteParticipants.get('remy')!, { 'lk.agent.state': 'listening' });
    expect(session.snapshot.remyStuck).toBe(false);
  });

  it('is stuck at once when she marks herself leaving, and that passes when she has gone', async () => {
    const { session, room } = await joined();
    const her = remy({ 'lk.agent.state': 'listening' });
    room.join(her);
    room.setAttributes(her, { 'remy.leaving': '1' });
    expect(session.snapshot.remyStuck).toBe(true);
    room.leave('remy');
    expect(session.snapshot.remy).toBeNull();
    expect(session.snapshot.remyStuck).toBe(false);
  });

  it('is stuck once she turns a line down as not ready', async () => {
    const { session, room } = await joined();
    room.join(remy({ 'lk.agent.state': 'listening' }));
    expect(session.isHost).toBe(true);
    lk.Participant.sayReply = { accepted: false, reason: 'not ready' };
    await expect(session.say('The crane is idle.')).rejects.toThrow(/didn’t take the line/);
    expect(session.snapshot.remyStuck).toBe(true);
    expect(session.events.some((event) => event.event === 'say_refused' && event.data.reason === 'not ready')).toBe(true);
  });

  it('is not stuck for a line turned down for any other reason', async () => {
    const { session, room } = await joined();
    room.join(remy({ 'lk.agent.state': 'listening' }));
    lk.Participant.sayReply = { accepted: false, reason: 'too many lines' };
    await expect(session.say('The crane is idle.')).rejects.toThrow();
    expect(session.snapshot.remyStuck).toBe(false);
  });

  it('gets another six seconds when she is called again, and asks the token route to send her', async () => {
    const { session, room, fetchToken } = await joined();
    room.join(remy());
    await vi.advanceTimersByTimeAsync(REMY_STATE_WAIT_MS);
    expect(session.snapshot.remyStuck).toBe(true);
    await session.callRemy();
    expect(fetchToken).toHaveBeenLastCalledWith({ remy: true });
    expect(session.snapshot.remyStuck).toBe(false);
    await vi.advanceTimersByTimeAsync(REMY_STATE_WAIT_MS);
    expect(session.snapshot.remyStuck).toBe(true);
  });

  it('starts over with a new Remy who replaces the stuck one', async () => {
    const { session, room } = await joined();
    room.join(remy());
    await vi.advanceTimersByTimeAsync(REMY_STATE_WAIT_MS);
    expect(session.snapshot.remyStuck).toBe(true);
    room.leave('remy');
    room.join(remy({ 'lk.agent.state': 'listening' }));
    expect(session.snapshot.remy).toBe('listening');
    expect(session.snapshot.remyStuck).toBe(false);
  });
});

describe('being taken off the call by the site', () => {
  it('ends the call like any other end, ready for the next one, not as a failure', async () => {
    const { session, room } = await joined();
    room.emit('disconnected', 4);
    expect(session.snapshot.status).toBe('idle');
    expect(session.snapshot.error).toBeNull();
  });

  it('still says when the connection was lost', async () => {
    const { session, room } = await joined();
    room.emit('disconnected', 9);
    expect(session.snapshot.status).toBe('failed');
  });
});
