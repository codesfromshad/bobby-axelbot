import {
  attachPriceChangeRings,
  createPriceChangeRings,
  type PriceChangeTuple,
} from "../../storage/spmc/priceChange.rings";
import { applyLevel, rebuildFromSnapshot } from "./book";
import { priceToIndex, sizeNumberToScaledBigInt } from "./math";
import type { OrderbookSnapshot, OrderbookState } from "./types";

export type CoreOrderbookEngineOptions = {
  /** Must be power of two. */
  ringCapacity?: number;
  /** Size scale used when converting levels to bigint. */
  sizeScale?: number;
  /** Optional default tick size applied at init. */
  defaultTickSize?: number;
  /** Optional callback invoked for every applied level change during `drainOnce()`. */
  onAppliedLevelUpdate?: (u: AppliedLevelUpdate) => void;
};

export type AppliedLevelUpdate = {
  id: string;
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
  readonly #ids: readonly string[];
  readonly #ringCapacity: number;
  readonly #sizeScale: number;

  readonly #books: Map<string, OrderbookState> = new Map();
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

  readonly #best: Map<string, { bid: number | null; ask: number | null }> = new Map();
  #onAppliedLevelUpdate: ((u: AppliedLevelUpdate) => void) | null;

  constructor(ids: readonly string[], options?: CoreOrderbookEngineOptions) {
    this.#ids = ids;
    this.#ringCapacity = options?.ringCapacity ?? 4096;
    this.#sizeScale = options?.sizeScale ?? 6;

    const defaultTickSize =
      typeof options?.defaultTickSize === "number" && Number.isFinite(options.defaultTickSize)
        ? options.defaultTickSize
        : null;

    const { state, writers } = createPriceChangeRings(this.#ids, {
      capacity: this.#ringCapacity,
    });
    this.#writers = writers;
    this.#readers = attachPriceChangeRings(state, { from: "oldest" }).readers;

    for (const id of this.#ids) {
      this.#books.set(id, {
        tickSize: defaultTickSize,
        bids: new Map(),
        asks: new Map(),
        version: 0n,
        lastTimestamp: 0n,
        // lastFeedHash: null,
      });
      this.#best.set(id, { bid: null, ask: null });
    }

    this.#onAppliedLevelUpdate = options?.onAppliedLevelUpdate ?? null;
  }

  setOnAppliedLevelUpdateListener(listener: ((u: AppliedLevelUpdate) => void) | null): void {
    this.#onAppliedLevelUpdate = listener;
  }

  getBestPriceIndices(id: string): { bestBidIndex: number | null; bestAskIndex: number | null } {
    const b = this.#best.get(id);
    return { bestBidIndex: b?.bid ?? null, bestAskIndex: b?.ask ?? null };
  }

  #recomputeBest(id: string, book: OrderbookState): void {
    let bestBid: number | null = null;
    for (const idx of book.bids.keys()) {
      if (bestBid == null || idx > bestBid) bestBid = idx;
    }
    let bestAsk: number | null = null;
    for (const idx of book.asks.keys()) {
      if (bestAsk == null || idx < bestAsk) bestAsk = idx;
    }
    this.#best.set(id, { bid: bestBid, ask: bestAsk });
  }

  #updateBestAfterLevelChange(args: {
    id: string;
    book: OrderbookState;
    side: "bid" | "ask";
    priceIndex: number;
    newSize: bigint;
  }): void {
    const best = this.#best.get(args.id) ?? { bid: null, ask: null };

    if (args.side === "bid") {
      if (args.newSize > 0n) {
        if (best.bid == null || args.priceIndex > best.bid) best.bid = args.priceIndex;
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
        if (best.ask == null || args.priceIndex < best.ask) best.ask = args.priceIndex;
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

    this.#best.set(args.id, best);
  }

  get sizeScale(): number {
    return this.#sizeScale;
  }

  get ringCapacity(): number {
    return this.#ringCapacity;
  }

  getOrderbook(id: string): OrderbookState | undefined {
    return this.#books.get(id);
  }

  // getLatestFeedHash(id: string): string | null {
  //   return this.#books.get(id)?.lastFeedHash ?? null;
  // }

  setTickSize(id: string, tickSize: number): void {
    const book = this.#books.get(id);
    if (!book) return;

    book.tickSize = tickSize;

    const snap = this.#snapshotCache.get(id);
    if (snap) {
      rebuildFromSnapshot({ book, snapshot: snap, sizeScale: this.#sizeScale });
      this.#recomputeBest(id, book);
    }
  }

  applySnapshot(id: string, snapshot: OrderbookSnapshot): void {
    const book = this.#books.get(id);
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
    const book = this.#books.get(args.id);
    const w = this.#writers.get(args.id);
    if (!book || !w) return;
    if (book.tickSize == null) return;

    // if (args.feedHash != null) book.lastFeedHash = args.feedHash;

    book.version += 1n;
    const priceIndex = priceToIndex(args.price, book.tickSize);
    const scaledSize = sizeNumberToScaledBigInt(args.size, this.#sizeScale);
    const tuple = [priceIndex, scaledSize, book.version, args.timestamp] as const;

    if (args.side === "bid") w.bid.push(tuple);
    else w.ask.push(tuple);
  }

  /**
   * Drain ring buffers and apply updates to the in-memory orderbooks.
   * Call this in a tight loop or on a timer.
   */
  drainOnce(): void {
    for (const id of this.#ids) {
      const book = this.#books.get(id)!;
      const rr = this.#readers.get(id);
      if (!rr) continue;

      for (;;) {
        const msg = rr.bid.tryRead();
        if (!msg) break;
        const [priceIndex, size, version, timestamp] = msg.tuple;
        const prevSize = book.bids.get(priceIndex) ?? 0n;
        applyLevel(book.bids, priceIndex, size);
        this.#updateBestAfterLevelChange({ id, book, side: "bid", priceIndex, newSize: size });
        book.version = version;
        book.lastTimestamp = timestamp;

        const best = this.#best.get(id) ?? { bid: null, ask: null };
        this.#onAppliedLevelUpdate?.({
          id,
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
        this.#updateBestAfterLevelChange({ id, book, side: "ask", priceIndex, newSize: size });
        book.version = version;
        book.lastTimestamp = timestamp;

        const best = this.#best.get(id) ?? { bid: null, ask: null };
        this.#onAppliedLevelUpdate?.({
          id,
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
