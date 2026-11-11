/**
 * When the call ends, as the call session reads it: from Remy's `remy.ends_at` attribute, the same moment for every tab,
 * however late it joined; gone when she leaves; corrected when this tab's clock is minutes off the call server's. A
 * stand-in for livekit-client plays the room.
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

    constructor(identity: string) {
      this.identity = identity;
    }
  }

  class Room {
    static made: Room[] = [];
    /** The call server's clock when it lets this tab in; set before connecting. */
    static serverJoinedAtMs: number | null = null;
    name = 'project-test';
    localParticipant = new Participant('');
    remoteParticipants = new Map<string, Participant>();
    canPlaybackAudio = true;
    #listeners = new Map<string, Listener[]>();

    constructor() {
      Room.made.push(this);
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
      if (Room.serverJoinedAtMs !== null) this.localParticipant.participantInfo = { joinedAtMs: Room.serverJoinedAtMs };
      this.emit('signalConnected');
    }

    async startAudio(): Promise<void> {}

    async disconnect(): Promise<void> {}

    removeAllListeners(): void {
      this.#listeners.clear();
    }

    /** Someone joins the room. */
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
  DisconnectReason: { ROOM_DELETED: 5, SERVER_SHUTDOWN: 2, DUPLICATE_IDENTITY: 1 },
  Track: { Kind: { Audio: 'audio' } },
}));

import { CallSession } from '../../src/call/session';

const NOW = 1_794_081_000_000;

function remy(attributes: Record<string, string>) {
  const participant = new lk.Participant('remy');
  participant.isAgent = true;
  participant.attributes = { 'lk.agent.state': 'listening', ...attributes };
  return participant;
}

async function joined(): Promise<{ session: CallSession; room: InstanceType<typeof lk.Room> }> {
  const session = new CallSession({ me: 'me', fetchToken: async () => ({ url: 'ws://call.test', token: 'token' }) });
  await session.join({ mic: false });
  return { session, room: lk.Room.made.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  lk.Room.made = [];
  lk.Room.serverJoinedAtMs = null;
});
afterEach(() => vi.useRealTimers());

describe('when the call ends', () => {
  it('is the moment Remy’s worker set, on every tab, the ones that join later too', async () => {
    const first = await joined();
    expect(first.session.snapshot.endsAt).toBeNull();
    const her = remy({});
    first.room.join(her);
    expect(first.session.snapshot.remy).toBe('listening');
    expect(first.session.snapshot.endsAt).toBeNull();
    first.room.setAttributes(her, { 'remy.ends_at': String(NOW + 300_000) });
    expect(first.session.snapshot.endsAt).toBe(NOW + 300_000);

    // A minute later someone else joins: Remy is already in the room, with her attribute.
    vi.setSystemTime(NOW + 60_000);
    const second = await joined();
    second.room.join(remy({ 'remy.ends_at': String(NOW + 300_000) }));
    expect(second.session.snapshot.endsAt).toBe(NOW + 300_000);
  });

  it('is none on a call without a limit, and goes with Remy when she leaves', async () => {
    const { session, room } = await joined();
    room.join(remy({}));
    expect(session.snapshot.endsAt).toBeNull();
    room.setAttributes(room.remoteParticipants.get('remy')!, { 'remy.ends_at': String(NOW + 300_000) });
    expect(session.snapshot.endsAt).toBe(NOW + 300_000);
    room.leave('remy');
    expect(session.snapshot.remy).toBeNull();
    expect(session.snapshot.endsAt).toBeNull();
  });

  it('is on this tab’s clock when it is minutes off the call server’s', async () => {
    // The server lets this tab in at what its clock calls NOW + 3 min: this tab's clock is three minutes slow.
    lk.Room.serverJoinedAtMs = NOW + 180_000;
    const { session, room } = await joined();
    room.join(remy({ 'remy.ends_at': String(NOW + 180_000 + 300_000) }));
    expect(session.snapshot.endsAt).toBe(NOW + 300_000);
  });

  it('takes this tab’s clock as it is when it agrees with the server’s to within the join’s delay', async () => {
    lk.Room.serverJoinedAtMs = NOW - 600;
    const { session, room } = await joined();
    room.join(remy({ 'remy.ends_at': String(NOW + 300_000) }));
    expect(session.snapshot.endsAt).toBe(NOW + 300_000);
  });

  it('is forgotten when this tab leaves', async () => {
    const { session, room } = await joined();
    room.join(remy({ 'remy.ends_at': String(NOW + 300_000) }));
    await session.leave();
    expect(session.snapshot.endsAt).toBeNull();
  });
});
