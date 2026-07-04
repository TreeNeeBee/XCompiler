const LOOP_REPEATS = 12;
const LOOP_MIN_LEN = 1_500;
const LOOP_MIN_WINDOW = 96;
const LOOP_MAX_PERIOD = 256;

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
