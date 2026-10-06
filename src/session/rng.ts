export interface RngCursorSnapshot {
  readonly seed: number;
  readonly cursor: number;
  readonly state: number;
}

function nextState(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

/** Replayable 32-bit LCG. Peeking permits validation before committing RNG state. */
export class ReplayRng {
  readonly #seed: number;
  #state: number;
  #cursor = 0;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new RangeError("Session seed must be a safe integer");
    this.#seed = seed;
    this.#state = seed >>> 0;
  }

  get cursor(): number {
    return this.#cursor;
  }

  peekUnit(): number {
    return nextState(this.#state) / 0x1_0000_0000;
  }

  nextUnit(): number {
    this.#state = nextState(this.#state);
    this.#cursor += 1;
    return this.#state / 0x1_0000_0000;
  }

  nextInteger(minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
      throw new RangeError("Invalid deterministic integer bounds");
    }
    return minimum + Math.floor(this.nextUnit() * (maximum - minimum + 1));
  }

  snapshot(): RngCursorSnapshot {
    return { seed: this.#seed, cursor: this.#cursor, state: this.#state };
  }
}
