/**
 * How loud each voice on the call is, read when it is drawn: one analyser per audio track (your own
 * microphone, everyone else's track as it arrives) on one audio context, 0 (room noise) to 1 (speaking
 * up), rising quickly and falling slowly like a meter's needle. Nothing is kept: each read looks at the
 * last few milliseconds of sound and drops them.
 */
import { follow, levelFromRms } from '../rails/voice';

interface Watched {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  value: number;
  readAt: number;
}

export class TrackLevels {
  private context: AudioContext | null = null;
  private readonly watched = new Map<string, Watched>();

  /** Makes sure sound can be read: the browser lets an audio context run once the page has been pressed. */
  resume(): void {
    if (typeof AudioContext !== 'function') return;
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
  }

  /** Starts reading a track's level under `key` (an identity on the call). */
  watch(key: string, track: MediaStreamTrack): void {
    this.unwatch(key);
    this.resume();
    const context = this.context;
    if (!context) return;
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    this.watched.set(key, { source, analyser, samples: new Float32Array(analyser.fftSize), value: 0, readAt: 0 });
  }

  unwatch(key: string): void {
    const watched = this.watched.get(key);
    if (!watched) return;
    watched.source.disconnect();
    this.watched.delete(key);
  }

  has(key: string): boolean {
    return this.watched.has(key);
  }

  /** How loud `key` is now, 0 to 1; 0 for a track not read. */
  level(key: string, now = performance.now()): number {
    const watched = this.watched.get(key);
    if (!watched) return 0;
    if (now - watched.readAt < 10) return watched.value;
    const dt = watched.readAt === 0 ? 16 : Math.min(100, now - watched.readAt);
    watched.readAt = now;
    watched.analyser.getFloatTimeDomainData(watched.samples);
    let sum = 0;
    for (let index = 0; index < watched.samples.length; index += 1) sum += watched.samples[index]! * watched.samples[index]!;
    watched.value = follow(watched.value, levelFromRms(Math.sqrt(sum / watched.samples.length)), dt);
    return watched.value;
  }

  close(): void {
    for (const key of [...this.watched.keys()]) this.unwatch(key);
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}
