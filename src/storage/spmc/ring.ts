import { MAGIC, VERSION } from "./protocol";
import type {
  SpmcFieldDescriptor,
  SpmcFieldType,
  SpmcReaderOptions,
  SpmcStructRingBufferCreateOptions,
  SpmcStructRingBufferState,
} from "./protocol";
import { SpmcStructRingReader } from "./reader";
import { SpmcStructRingWriter } from "./writer";
import {
  alignTo,
  codeToType,
  computeLayout,
  isPowerOfTwo,
  typeAlignment,
  typeToCode,
} from "./layout";

export class SpmcStructRingBuffer<T extends readonly (number | bigint)[]> {
  static create<T extends readonly (number | bigint)[]>(
    options: SpmcStructRingBufferCreateOptions
  ): SpmcStructRingBuffer<T> {
    const layout = computeLayout(options.capacity, options.fields);

    const sab = new SharedArrayBuffer(layout.totalBytes);
    const rb = new SpmcStructRingBuffer<T>(sab, "new");
    rb.initNew(options.capacity, options.fields);
    return rb;
  }

  static attach<T extends readonly (number | bigint)[]>(
    state: SpmcStructRingBufferState
  ): SpmcStructRingBuffer<T> {
    return new SpmcStructRingBuffer<T>(state.sab, "attach");
  }

  get state(): SpmcStructRingBufferState {
    return { sab: this.sab };
  }

  get capacity(): number {
    return this.capacityValue;
  }

  get fieldCount(): number {
    return this.fieldTypes.length;
  }

  get fieldTypesReadonly(): readonly SpmcFieldType[] {
    return this.fieldTypes;
  }

  get writeSeq(): bigint {
    return Atomics.load(this.writeSeqArr, 0);
  }

  createWriter(): SpmcStructRingWriter<T> {
    return new SpmcStructRingWriter<T>(this);
  }

  createReader(options?: SpmcReaderOptions): SpmcStructRingReader<T> {
    const from = options?.from ?? "oldest";
    const w = this.writeSeq;

    const nextSeq = from === "latest" ? w + 1n : this.oldestAvailableSeq(w);
    return new SpmcStructRingReader<T>(this, nextSeq);
  }

  // ---- internals

  private readonly sab: SharedArrayBuffer;

  private headerI32!: Int32Array;
  private writeSeqArr!: BigInt64Array;
  private stamps!: BigInt64Array;

  private capacityValue!: number;
  private mask!: bigint;

  private fieldTypes!: SpmcFieldType[];
  private fieldViews!: Array<Int32Array | Float64Array | BigInt64Array | BigUint64Array>;

  private constructor(sab: SharedArrayBuffer, mode: "new" | "attach") {
    this.sab = sab;
    if (mode === "attach") this.attachExisting();
  }

  private initNew(capacity: number, fields: readonly SpmcFieldDescriptor[]): void {
    const fieldCount = fields.length;
    const headerI32Length = 4 + fieldCount;

    this.headerI32 = new Int32Array(this.sab, 0, headerI32Length);
    this.headerI32[0] = MAGIC;
    this.headerI32[1] = VERSION;
    this.headerI32[2] = capacity;
    this.headerI32[3] = fieldCount;

    for (let i = 0; i < fieldCount; i++) {
      this.headerI32[4 + i] = typeToCode(fields[i]!.type);
    }

    this.attachFromHeader();

    Atomics.store(this.writeSeqArr, 0, -1n);
    for (let i = 0; i < capacity; i++) Atomics.store(this.stamps, i, -1n);
  }

  private attachExisting(): void {
    // read base header to learn fieldCount
    const base = new Int32Array(this.sab, 0, 4);
    const magic = base[0] ?? 0;
    const version = base[1] ?? 0;
    const capacity = base[2] ?? 0;
    const fieldCount = base[3] ?? 0;

    if (magic !== MAGIC) {
      throw new Error(
        `Invalid struct ring magic: expected 0x${MAGIC.toString(16)}, got 0x${magic.toString(16)}`
      );
    }
    if (version !== VERSION) {
      throw new Error(
        `Unsupported struct ring version: expected ${VERSION}, got ${version}`
      );
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`Invalid struct ring capacity: ${capacity}`);
    }
    if (!isPowerOfTwo(capacity)) {
      throw new Error(`Struct ring capacity must be power of two (got ${capacity})`);
    }
    if (!Number.isInteger(fieldCount) || fieldCount <= 0) {
      throw new Error(`Invalid struct ring fieldCount: ${fieldCount}`);
    }

    this.headerI32 = new Int32Array(this.sab, 0, 4 + fieldCount);
    this.attachFromHeader();
  }

  private attachFromHeader(): void {
    const capacity = this.headerI32[2] ?? 0;
    const fieldCount = this.headerI32[3] ?? 0;

    const fieldTypes: SpmcFieldType[] = new Array(fieldCount);
    for (let i = 0; i < fieldCount; i++) {
      const code = this.headerI32[4 + i] ?? 0;
      fieldTypes[i] = codeToType(code);
    }

    const headerBytes = (4 + fieldCount) * Int32Array.BYTES_PER_ELEMENT;
    const writeSeqOffset = alignTo(headerBytes, 8);
    const stampsOffset = alignTo(writeSeqOffset + BigInt64Array.BYTES_PER_ELEMENT, 8);

    let cursor = alignTo(
      stampsOffset + capacity * BigInt64Array.BYTES_PER_ELEMENT,
      8
    );

    this.writeSeqArr = new BigInt64Array(this.sab, writeSeqOffset, 1);
    this.stamps = new BigInt64Array(this.sab, stampsOffset, capacity);

    const views: Array<Int32Array | Float64Array | BigInt64Array | BigUint64Array> = [];

    for (let i = 0; i < fieldCount; i++) {
      const type = fieldTypes[i]!;
      cursor = alignTo(cursor, typeAlignment(type));

      switch (type) {
        case "i32":
          views.push(new Int32Array(this.sab, cursor, capacity));
          cursor += capacity * Int32Array.BYTES_PER_ELEMENT;
          break;
        case "f64":
          views.push(new Float64Array(this.sab, cursor, capacity));
          cursor += capacity * Float64Array.BYTES_PER_ELEMENT;
          break;
        case "i64":
          views.push(new BigInt64Array(this.sab, cursor, capacity));
          cursor += capacity * BigInt64Array.BYTES_PER_ELEMENT;
          break;
        case "u64":
          views.push(new BigUint64Array(this.sab, cursor, capacity));
          cursor += capacity * BigUint64Array.BYTES_PER_ELEMENT;
          break;
      }
    }

    this.capacityValue = capacity;
    this.mask = BigInt(capacity - 1);
    this.fieldTypes = fieldTypes;
    this.fieldViews = views;
  }

  private slotForSeq(seq: bigint): number {
    return Number(seq & this.mask);
  }

  oldestAvailableSeq(writeSeq: bigint): bigint {
    if (writeSeq < 0n) return 0n;
    const oldest = writeSeq - BigInt(this.capacityValue) + 1n;
    return oldest > 0n ? oldest : 0n;
  }

  allocateSeq(): bigint {
    const prev = Atomics.add(this.writeSeqArr, 0, 1n);
    return prev + 1n;
  }

  unsafeWrite(seq: bigint, tuple: readonly (number | bigint)[]): void {
    const slot = this.slotForSeq(seq);

    for (let i = 0; i < this.fieldViews.length; i++) {
      const view = this.fieldViews[i]!;
      const type = this.fieldTypes[i]!;
      const v = tuple[i];

      switch (type) {
        case "i32":
          (view as Int32Array)[slot] = Number(v) | 0;
          break;
        case "f64":
          (view as Float64Array)[slot] = Number(v);
          break;
        case "i64":
          (view as BigInt64Array)[slot] = BigInt(v as any);
          break;
        case "u64":
          (view as BigUint64Array)[slot] = BigInt(v as any);
          break;
      }
    }

    Atomics.store(this.stamps, slot, seq);
  }

  tryReadAtSeq(seq: bigint, out: Array<number | bigint>): boolean {
    const slot = this.slotForSeq(seq);

    const stamp1 = Atomics.load(this.stamps, slot);
    if (stamp1 !== seq) return false;

    for (let i = 0; i < this.fieldViews.length; i++) {
      const view = this.fieldViews[i]!;
      const type = this.fieldTypes[i]!;

      switch (type) {
        case "i32":
          out[i] = (view as Int32Array)[slot] ?? 0;
          break;
        case "f64":
          out[i] = (view as Float64Array)[slot]!;
          break;
        case "i64":
          out[i] = (view as BigInt64Array)[slot]!;
          break;
        case "u64":
          out[i] = (view as BigUint64Array)[slot]!;
          break;
      }
    }

    const stamp2 = Atomics.load(this.stamps, slot);
    return stamp2 === seq;
  }
}