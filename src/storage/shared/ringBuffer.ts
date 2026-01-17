export class RingBuffer<T> {
  private readonly buf: Array<T | undefined>;
  private readonly mask: number;
  private head = 0;
  private tail = 0;
  private sizeValue = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer (got ${capacity})`);
    }
    if ((capacity & (capacity - 1)) !== 0) {
      throw new Error(`RingBuffer capacity must be a power of two (got ${capacity})`);
    }

    this.buf = new Array<T | undefined>(capacity);
    this.mask = capacity - 1;
  }

  get capacity(): number {
    return this.buf.length;
  }

  get size(): number {
    return this.sizeValue;
  }

  get isEmpty(): boolean {
    return this.sizeValue === 0;
  }

  get isFull(): boolean {
    return this.sizeValue === this.buf.length;
  }

  clear(): void {
    // Avoid holding references.
    for (let i = 0; i < this.sizeValue; i++) {
      this.buf[(this.head + i) & this.mask] = undefined;
    }
    this.head = 0;
    this.tail = 0;
    this.sizeValue = 0;
  }

  peek(): T | undefined {
    if (this.sizeValue === 0) return undefined;
    return this.buf[this.head];
  }

  push(v: T): boolean {
    if (this.sizeValue === this.buf.length) return false;
    this.buf[this.tail] = v;
    this.tail = (this.tail + 1) & this.mask;
    this.sizeValue++;
    return true;
  }

  shift(): T | undefined {
    if (this.sizeValue === 0) return undefined;
    const v = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) & this.mask;
    this.sizeValue--;
    return v;
  }

  toArray(): T[] {
    const out: T[] = new Array(this.sizeValue);
    for (let i = 0; i < this.sizeValue; i++) {
      out[i] = this.buf[(this.head + i) & this.mask]!;
    }
    return out;
  }
}
