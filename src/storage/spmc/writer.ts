import type { SpmcStructRingBuffer } from "./ring";

export class SpmcStructRingWriter<T extends readonly (number | bigint)[]> {
  readonly #rb: SpmcStructRingBuffer<T>;

  constructor(rb: SpmcStructRingBuffer<T>) {
    this.#rb = rb;
  }

  push(tuple: T): bigint {
    if (tuple.length !== this.#rb.fieldCount) {
      throw new Error(
        `tuple length mismatch: expected ${this.#rb.fieldCount}, got ${tuple.length}`
      );
    }
    const seq = this.#rb.allocateSeq();
    this.#rb.unsafeWrite(seq, tuple);
    return seq;
  }
}