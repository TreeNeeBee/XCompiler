const LOOP_REPEATS = 12;
const LOOP_MIN_LEN = 1_500;
const LOOP_MIN_WINDOW = 96;
const LOOP_MAX_PERIOD = 256;
const TEXT_LOOP_MIN_LEN = 6_000;
const TEXT_LOOP_TAIL = 14_000;
const TEXT_LOOP_SAMPLE_LEN = 48;
const TEXT_LOOP_STRIDE = 8;
const TEXT_LOOP_REPEATS = 5;

/**
 * Detects a model stuck in a periodic tail, such as `0000...` or a short phrase
 * repeated indefinitely. The minimum length keeps normal short tables/code away
 * from the detector.
 */
export function detectCyclicTokenLoop(aggregate: string): boolean {
  if (aggregate.length < LOOP_MIN_LEN) return false;
  const maxPeriod = Math.min(LOOP_MAX_PERIOD, Math.floor(aggregate.length / LOOP_REPEATS));
  for (let period = 1; period <= maxPeriod; period++) {
    const repeats = Math.max(LOOP_REPEATS, Math.ceil(LOOP_MIN_WINDOW / period));
    const need = period * repeats;
    if (need > aggregate.length) continue;
    const tail = aggregate.slice(-need);
    const ref = tail.slice(0, period);
    if (/^\s+$/.test(ref)) continue;
    let ok = true;
    for (let i = 1; i < repeats; i++) {
      if (tail.slice(i * period, (i + 1) * period) !== ref) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Detects long-form phrase loops where the model keeps rephrasing around the
 * same high-signal clause. Unlike detectCyclicTokenLoop(), this catches repeated
 * prose tails that are not byte-periodic because the surrounding quoted examples
 * or partial words vary slightly.
 */
export function detectRepeatedTextLoop(aggregate: string): boolean {
  if (aggregate.length < TEXT_LOOP_MIN_LEN) return false;
  const tail = aggregate.slice(-TEXT_LOOP_TAIL).replace(/\s+/gu, ' ').trim();
  if (tail.length < TEXT_LOOP_MIN_LEN) return false;

  const seen = new Map<string, { count: number; first: number; last: number }>();
  for (let i = 0; i + TEXT_LOOP_SAMPLE_LEN <= tail.length; i += TEXT_LOOP_STRIDE) {
    const sample = tail.slice(i, i + TEXT_LOOP_SAMPLE_LEN);
    if (!isHighSignalLoopSample(sample)) continue;
    const prior = seen.get(sample);
    if (!prior) {
      seen.set(sample, { count: 1, first: i, last: i });
      continue;
    }
    const next = { count: prior.count + 1, first: prior.first, last: i };
    seen.set(sample, next);
    if (next.count >= TEXT_LOOP_REPEATS && next.last - next.first >= TEXT_LOOP_SAMPLE_LEN * 3) {
      return true;
    }
  }
  return false;
}

function isHighSignalLoopSample(sample: string): boolean {
  const chars = [...sample];
  const signalChars = chars.filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  if (signalChars.length < 20) return false;
  if (signalChars.length / Math.max(1, chars.length) < 0.4) return false;
  const unique = new Set(signalChars.map((ch) => ch.toLowerCase())).size;
  return unique >= 10;
}

export class RepeatTokenDetector {
  private last: string | null = null;
  private streak = 0;

  constructor(private readonly threshold = 40) {}

  feed(piece: string): boolean {
    if (!piece) return false;
    if (piece === this.last) {
      this.streak++;
      return this.streak >= this.threshold;
    }
    this.last = piece;
    this.streak = 1;
    return false;
  }
}
