import { z } from "zod";
import { applyLevel, rebuildFromSnapshot } from "./book";
import { priceToIndex, sizeNumberToScaledBigInt } from "./math";
import type { OrderbookSnapshot, OrderbookState } from "./types";
import { SpmcStructRingBuffer, SpmcStructRingWriter, type SpmcReaderOptions, type SpmcStructRingBufferState, type SpmcStructRingReader } from "../../storage/spmc";

function isPowerOfTwoSafeInt(n: number): boolean {
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  const b = BigInt(n);
  return (b & (b - 1n)) === 0n;
}

export type PriceChangeTuple = readonly [
  priceIndex: number,
  size: bigint,
  version: bigint,
  timestamp: bigint
];

export type PriceChangeRingsState = {
  version: 1;
  entries: Array<{
    clobTokenId: string;
    bid: SpmcStructRingBufferState;
    ask: SpmcStructRingBufferState;
  }>;
};

export function attachPriceChangeRings(
  state: PriceChangeRingsState,
  options?: SpmcReaderOptions
): {
  readers: Map<
    string,
    {
      bid: SpmcStructRingReader<PriceChangeTuple>;
      ask: SpmcStructRingReader<PriceChangeTuple>;
    }
  >;
} {
  if (state.version !== 1) {
    throw new Error(`Unsupported 'PriceChangeRingsState' version: ${state.version}`);
  }

  const readers = new Map<
    string,
    {
      bid: SpmcStructRingReader<PriceChangeTuple>;
      ask: SpmcStructRingReader<PriceChangeTuple>;
    }
  >();

  for (const entry of state.entries) {
    const bid = SpmcStructRingBuffer.attach<PriceChangeTuple>(entry.bid).createReader(options);
    const ask = SpmcStructRingBuffer.attach<PriceChangeTuple>(entry.ask).createReader(options);
    readers.set(entry.clobTokenId, { bid, ask });
  }

  return { readers };
}

export function createPriceChangeRings(
  clobTokenIds: readonly string[],
  options: { capacity: number }
): {
  state: PriceChangeRingsState;
  writers: Map<
    string,
    {
      bid: SpmcStructRingWriter<PriceChangeTuple>;
      ask: SpmcStructRingWriter<PriceChangeTuple>;
    }
  >;
} {
  const entries: PriceChangeRingsState["entries"] = [];
  const writers = new Map<
    string,
    {
      bid: SpmcStructRingWriter<PriceChangeTuple>;
      ask: SpmcStructRingWriter<PriceChangeTuple>;
    }
  >();

  for (const clobTokenId of clobTokenIds) {
    const bidRb = SpmcStructRingBuffer.create<PriceChangeTuple>({
      capacity: options.capacity,
      fields: [{ type: "i32" }, { type: "i64" }, { type: "i64" }, { type: "i64" }],
    });
    const askRb = SpmcStructRingBuffer.create<PriceChangeTuple>({
      capacity: options.capacity,
      fields: [{ type: "i32" }, { type: "i64" }, { type: "i64" }, { type: "i64" }],
    });

    entries.push({
      clobTokenId,
      bid: bidRb.state,
      ask: askRb.state,
    });

    writers.set(clobTokenId, {
      bid: bidRb.createWriter(),
      ask: askRb.createWriter(),
    });
  }

  return {
    state: { version: 1, entries },
    writers,
  };
}

export const CoreOrderbookEngineOptionsSchema = z
  .object({
    /**
     * Must be power of two.
     */
    ringCapacity: z
      .number()
      .int()
      .positive()
      .refine(isPowerOfTwoSafeInt)
      .optional(),
    /**
     * Size scale used when converting levels to bigint.
     */
    sizeScale: z.number().int().min(0).max(18).optional(),
    /**
     * Optional default tick size applied at init.
     */
    defaultTickSize: z.number().positive().optional(),
    /**
     * Optional callback invoked for every applied level change
     * during `drainOnce()`.
     */
    onAppliedLevelUpdate: z
      .custom<
        ((u: AppliedLevelUpdate) => void) | undefined
      >((v) => (v === undefined ? true : typeof v === "function"))
      .optional(),
  })
  .strict();

export type CoreOrderbookEngineOptions = z.infer<
  typeof CoreOrderbookEngineOptionsSchema
>;

export type AppliedLevelUpdate = {
  obId: string;
  side: "bid" | "ask";
  priceIndex: number;
  prevSize: bigint;
  newSize: bigint;
  deltaSize: bigint;
  timestamp: bigint;
  bestBidIndex: number | null;
  bestAskIndex: number | null;
};

export class CoreOrderbookEngine {
  readonly #uniqueObIds: readonly string[];
  readonly #ringCapacity: number;
  readonly #sizeScale: number;

  readonly #orderbooks: Map<string, OrderbookState> = new Map();
  readonly #snapshotCache: Map<string, OrderbookSnapshot> = new Map();

  readonly #writers: Map<
    string,
    {
      bid: import("../../storage/spmc").SpmcStructRingWriter<PriceChangeTuple>;
      ask: import("../../storage/spmc").SpmcStructRingWriter<PriceChangeTuple>;
    }
  >;

  readonly #readers: Map<
    string,
    {
      bid: import("../../storage/spmc").SpmcStructRingReader<PriceChangeTuple>;
      ask: import("../../storage/spmc").SpmcStructRingReader<PriceChangeTuple>;
    }
  >;

  readonly #best: Map<string, { bid: number | null; ask: number | null }> =
    new Map();
  #onAppliedLevelUpdate: ((u: AppliedLevelUpdate) => void) | null;

  constructor(
    /**
     * Unique orderbook IDs (e.g. `clobTokenIds`).
     */
    uniqueObIds: readonly string[],
    /**
     * Engine options.
     */
    options?: CoreOrderbookEngineOptions,
  ) {
    const parsedOptions = CoreOrderbookEngineOptionsSchema.parse(options ?? {});
    this.#uniqueObIds = uniqueObIds;
    this.#ringCapacity = parsedOptions.ringCapacity ?? 4096;
    this.#sizeScale = parsedOptions.sizeScale ?? 6;
    const defaultTickSize = parsedOptions.defaultTickSize ?? null;

    const { state, writers } = createPriceChangeRings(this.#uniqueObIds, {
      capacity: this.#ringCapacity,
    });
    this.#writers = writers;
    this.#readers = attachPriceChangeRings(state, { from: "oldest" }).readers;

    for (const obId of this.#uniqueObIds) {
      this.#orderbooks.set(obId, {
        tickSize: defaultTickSize,
        bids: new Map(),
        asks: new Map(),
        version: 0n,
        lastTimestamp: 0n,
        // lastFeedHash: null,
      });
      this.#best.set(obId, { bid: null, ask: null });
    }

    this.#onAppliedLevelUpdate = parsedOptions.onAppliedLevelUpdate ?? null;
  }

  setOnAppliedLevelUpdateListener(
    listener: ((u: AppliedLevelUpdate) => void) | null,
  ): void {
    this.#onAppliedLevelUpdate = listener;
  }

  getBestPriceIndices(obId: string): {
    bestBidIndex: number | null;
    bestAskIndex: number | null;
  } {
    const b = this.#best.get(obId);
    return { bestBidIndex: b?.bid ?? null, bestAskIndex: b?.ask ?? null };
  }

  #recomputeBest(obId: string, book: OrderbookState): void {
    let bestBid: number | null = null;
    for (const idx of book.bids.keys()) {
      if (bestBid == null || idx > bestBid) bestBid = idx;
    }
    let bestAsk: number | null = null;
    for (const idx of book.asks.keys()) {
      if (bestAsk == null || idx < bestAsk) bestAsk = idx;
    }
    this.#best.set(obId, { bid: bestBid, ask: bestAsk });
  }

  #updateBestAfterPriceLevelChange(args: {
    obId: string;
    book: OrderbookState;
    side: "bid" | "ask";
    priceIndex: number;
    newSize: bigint;
  }): void {
    const best = this.#best.get(args.obId) ?? { bid: null, ask: null };

    if (args.side === "bid") {
      if (args.newSize > 0n) {
        if (best.bid == null || args.priceIndex > best.bid)
          best.bid = args.priceIndex;
      } else {
        if (best.bid === args.priceIndex) {
          let next: number | null = null;
          for (const idx of args.book.bids.keys()) {
            if (next == null || idx > next) next = idx;
          }
          best.bid = next;
        }
      }
    } else {
      if (args.newSize > 0n) {
        if (best.ask == null || args.priceIndex < best.ask)
          best.ask = args.priceIndex;
      } else {
        if (best.ask === args.priceIndex) {
          let next: number | null = null;
          for (const idx of args.book.asks.keys()) {
            if (next == null || idx < next) next = idx;
          }
          best.ask = next;
        }
      }
    }

    this.#best.set(args.obId, best);
  }

  get sizeScale(): number {
    return this.#sizeScale;
  }

  get ringCapacity(): number {
    return this.#ringCapacity;
  }

  getOrderbook(id: string): OrderbookState | undefined {
    return this.#orderbooks.get(id);
  }

  // getLatestFeedHash(id: string): string | null {
  //   return this.#orderbooks.get(id)?.lastFeedHash ?? null;
  // }

  setTickSize(id: string, tickSize: number): void {
    const book = this.#orderbooks.get(id);
    if (!book) return;

    book.tickSize = tickSize;

    const snap = this.#snapshotCache.get(id);
    if (snap) {
      rebuildFromSnapshot({ book, snapshot: snap, sizeScale: this.#sizeScale });
      this.#recomputeBest(id, book);
    }
  }

  applySnapshot(id: string, snapshot: OrderbookSnapshot): void {
    const book = this.#orderbooks.get(id);
    if (!book) return;

    this.#snapshotCache.set(id, snapshot);

    // if (snapshot.hash != null) book.lastFeedHash = snapshot.hash;

    if (book.tickSize != null) {
      rebuildFromSnapshot({ book, snapshot, sizeScale: this.#sizeScale });
      this.#recomputeBest(id, book);
    }
  }

  pushLevelUpdate(args: {
    id: string;
    side: "bid" | "ask";
    price: number;
    size: number;
    timestamp: bigint;
    // feedHash?: string | null;
  }): void {
    const book = this.#orderbooks.get(args.id);
    const w = this.#writers.get(args.id);
    if (!book || !w) return;
    if (book.tickSize == null) return;

    // if (args.feedHash != null) book.lastFeedHash = args.feedHash;

    book.version += 1n;
    const priceIndex = priceToIndex(args.price, book.tickSize);
    const scaledSize = sizeNumberToScaledBigInt(args.size, this.#sizeScale);
    const tuple = [
      priceIndex,
      scaledSize,
      book.version,
      args.timestamp,
    ] as const;

    if (args.side === "bid") w.bid.push(tuple);
    else w.ask.push(tuple);
  }

  /**
   * Drain ring buffers and apply updates to the in-memory orderbooks.
   * Call this in a tight loop or on a timer.
   */
  drainOnce(): void {
    for (const obId of this.#uniqueObIds) {
      const book = this.#orderbooks.get(obId)!;
      const rr = this.#readers.get(obId);
      if (!rr) continue;

      for (;;) {
        const msg = rr.bid.tryRead();
        if (!msg) break;
        const [priceIndex, size, version, timestamp] = msg.tuple;
        const prevSize = book.bids.get(priceIndex) ?? 0n;
        applyLevel(book.bids, priceIndex, size);
        this.#updateBestAfterPriceLevelChange({
          obId,
          book,
          side: "bid",
          priceIndex,
          newSize: size,
        });
        book.version = version;
        book.lastTimestamp = timestamp;

        const best = this.#best.get(obId) ?? { bid: null, ask: null };
        this.#onAppliedLevelUpdate?.({
          obId,
          side: "bid",
          priceIndex,
          prevSize,
          newSize: size,
          deltaSize: size - prevSize,
          timestamp,
          bestBidIndex: best.bid,
          bestAskIndex: best.ask,
        });
      }

      for (;;) {
        const msg = rr.ask.tryRead();
        if (!msg) break;
        const [priceIndex, size, version, timestamp] = msg.tuple;
        const prevSize = book.asks.get(priceIndex) ?? 0n;
        applyLevel(book.asks, priceIndex, size);
        this.#updateBestAfterPriceLevelChange({
          obId,
          book,
          side: "ask",
          priceIndex,
          newSize: size,
        });
        book.version = version;
        book.lastTimestamp = timestamp;

        const best = this.#best.get(obId) ?? { bid: null, ask: null };
        this.#onAppliedLevelUpdate?.({
          obId,
          side: "ask",
          priceIndex,
          prevSize,
          newSize: size,
          deltaSize: size - prevSize,
          timestamp,
          bestBidIndex: best.bid,
          bestAskIndex: best.ask,
        });
      }
    }
  }
}

export type { OrderbookState, OrderbookSnapshot };
