import type { SpmcStructReadResult } from "./protocol";
import type { SpmcStructRingBuffer } from "./ring";

export class SpmcStructRingReader<T extends readonly (number | bigint)[]> {
  readonly #rb: SpmcStructRingBuffer<T>;
  #nextSeq: bigint;
  readonly #scratch: Array<number | bigint>;

  constructor(rb: SpmcStructRingBuffer<T>, nextSeq: bigint) {
    this.#rb = rb;
    this.#nextSeq = nextSeq;
    this.#scratch = new Array(rb.fieldCount);
  }

  /**
   * Non-blocking read into a reusable buffer to avoid allocations.
   * Returns null if no entry is available right now.
   */
  tryReadInto(out: Array<number | bigint>): { seq: bigint; dropped: boolean } | null {
    const writeSeq = this.#rb.writeSeq;
    if (writeSeq < this.#nextSeq) return null;

    const oldest = this.#rb.oldestAvailableSeq(writeSeq);
    let dropped = false;
    if (this.#nextSeq < oldest) {
      this.#nextSeq = oldest;
      dropped = true;
    }

    const ok = this.#rb.tryReadAtSeq(this.#nextSeq, out);
    if (!ok) return null;

    const seq = this.#nextSeq;
    this.#nextSeq = seq + 1n;
    return { seq, dropped };
  }

  /**
   * Convenience API that allocates a new tuple on each successful read.
   */
  tryRead(): SpmcStructReadResult<T> | null {
    const info = this.tryReadInto(this.#scratch);
    if (!info) return null;

    // Copy into a stable tuple for the caller.
    const tuple = this.#scratch.slice(0, this.#rb.fieldCount) as unknown as T;
    return { seq: info.seq, tuple, dropped: info.dropped };
  }

  get nextSeq(): bigint {
    return this.#nextSeq;
  }
}