/**
 * The project's call, framework-free, like the presence session: a class that owns the LiveKit room and
 * keeps a snapshot of it (who is on the call, who is speaking, whether they are muted, Remy's state and
 * the live captions) that React reads with useSyncExternalStore.
 *
 * livekit-client is loaded with import() on joining, so the page carries none of it until someone joins.
 * The call is optional by construction: nothing else in the page depends on it, every failure lands in
 * the snapshot with a plain message, and leaving or failing tears everything down.
 *
 * Remy's side of it: `hear()` waits for a line Remy's ears heard, and `say()` hands Remy a line to say
 * (the host's tab only) and resolves once it has been played.
 */
import type { Participant, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, TextStreamReader } from 'livekit-client';
import { TrackLevels } from './levels';
import { endsAtOf, heardMatches, REMY, messageOf, SAY, sayPayload, sayReplyOf, TOPIC, type Heard, type HeardMatcher, type LineProof, type RemyMessage, type RemyState } from './protocol';
import { speakable, voiceParts } from './speech';
import { clockOffsetOf, localEndsAt } from './time-left';
import { hostOf, humansOf, personFrom, type CallPerson, type CallStatus } from './view';

type LiveKit = typeof import('livekit-client');

/** off: not publishing · starting · on · muted · blocked: permission denied · missing: no device · error */
export type MicState = 'off' | 'starting' | 'on' | 'muted' | 'blocked' | 'missing' | 'error';

/** What Remy is doing on the call: joining until her worker says otherwise. */
export type RemyDoing = 'joining' | 'idle' | RemyState;

/** A line of live captions: someone's words as they are transcribed, Remy's as they are said. */
export interface Caption {
  segmentId: string;
  identity: string;
  text: string;
  final: boolean;
  at: number;
}

export interface CallSnapshot {
  status: CallStatus;
  /** Plain words about a failed join or a lost call. */
  error: string | null;
  mic: MicState;
  micError: string | null;
  /** This tab's identity on the call: its presence session id. */
  me: string;
  people: readonly CallPerson[];
  /** Remy's state while she is on the call; null when she isn't. */
  remy: RemyDoing | null;
  /**
   * Remy is in the room but not there for anyone: on her way out (`remy.leaving`), with no state to show REMY_STATE_WAIT_MS
   * after she and this tab were both on the call (or after she was called again), or she turned a line down as not
   * ready. The call bar offers to call her again.
   */
  remyStuck: boolean;
  /** Who hosts the call: their tab hands Remy her lines and moves her cursor. */
  host: string | null;
  captions: readonly Caption[];
  /** The browser kept the sound off; a press on "Turn on sound" lets it play. */
  audioBlocked: boolean;
  /**
   * When the call ends, in ms since the epoch on this tab's clock: Remy's worker says when (the hosted site's calls have
   * a time limit). Null while she isn't on the call, and on a call without a limit.
   */
  endsAt: number | null;
}

export interface CallToken {
  url: string;
  token: string;
  /** What the token route did about Remy: present, starting, dispatched, on-create or unavailable. */
  remy?: string | null;
}

export interface CallSessionOptions {
  /** This tab's presence session id, its identity on the call. */
  me: string;
  /** Asks the dev server for a token (throws with plain words when it refuses); `remy: false` joins without her. */
  fetchToken(options?: { remy?: boolean }): Promise<CallToken>;
  /** The longest line Remy's worker takes (the hosted site's: HOSTED_LINE_CHARS); longer lines go in parts. */
  maxLineChars?: number;
}

/** A line this tab handed Remy: when it was handed over, and when it had been played (cut short or not). */
export type SayEvent = { kind: 'start'; id: string; text: string; to: string | null } | { kind: 'end'; id: string; interrupted: boolean } | { kind: 'refused'; id: string; error: string };

/** One thing that happened on the call, kept for whoever checks the call afterwards. */
export interface CallEvent {
  at: number;
  event: string;
  data: Record<string, unknown>;
}

const TRANSCRIPTION = 'lk.transcription';
const AGENT_STATE = 'lk.agent.state';
/** Remy's worker sets it as she starts leaving (her worker's messages.ts). */
const LEAVING = 'remy.leaving';
/** How long Remy has to show a state of hers, once she and this tab are both on the call, before she counts as stuck. */
export const REMY_STATE_WAIT_MS = 6000;
const MAX_CAPTIONS = 6;
const MAX_EVENTS = 300;
const KEPT_HEARD = 30;

const INITIAL = (me: string): CallSnapshot => ({ status: 'idle', error: null, mic: 'off', micError: null, me, people: [], remy: null, remyStuck: false, host: null, captions: [], audioBlocked: false, endsAt: null });

const messageOfError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function abortError(): Error {
  return typeof DOMException === 'function' ? new DOMException('The wait was stopped', 'AbortError') : new Error('The wait was stopped');
}

/** When someone joined, to the millisecond when LiveKit says so (its `joinedAt` is in whole seconds). */
function joinedAtOf(participant: Participant): number {
  const info = (participant as unknown as { participantInfo?: { joinedAtMs?: bigint | number } }).participantInfo;
  const ms = Number(info?.joinedAtMs ?? 0);
  return ms > 0 ? ms : (participant.joinedAt?.getTime() ?? 0);
}

interface HeardWaiter {
  identity: string | null;
  matcher: HeardMatcher;
  resolve(line: Heard): void;
}

export class CallSession {
  private lk: LiveKit | null = null;
  private room: Room | null = null;
  private state: CallSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: RemyMessage, from: string | null) => void>();
  private readonly captionListeners = new Set<(caption: Caption) => void>();
  private readonly sayListeners = new Set<(event: SayEvent) => void>();
  private readonly audioElements = new Map<string, HTMLMediaElement>();
  private captionsById = new Map<string, Caption>();
  private readonly heardWaiters = new Set<HeardWaiter>();
  private readonly saidWaiters = new Map<string, (interrupted: boolean) => void>();
  private recentHeard: { line: Heard; receivedAt: number }[] = [];
  /** Remy's state as last told, by message or by her `lk.agent.state` attribute, whichever came last. */
  private remyState: RemyDoing = 'joining';
  private remyAttribute: string | undefined;
  /** When this tab began waiting for Remy to show a state: she arrived on its call, or was called again. 0: not waiting. */
  private remyWaitFrom = 0;
  /** She turned a line down as not ready: she is on her way out. */
  private remyNotReady = false;
  private remyTimer: ReturnType<typeof setTimeout> | null = null;
  /** How far the call server's clock is ahead of this tab's, when it is seconds off (time-left.ts); 0 otherwise. */
  private clockOffset = 0;
  /** Counts joins and leaves: a join still on its way when someone leaves stops where it is. */
  private attempt = 0;
  readonly levels = new TrackLevels();
  readonly events: CallEvent[] = [];
  private readonly options: CallSessionOptions;

  constructor(options: CallSessionOptions) {
    this.options = options;
    this.state = INITIAL(options.me);
  }

  get snapshot(): CallSnapshot {
    return this.state;
  }

  get me(): string {
    return this.options.me;
  }

  /** Connected to the call, or getting back to it. */
  get inCall(): boolean {
    return this.state.status === 'connected' || this.state.status === 'reconnecting';
  }

  get isHost(): boolean {
    return this.inCall && this.state.host === this.options.me;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Hears every message from Remy's worker (the sender's identity with it). */
  onMessage(listener: (message: RemyMessage, from: string | null) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** Hears every caption as it grows. */
  onCaption(listener: (caption: Caption) => void): () => void {
    this.captionListeners.add(listener);
    return () => {
      this.captionListeners.delete(listener);
    };
  }

  /** Hears every line this tab hands Remy: handed over, then played (or refused). */
  onSay(listener: (event: SayEvent) => void): () => void {
    this.sayListeners.add(listener);
    return () => {
      this.sayListeners.delete(listener);
    };
  }

  private emitSay(event: SayEvent): void {
    for (const listener of [...this.sayListeners]) listener(event);
  }

  /** Whether anyone but Remy is making a sound now: their voice as this tab hears it, or the server's word. */
  peopleTalking(): boolean {
    return this.state.people.some((person) => !person.isRemy && (person.speaking || this.level(person.identity) > 0.04));
  }

  /** How loud someone on the call is now, 0 to 1: their track as this tab hears it (0 while muted). */
  level(identity: string): number {
    const person = this.state.people.find((candidate) => candidate.identity === identity);
    if (!person || (!person.isRemy && !person.micOn)) return 0;
    if (this.levels.has(identity)) return this.levels.level(identity);
    const participant = this.participant(identity);
    return participant?.isSpeaking ? Math.min(1, participant.audioLevel * 4) : 0;
  }

  private set(patch: Partial<CallSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Keeps one thing that happened on the call, for whoever checks the call afterwards. */
  record(event: string, data: Record<string, unknown> = {}): void {
    const entry = { at: Date.now(), event, data };
    this.events.push(entry);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  private participant(identity: string): Participant | undefined {
    const room = this.room;
    if (!room) return undefined;
    return identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity);
  }

  /**
   * Joins the call. Run it from a press, so the browser lets the call's sound play. `remy: false` joins without
   * bringing her (people talk first, then call her in with callRemy()).
   */
  async join({ mic = true, remy = true }: { mic?: boolean; remy?: boolean } = {}): Promise<void> {
    if (this.room || this.state.status === 'joining') return;
    const attempt = ++this.attempt;
    this.set({ ...INITIAL(this.options.me), status: 'joining' });
    this.levels.resume();
    const started = performance.now();
    let token: CallToken;
    try {
      [this.lk, token] = await Promise.all([this.lk ?? import('livekit-client'), this.options.fetchToken({ remy })]);
    } catch (error) {
      if (attempt !== this.attempt) return;
      this.set({ status: 'failed', error: `The call isn't available: ${messageOfError(error)}` });
      this.record('join_failed', { stage: 'token', error: messageOfError(error) });
      return;
    }
    if (attempt !== this.attempt) return;
    const lk = this.lk;
    const room = new lk.Room({ disconnectOnPageLeave: true });
    this.room = room;
    this.remyState = 'joining';
    this.remyAttribute = undefined;
    this.clockOffset = 0;
    this.wire(lk, room);
    try {
      await room.connect(token.url, token.token, { autoSubscribe: true });
    } catch (error) {
      // Left while joining: nothing failed.
      if (this.room !== room) return;
      this.room = null;
      room.removeAllListeners();
      await room.disconnect().catch(() => undefined);
      this.set({ status: 'failed', error: `The call server can't be reached. The plan still works. (${messageOfError(error)})` });
      this.record('join_failed', { stage: 'connect', error: messageOfError(error) });
      return;
    }
    if (this.room !== room) {
      await room.disconnect().catch(() => undefined);
      return;
    }
    await room.startAudio().catch(() => undefined);
    this.set({ status: 'connected', audioBlocked: !room.canPlaybackAudio });
    this.record('joined', { identity: room.localParticipant.identity, room: room.name, ms: Math.round(performance.now() - started), remy: token.remy ?? null });
    this.refreshPeople();
    if (mic) await this.setMic(true);
  }

  async leave(): Promise<void> {
    this.attempt += 1;
    const room = this.room;
    this.room = null;
    if (room) await room.disconnect().catch(() => undefined);
    this.teardown();
    this.set(INITIAL(this.options.me));
    if (room) this.record('left');
  }

  /** Turns your microphone on or off. A refusal leaves you on the call as a listener. */
  async setMic(on: boolean): Promise<void> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    if (!on) {
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      this.set({ mic: 'muted', micError: null });
      this.refreshPeople();
      return;
    }
    this.set({ mic: 'starting', micError: null });
    try {
      // Remy's ears transcribe microphone tracks only. DTX off, a music preset and RED keep the voice close to what was said.
      const publication = await room.localParticipant.setMicrophoneEnabled(true, undefined, { dtx: false, red: true, audioPreset: lk.AudioPresets.musicHighQuality });
      const track = publication?.track?.mediaStreamTrack;
      if (track) this.levels.watch(room.localParticipant.identity, track);
      this.set({ mic: 'on' });
      this.record('mic_on', { trackSid: publication?.trackSid ?? null });
    } catch (error) {
      const failure = lk.MediaDeviceFailure.getFailure(error);
      const mic: MicState = failure === lk.MediaDeviceFailure.PermissionDenied ? 'blocked' : failure === lk.MediaDeviceFailure.NotFound ? 'missing' : 'error';
      const micError =
        mic === 'blocked'
          ? 'Your microphone is blocked. You can still listen; allow it from the address bar to talk.'
          : mic === 'missing'
            ? 'No microphone was found. You can still listen.'
            : `Your microphone didn't start (${messageOfError(error)}). You can still listen.`;
      this.set({ mic, micError });
      this.record('mic_failed', { mic, error: messageOfError(error) });
    }
    this.refreshPeople();
  }

  /** For "Turn on sound", when the browser kept the call's sound off. */
  async enableAudio(): Promise<void> {
    this.levels.resume();
    await this.room?.startAudio().catch(() => undefined);
    this.set({ audioBlocked: !(this.room?.canPlaybackAudio ?? true) });
  }

  /**
   * Remy isn't on the call, or is stuck on it: ask the token route again, which sends her to a room she isn't in (or in
   * which she is leaving or stuck). She has REMY_STATE_WAIT_MS again to show a state before the call bar offers this again.
   */
  async callRemy(): Promise<string | null> {
    this.remyNotReady = false;
    if (this.remyWaitFrom !== 0) this.remyWaitFrom = Date.now();
    this.clearRemyTimer();
    this.refreshPeople();
    try {
      const token = await this.options.fetchToken({ remy: true });
      this.record('remy_called', { remy: token.remy ?? null });
      return token.remy ?? null;
    } catch (error) {
      this.record('remy_call_failed', { error: messageOfError(error) });
      return null;
    }
  }

  /**
   * Waits for a final line Remy's ears heard: from `identity` (anyone when null), matching `matcher` (words
   * in it, a pattern, or a test). With `since` (ms since the epoch), a line heard from then on that already
   * came in counts too.
   */
  hear(identity: string | null, matcher: HeardMatcher = () => true, { signal, since, timeoutMs }: { signal?: AbortSignal; since?: number; timeoutMs?: number } = {}): Promise<Heard> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (since !== undefined) {
      const already = this.recentHeard.find(({ line, receivedAt }) => receivedAt >= since && heardMatches(line, identity, matcher));
      if (already) return Promise.resolve(already.line);
    }
    return new Promise<Heard>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        this.heardWaiters.delete(waiter);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: HeardWaiter = {
        identity,
        matcher,
        resolve: (line) => {
          done();
          resolve(line);
        },
      };
      const onAbort = () => {
        done();
        reject(abortError());
      };
      this.heardWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          done();
          reject(new Error('Nothing like that was heard on the call'));
        }, timeoutMs);
      }
    });
  }

  /**
   * Hands Remy a line to say, as written for speech (speakable()), and resolves once it has been played,
   * cut short or not. `to`: whose words it answers, so their next words count as said to Remy. `proof`: the
   * service's signature on the reply the line is part of, which the hosted worker requires. Only the host's
   * tab speaks for Remy. With `maxLineChars` (the hosted site), a longer line goes in parts, one after the
   * other, until one is cut off.
   */
  async say(line: string, { signal, timeoutMs, to, proof }: { signal?: AbortSignal; timeoutMs?: number; to?: string | null; proof?: LineProof | null } = {}): Promise<{ id: string; interrupted: boolean }> {
    const room = this.room;
    if (!room || this.state.status !== 'connected') throw new Error('Not on the call');
    if (!this.isHost) throw new Error('Only the call’s host speaks for Remy');
    if (!room.remoteParticipants.get(REMY)) throw new Error('Remy is not on the call');
    if (signal?.aborted) throw abortError();
    const max = this.options.maxLineChars;
    const parts = max ? voiceParts(line, max) : [line];
    let said: { id: string; interrupted: boolean } = { id: crypto.randomUUID(), interrupted: false };
    for (const part of parts) {
      said = await this.sayPart(room, part, { signal, timeoutMs, to, proof });
      if (said.interrupted) break;
    }
    return said;
  }

  private async sayPart(room: Room, line: string, { signal, timeoutMs, to, proof }: { signal?: AbortSignal; timeoutMs?: number; to?: string | null; proof?: LineProof | null }): Promise<{ id: string; interrupted: boolean }> {
    const words = speakable(line);
    const id = crypto.randomUUID();
    if (!words) return { id, interrupted: false };
    // Waiting before asking: a short line can finish before the answer to the asking arrives.
    let settle: (interrupted: boolean) => void = () => undefined;
    const played = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.saidWaiters.set(id, (interrupted) => settle(interrupted));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => settle(true);
    try {
      // The part as the reply has it: a signed line is said as the service wrote it, written for her voice by her worker.
      const payload = sayPayload(id, words, to, proof ? { ...proof, part: line.replace(/\s+/g, ' ').trim() } : null);
      const answer = sayReplyOf(await room.localParticipant.performRpc({ destinationIdentity: REMY, method: SAY, payload, responseTimeout: 5000 }).catch((error: unknown) => {
        this.emitSay({ kind: 'refused', id, error: messageOfError(error) });
        throw error;
      }));
      if (!answer?.accepted) {
        this.emitSay({ kind: 'refused', id, error: answer?.reason ?? 'not accepted' });
        this.record('say_refused', { id, reason: answer?.reason ?? null });
        // She is on her way out: the call bar offers to call her again.
        if (answer?.reason === 'not ready') this.remyNotReadyNow();
        throw new Error('Remy didn’t take the line');
      }
      this.record('say', { id, chars: words.length });
      this.emitSay({ kind: 'start', id, text: words, to: to ?? null });
      signal?.addEventListener('abort', stop, { once: true });
      const limit = timeoutMs ?? 20_000 + words.length * 120;
      const lost = new Promise<'lost'>((resolve) => {
        timer = setTimeout(() => resolve('lost'), limit);
      });
      const outcome = await Promise.race([played, lost]);
      if (outcome === 'lost') {
        this.emitSay({ kind: 'end', id, interrupted: true });
        throw new Error('Remy never finished the line');
      }
      this.emitSay({ kind: 'end', id, interrupted: outcome });
      if (signal?.aborted) throw abortError();
      this.record('said', { id, interrupted: outcome });
      return { id, interrupted: outcome };
    } finally {
      this.saidWaiters.delete(id);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }

  private wire(lk: LiveKit, room: Room): void {
    const { RoomEvent, ConnectionState, DisconnectReason } = lk;
    room
      .on(RoomEvent.ParticipantConnected, (participant) => {
        this.record('participant_connected', { identity: participant.identity, name: participant.name ?? null });
        this.refreshPeople();
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        this.record('participant_disconnected', { identity: participant.identity });
        if (participant.identity === REMY) this.remyGone();
        this.refreshPeople();
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.onTrackSubscribed(lk, track, publication, participant))
      .on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        for (const element of track.detach()) element.remove();
        this.audioElements.delete(track.sid ?? '');
        this.levels.unwatch(participant.identity);
        this.refreshPeople();
      })
      .on(RoomEvent.TrackMuted, () => this.refreshPeople())
      .on(RoomEvent.TrackUnmuted, () => this.refreshPeople())
      .on(RoomEvent.LocalTrackPublished, () => this.refreshPeople())
      .on(RoomEvent.LocalTrackUnpublished, () => this.refreshPeople())
      .on(RoomEvent.ActiveSpeakersChanged, () => this.refreshPeople())
      .on(RoomEvent.ParticipantAttributesChanged, () => this.refreshPeople())
      // The server's answer to the join says when it let this tab in, by its clock: how far off this tab's clock is.
      .on(RoomEvent.SignalConnected, () => {
        this.clockOffset = clockOffsetOf(joinedAtOf(room.localParticipant), Date.now());
        if (this.clockOffset !== 0) this.record('clock_offset', { ms: this.clockOffset });
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.set({ audioBlocked: !room.canPlaybackAudio }))
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        this.record('connection_state', { state });
        if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) this.set({ status: 'reconnecting' });
        if (state === ConnectionState.Connected && this.state.status === 'reconnecting') this.set({ status: 'connected' });
      })
      .on(RoomEvent.Disconnected, (reason) => {
        // Our own leave() let go of the room first.
        if (this.room !== room) return;
        this.room = null;
        this.teardown();
        // A deleted room is how a call ends: the hosted call's time limit, or Remy leaving after a quiet minute. Being
        // taken off it is too (the hosted site's time on a call, or a visit that ended). Neither is a failure: back to
        // ready, so the next press of Call Remy starts a new call.
        if (reason === DisconnectReason.ROOM_DELETED || (reason !== undefined && reason === DisconnectReason.PARTICIPANT_REMOVED)) {
          this.set({ ...INITIAL(this.options.me) });
          this.record('disconnected', { reason });
          return;
        }
        const why = reason === DisconnectReason.SERVER_SHUTDOWN ? 'the call server stopped' : reason === DisconnectReason.DUPLICATE_IDENTITY ? 'this tab joined somewhere else' : 'the connection was lost';
        this.set({ ...INITIAL(this.options.me), status: 'failed', error: `The call ended: ${why}. The plan still works.` });
        this.record('disconnected', { reason: reason ?? null });
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== TOPIC) return;
        const message = messageOf(payload);
        if (!message) {
          this.record('message_unreadable', { from: participant?.identity ?? null });
          return;
        }
        this.onRemyMessage(message, participant?.identity ?? null);
      });
    room.registerTextStreamHandler(TRANSCRIPTION, (reader, from) => void this.onTranscription(room, reader, from.identity));
  }

  private onRemyMessage(message: RemyMessage, from: string | null): void {
    // Anyone on the call can send on Remy's topic; only Remy's word moves her state or ends her lines.
    const fromRemy = from === REMY;
    switch (message.kind) {
      case 'heard':
        if (!fromRemy) break;
        this.record('heard', { identity: message.identity, addressed: message.addressed, text: message.text });
        this.recentHeard = [...this.recentHeard, { line: message, receivedAt: Date.now() }].slice(-KEPT_HEARD);
        for (const waiter of [...this.heardWaiters]) if (heardMatches(message, waiter.identity, waiter.matcher)) waiter.resolve(message);
        break;
      case 'state':
        if (!fromRemy) break;
        this.setRemyState(message.state);
        break;
      case 'said':
        if (!fromRemy) break;
        this.saidWaiters.get(message.id)?.(message.interrupted);
        break;
      case 'filler':
        if (fromRemy) this.record('filler', { text: message.text });
        break;
    }
    if (!fromRemy) this.record('message_ignored', { from, kind: message.kind });
    for (const listener of [...this.messageListeners]) listener(message, from);
  }

  private setRemyState(state: RemyDoing): void {
    if (state === this.remyState) return;
    this.remyState = state;
    if (this.state.remy !== null) this.set({ remy: state, remyStuck: this.remyStuckNow(this.room?.remoteParticipants.get(REMY)?.attributes) });
  }

  /** Remy left: whatever she was saying for us ended with her. */
  private remyGone(): void {
    for (const settle of [...this.saidWaiters.values()]) settle(true);
    this.remyState = 'joining';
    this.remyAttribute = undefined;
    this.forgetRemyWait();
  }

  /** She turned a line down as not ready: she is leaving, and the call bar offers to call her again. */
  private remyNotReadyNow(): void {
    if (this.remyNotReady) return;
    this.remyNotReady = true;
    this.record('remy_not_ready');
    this.refreshPeople();
  }

  /**
   * Whether Remy, in the room with these attributes, is stuck: leaving, turned a line down as not ready, or with no state
   * REMY_STATE_WAIT_MS after this tab began waiting. Until then, a check is set for when it is due.
   */
  private remyStuckNow(attributes: Readonly<Record<string, string>> | undefined): boolean {
    if (attributes?.[LEAVING] === '1' || this.remyNotReady) return true;
    if (this.remyState !== 'joining' || this.remyWaitFrom === 0) {
      this.clearRemyTimer();
      return false;
    }
    const due = this.remyWaitFrom + REMY_STATE_WAIT_MS;
    const left = due - Date.now();
    if (left <= 0) return true;
    if (!this.remyTimer)
      this.remyTimer = setTimeout(() => {
        this.remyTimer = null;
        this.refreshPeople();
      }, left);
    return false;
  }

  private clearRemyTimer(): void {
    if (this.remyTimer) clearTimeout(this.remyTimer);
    this.remyTimer = null;
  }

  private forgetRemyWait(): void {
    this.remyWaitFrom = 0;
    this.remyNotReady = false;
    this.clearRemyTimer();
  }

  private onTrackSubscribed(lk: LiveKit, track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    if (track.kind !== lk.Track.Kind.Audio) return;
    const element = track.attach();
    element.dataset.callIdentity = participant.identity;
    element.hidden = true;
    document.body.appendChild(element);
    this.audioElements.set(track.sid ?? publication.trackSid, element);
    this.levels.watch(participant.identity, track.mediaStreamTrack);
    this.record('track_subscribed', { identity: participant.identity, source: publication.source, trackSid: publication.trackSid });
    this.refreshPeople();
  }

  /**
   * Live captions: Remy's worker sends each person's words (on their behalf, or as herself naming their
   * track), and her own as she says them. The speaker is whoever owns the track transcribed.
   */
  private async onTranscription(room: Room, reader: TextStreamReader, sender: string): Promise<void> {
    const attributes = reader.info.attributes ?? {};
    const segmentId = attributes['lk.segment_id'] ?? reader.info.id;
    const trackId = attributes['lk.transcribed_track_id'];
    const owner = trackId ? [room.localParticipant, ...room.remoteParticipants.values()].find((participant) => participant.trackPublications.has(trackId)) : undefined;
    // Only Remy captions someone else's track: anyone else doing it is putting words in their mouth.
    if (owner && owner.identity !== sender && sender !== REMY) {
      this.record('caption_rejected', { sender, owner: owner.identity });
      return;
    }
    const speaker = owner?.identity ?? sender;
    let words = '';
    try {
      for await (const chunk of reader) {
        words += chunk;
        this.upsertCaption({ segmentId, identity: speaker, text: words, final: false, at: Date.now() });
      }
    } catch (error) {
      this.record('caption_broken', { sender, error: messageOfError(error) });
    }
    this.upsertCaption({ segmentId, identity: speaker, text: words, final: attributes['lk.transcription_final'] === 'true', at: Date.now() });
  }

  private upsertCaption(caption: Caption): void {
    if (this.room === null) return;
    const before = this.captionsById.get(caption.segmentId);
    this.captionsById.set(caption.segmentId, before ? { ...caption, at: before.at } : caption);
    const ordered = [...this.captionsById.values()].sort((a, b) => a.at - b.at).slice(-MAX_CAPTIONS);
    this.captionsById = new Map(ordered.map((kept) => [kept.segmentId, kept]));
    this.set({ captions: ordered });
    for (const listener of [...this.captionListeners]) listener(caption);
  }

  private refreshPeople(): void {
    const room = this.room;
    if (!room || this.state.status === 'joining') return;
    const all: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    const people = all.map((participant) =>
      personFrom({
        identity: participant.identity,
        name: participant.name,
        attributes: participant.attributes,
        isAgent: participant.isAgent,
        isLocal: participant === room.localParticipant,
        isSpeaking: participant.isSpeaking,
        micOn: participant.isMicrophoneEnabled,
        joinedAt: joinedAtOf(participant),
      }),
    );
    const remy = room.remoteParticipants.get(REMY) ?? [...room.remoteParticipants.values()].find((participant) => participant.isAgent);
    if (remy) {
      // Her attribute moves her state only when it changes, so a newer message isn't undone by an older attribute.
      const attribute = remy.attributes[AGENT_STATE];
      if (attribute !== this.remyAttribute) {
        this.remyAttribute = attribute;
        if (attribute === 'listening' || attribute === 'thinking' || attribute === 'speaking' || attribute === 'idle') this.remyState = attribute;
        else if (attribute === 'initializing') this.remyState = 'joining';
      }
      // She and this tab are both on the call: she has a while to show a state.
      if (this.remyWaitFrom === 0) this.remyWaitFrom = Date.now();
    } else this.forgetRemyWait();
    const remyStuck = remy ? this.remyStuckNow(remy.attributes) : false;
    if (remyStuck && !this.state.remyStuck) this.record('remy_stuck', { state: this.remyState, leaving: remy?.attributes[LEAVING] === '1', notReady: this.remyNotReady });
    // When the call ends is hers to say: it goes with her when she leaves.
    const endsAt = localEndsAt(remy ? endsAtOf(remy.attributes) : null, this.clockOffset);
    this.set({ people, remy: remy ? this.remyState : null, remyStuck, host: hostOf(people), endsAt });
  }

  private teardown(): void {
    for (const element of this.audioElements.values()) element.remove();
    this.audioElements.clear();
    this.captionsById.clear();
    this.levels.close();
    this.recentHeard = [];
    for (const settle of [...this.saidWaiters.values()]) settle(true);
    this.remyState = 'joining';
    this.remyAttribute = undefined;
    this.forgetRemyWait();
  }

  /** Who is on the call, without Remy. */
  get humans(): CallPerson[] {
    return humansOf(this.state.people);
  }
}
