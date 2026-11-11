/**
 * The smoke call's participants on @livekit/rtc-node:
 * - CallerBot: a person with a synthetic microphone (a -66 dBFS noise floor, clips played on cue),
 *   published as a microphone track with DTX off and RED on, like the app's mics. It listens to
 *   Remy only.
 * - Observer: a hidden recorder that subscribes to every track and keeps each track's level per
 *   10 ms, every `remy` message, attribute and caption.
 */
import { join } from 'node:path';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import { decodeMessage, TOPIC, type RemyMessage } from '../../src/messages.ts';
import { frameDb, writeWav } from './audio.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface Played {
  /** Wall time the first clip sample went into the source, plus what was queued ahead of it. */
  startAt: number;
  endAt: number;
}

export class CallerBot {
  readonly who: string;
  readonly identity: string;
  readonly room = new Room();
  #rate: number;
  #source: AudioSource;
  #clip: { samples: Int16Array; pos: number; startAt: number | null; done: (played: Played) => void } | null = null;
  #stopped = false;
  #pump: Promise<void> | null = null;

  constructor(who: string, identity: string, sampleRate = 24000) {
    this.who = who;
    this.identity = identity;
    this.#rate = sampleRate;
    this.#source = new AudioSource(sampleRate, 1, 100);
  }

  async join(url: string, token: string): Promise<void> {
    // Hear Remy, as a tab does. Remy's audio waits for a subscriber, and a hidden recorder's
    // subscription doesn't count.
    this.room.on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication, p: RemoteParticipant) => {
      if (p.identity === 'remy' && publication.kind === TrackKind.KIND_AUDIO) publication.setSubscribed(true);
    });
    await this.room.connect(url, token, { autoSubscribe: false, dynacast: false });
    for (const p of this.room.remoteParticipants.values()) {
      if (p.identity !== 'remy') continue;
      for (const publication of p.trackPublications.values()) if (publication.kind === TrackKind.KIND_AUDIO) publication.setSubscribed(true);
    }
    const track = LocalAudioTrack.createAudioTrack('microphone', this.#source);
    await this.room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, red: true }));
    this.#pump = this.#run();
  }

  /** Plays a clip into the microphone; resolves when its last sample has been sent. */
  play(samples: Int16Array): Promise<Played> {
    if (this.#clip) throw new Error(`${this.who} is already talking`);
    return new Promise((resolve) => {
      this.#clip = { samples, pos: 0, startAt: null, done: resolve };
    });
  }

  async #run(): Promise<void> {
    const n = this.#rate / 100;
    const startWall = Date.now();
    let sentMs = 0;
    while (!this.#stopped) {
      const data = new Int16Array(n);
      const clip = this.#clip;
      if (clip) {
        if (clip.startAt === null) clip.startAt = Date.now() + this.#source.queuedDuration;
        const chunk = clip.samples.subarray(clip.pos, clip.pos + n);
        data.set(chunk);
        for (let i = chunk.length; i < n; i++) data[i] = Math.round((Math.random() * 2 - 1) * 28);
        clip.pos += n;
        if (clip.pos >= clip.samples.length) {
          this.#clip = null;
          clip.done({ startAt: clip.startAt, endAt: Date.now() + this.#source.queuedDuration });
        }
      } else {
        for (let i = 0; i < n; i++) data[i] = Math.round((Math.random() * 2 - 1) * 28); // about -66 dBFS
      }
      await this.#source.captureFrame(new AudioFrame(data, this.#rate, 1, n));
      sentMs += 10;
      // Keep to real time whatever the source's queue does.
      const ahead = sentMs - (Date.now() - startWall);
      if (ahead > 60) await sleep(ahead - 40);
    }
  }

  async leave(): Promise<void> {
    this.#stopped = true;
    await this.#pump?.catch(() => undefined);
    await this.room.disconnect().catch(() => undefined);
    await this.#source.close().catch(() => undefined);
  }
}

export interface TrackRecording {
  identity: string;
  /** Wall time of the first sample. */
  firstAt: number;
  sampleRate: number;
  /** dBFS per 10 ms from firstAt */
  levels: number[];
  chunks: Int16Array[];
}

export interface Observed {
  t: number;
  type: 'message' | 'attributes' | 'caption' | 'joined' | 'left' | 'track';
  from: string | null;
  message?: RemyMessage;
  changed?: Record<string, string>;
  text?: string;
  final?: boolean;
}

export class Observer {
  readonly room = new Room();
  readonly tracks = new Map<string, TrackRecording>();
  readonly events: Observed[] = [];
  #waiters = new Set<() => void>();

  async join(url: string, token: string): Promise<void> {
    this.room
      .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => this.#push({ type: 'joined', from: p.identity, changed: { ...p.attributes } }))
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => this.#push({ type: 'left', from: p.identity }))
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        this.#push({ type: 'track', from: p.identity, text: String(pub.source) });
        void this.#record(track, p.identity);
      })
      .on(RoomEvent.ParticipantAttributesChanged, (changed: Record<string, string>, p) => this.#push({ type: 'attributes', from: p.identity, changed }))
      .on(RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        if (topic !== TOPIC) return;
        const message = decodeMessage(payload);
        if (message) this.#push({ type: 'message', from: p?.identity ?? null, message });
        else this.#push({ type: 'message', from: p?.identity ?? null, text: `UNPARSED ${new TextDecoder().decode(payload)}` });
      });
    this.room.registerTextStreamHandler('lk.transcription', (reader, info) => {
      void reader.readAll().then((text) => {
        const attrs = reader.info.attributes ?? {};
        this.#push({ type: 'caption', from: info.identity, text, final: attrs['lk.transcription_final'] === 'true' });
      });
    });
    await this.room.connect(url, token, { autoSubscribe: true, dynacast: false });
  }

  async #record(track: RemoteTrack, identity: string): Promise<void> {
    const sampleRate = 48000;
    const stream = new AudioStream(track, { sampleRate, numChannels: 1, frameSizeMs: 10 });
    let rec: TrackRecording | null = null;
    for await (const frame of stream) {
      if (!rec) {
        rec = { identity, firstAt: Date.now() - 10, sampleRate, levels: [], chunks: [] };
        this.tracks.set(identity, rec);
      }
      rec.chunks.push(frame.data.slice());
      rec.levels.push(frameDb(frame.data));
    }
  }

  #push(event: Omit<Observed, 't'>): void {
    this.events.push({ t: Date.now(), ...event });
    for (const waiter of this.#waiters) waiter();
  }

  /** The first event from index `from` on that matches, or null after `ms`. */
  waitFor(pred: (event: Observed) => boolean, ms: number, from = 0): Promise<Observed | null> {
    return new Promise((resolve) => {
      const check = () => {
        for (let i = from; i < this.events.length; i++) {
          const event = this.events[i];
          if (event && pred(event)) {
            finish(event);
            return true;
          }
        }
        return false;
      };
      const finish = (event: Observed | null) => {
        this.#waiters.delete(check);
        clearTimeout(timer);
        resolve(event);
      };
      const timer = setTimeout(() => finish(null), ms);
      if (!check()) this.#waiters.add(check);
    });
  }

  messages(): Array<{ t: number; message: RemyMessage }> {
    return this.events.flatMap((e) => (e.type === 'message' && e.message ? [{ t: e.t, message: e.message }] : []));
  }

  saveWavs(dir: string): string[] {
    const files: string[] = [];
    for (const rec of this.tracks.values()) {
      const total = rec.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const all = new Int16Array(total);
      let offset = 0;
      for (const chunk of rec.chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      const file = join(dir, `${rec.identity}.wav`);
      writeWav(file, all, rec.sampleRate);
      files.push(file);
    }
    return files;
  }

  async leave(): Promise<void> {
    await this.room.disconnect().catch(() => undefined);
  }
}
