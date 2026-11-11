/**
 * Barge-in that lets hummed backchannels through. A person's sound while Remy talks stops Remy
 * once it shows OPEN_N frames of open-mouth speech: loud 10 ms frames whose energy above 1.2 kHz is
 * no more than OPEN_DB below their energy at 80–900 Hz. A closed-mouth "mm-hm" is a nasal hum with
 * almost nothing above 1 kHz, so it never gets there. Anything still going after 700 ms is speech
 * anyway. Spoken backchannels with open vowels ("yeah", "right") are not recognized: they stop
 * Remy, which is accepted. (agents-js 1.9.3's own backchannel model needs LiveKit Cloud inference.)
 *
 * Measured on recorded test clips: none of an "mm-hm"'s loud frames is open (its best ratio sits
 * 7 dB under the line), and "Wait—" is decided 140 ms after it starts.
 *
 * Input: 16 kHz mono Int16 in 10 ms hops (160 samples). Output: one event per hop at most.
 */

export interface HumGateOptions {
  sampleRate: number;
  hop: number;
  /** FFT window, samples */
  win: number;
  /** Sound starts: two hops above this. A quiet room or a synthetic mic sits near -66 dBFS. */
  onsetDb: number;
  /** Sound ends after this much quiet. */
  endHangMs: number;
  /** A frame counts toward open/hum only within this of the segment's loudest frame. */
  loudWithinDb: number;
  /** E(1.2–4 kHz) / E(80–900 Hz) above this is open-mouth speech. */
  openDb: number;
  /** Open frames needed to barge in. */
  openN: number;
  /** Sound longer than this is never a backchannel. */
  maxBackchannelMs: number;
}

export const HUM_GATE_DEFAULTS: HumGateOptions = {
  sampleRate: 16000,
  hop: 160,
  win: 512,
  onsetDb: -42,
  endHangMs: 150,
  loudWithinDb: 15,
  openDb: -13,
  openN: 4,
  maxBackchannelMs: 700,
};

export type HumGateDecision = 'open' | 'long';
export type HumGateEvent =
  | { type: 'onset'; hop: number }
  | { type: 'barge'; reason: HumGateDecision; hop: number; msAfterOnset: number; open: number; hum: number }
  | { type: 'end'; hop: number; durMs: number; open: number; hum: number; decided: HumGateDecision | null; peakDb: number };

interface Segment {
  startHop: number;
  hops: number;
  peakDb: number;
  open: number;
  hum: number;
  quietHops: number;
  decided: HumGateDecision | null;
}

export class HumGate {
  readonly options: HumGateOptions;
  #ring: Float64Array;
  #window: Float64Array;
  #re: Float64Array;
  #im: Float64Array;
  #low: [number, number];
  #high: [number, number];
  #segment: Segment | null = null;
  #aboveRun = 0;
  #hopIndex = 0;

  constructor(options: Partial<HumGateOptions> = {}) {
    this.options = { ...HUM_GATE_DEFAULTS, ...options };
    const { win, sampleRate } = this.options;
    this.#ring = new Float64Array(win);
    this.#window = Float64Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1)));
    this.#re = new Float64Array(win);
    this.#im = new Float64Array(win);
    const binHz = sampleRate / win;
    this.#low = [Math.round(80 / binHz), Math.round(900 / binHz)];
    this.#high = [Math.round(1200 / binHz), Math.round(4000 / binHz)];
  }

  /** Hops pushed so far. */
  get hopIndex(): number {
    return this.#hopIndex;
  }

  /** A sound is going on right now (from its onset until the end hang). */
  get active(): boolean {
    return this.#segment !== null;
  }

  /** One 10 ms hop. */
  push(hop: Int16Array): HumGateEvent | null {
    const { win, onsetDb, endHangMs, openN, maxBackchannelMs } = this.options;
    const n = hop.length;
    this.#ring.copyWithin(0, n);
    for (let i = 0; i < n; i++) this.#ring[win - n + i] = (hop[i] ?? 0) / 32768;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += ((hop[i] ?? 0) / 32768) ** 2;
    const rmsDb = 10 * Math.log10(sum / n + 1e-12);
    const ratioDb = this.#ratio();
    const h = this.#hopIndex++;

    const segment = this.#segment;
    if (!segment) {
      this.#aboveRun = rmsDb > onsetDb ? this.#aboveRun + 1 : 0;
      if (this.#aboveRun >= 2) {
        const started: Segment = { startHop: h - 1, hops: 2, peakDb: rmsDb, open: 0, hum: 0, quietHops: 0, decided: null };
        this.#segment = started;
        this.#count(started, rmsDb, ratioDb);
        return { type: 'onset', hop: h - 1 };
      }
      return null;
    }
    segment.hops++;
    if (rmsDb > onsetDb - 6) segment.quietHops = 0;
    else segment.quietHops++;
    segment.peakDb = Math.max(segment.peakDb, rmsDb);
    this.#count(segment, rmsDb, ratioDb);
    if (!segment.decided && segment.open >= openN) {
      segment.decided = 'open';
      return { type: 'barge', reason: 'open', hop: h, msAfterOnset: (h - segment.startHop) * 10, open: segment.open, hum: segment.hum };
    }
    if (!segment.decided && (segment.hops - segment.quietHops) * 10 >= maxBackchannelMs) {
      segment.decided = 'long';
      return { type: 'barge', reason: 'long', hop: h, msAfterOnset: (h - segment.startHop) * 10, open: segment.open, hum: segment.hum };
    }
    if (segment.quietHops * 10 >= endHangMs) {
      this.#segment = null;
      this.#aboveRun = 0;
      return {
        type: 'end',
        hop: h,
        durMs: (segment.hops - segment.quietHops) * 10,
        open: segment.open,
        hum: segment.hum,
        decided: segment.decided,
        peakDb: Number(segment.peakDb.toFixed(1)),
      };
    }
    return null;
  }

  #count(segment: Segment, rmsDb: number, ratioDb: number): void {
    const loud = rmsDb > Math.max(this.options.onsetDb, segment.peakDb - this.options.loudWithinDb);
    if (!loud) return;
    if (ratioDb > this.options.openDb) segment.open++;
    else segment.hum++;
  }

  /** E(1.2–4 kHz) / E(80–900 Hz) of the last window, in dB. */
  #ratio(): number {
    const { win } = this.options;
    for (let i = 0; i < win; i++) {
      this.#re[i] = (this.#ring[i] ?? 0) * (this.#window[i] ?? 0);
      this.#im[i] = 0;
    }
    fft(this.#re, this.#im);
    let lo = 0;
    let hi = 0;
    for (let k = this.#low[0]; k <= this.#low[1]; k++) lo += (this.#re[k] ?? 0) ** 2 + (this.#im[k] ?? 0) ** 2;
    for (let k = this.#high[0]; k <= this.#high[1]; k++) hi += (this.#re[k] ?? 0) ** 2 + (this.#im[k] ?? 0) ** 2;
    return 10 * Math.log10((hi + 1e-12) / (lo + 1e-12));
  }
}

/**
 * Feeds audio of any frame size to a HumGate in exact 10 ms hops, keeping the remainder for the
 * next frame. Returns the events in order.
 */
export class HopFeeder {
  #gate: HumGate;
  #carry = new Int16Array(0);

  constructor(gate: HumGate) {
    this.#gate = gate;
  }

  push(samples: Int16Array): HumGateEvent[] {
    const hop = this.#gate.options.hop;
    let data = samples;
    if (this.#carry.length) {
      data = new Int16Array(this.#carry.length + samples.length);
      data.set(this.#carry, 0);
      data.set(samples, this.#carry.length);
    }
    const events: HumGateEvent[] = [];
    let i = 0;
    for (; i + hop <= data.length; i += hop) {
      const event = this.#gate.push(data.subarray(i, i + hop));
      if (event) events.push(event);
    }
    this.#carry = data.slice(i);
    return events;
  }
}

/** In-place radix-2 FFT on (re, im) of length 2^k. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const rb = re[b] ?? 0;
        const ib = im[b] ?? 0;
        const tr = rb * cr - ib * ci;
        const ti = rb * ci + ib * cr;
        re[b] = (re[a] ?? 0) - tr;
        im[b] = (im[a] ?? 0) - ti;
        re[a] = (re[a] ?? 0) + tr;
        im[a] = (im[a] ?? 0) + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}
