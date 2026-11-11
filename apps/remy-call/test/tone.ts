/** Test sound for the pitch tracker. */

/** A voice-like tone: one sawtooth period repeated exactly (every harmonic), [hz, ms] per piece, 0 Hz for silence. */
export function voice(pieces: Array<[number, number]>, rate = 8000): Int16Array {
  const out: number[] = [];
  for (const [hz, ms] of pieces) {
    const n = Math.round((rate * ms) / 1000);
    const period = hz ? Math.round(rate / hz) : 0;
    for (let i = 0; i < n; i++) out.push(period ? Math.round(8000 * ((i % period) / period - 0.5)) : 0);
  }
  return Int16Array.from(out);
}
