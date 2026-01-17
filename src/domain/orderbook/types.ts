export type LiveOrderbookEngineOptions = {
  /** Must be power of two. */
  ringCapacity?: number;
  /** Size scale used when converting snapshot/updates to bigint. */
  sizeScale?: number;
  /**
   * Fallback tick size when the feed doesn't emit `TICK_SIZE_CHANGE`.
   * If set, the engine can build immediately from the initial BOOK snapshot.
   */
  defaultTickSize?: number;
};

export type OrderbookState = {
  tickSize: number | null;
  bids: Map<number, bigint>; // priceIndex -> size
  asks: Map<number, bigint>; // priceIndex -> size
  version: bigint;
  lastTimestamp: bigint;
  /** Latest hash observed from the feed (BOOK.hash or PRICE_CHANGE.priceChanges[i].hash). */
  // lastFeedHash: string | null;
};

export type OrderbookSnapshot = {
  bids: Array<readonly [number, number]>;
  asks: Array<readonly [number, number]>;
  timestamp: bigint;
  // hash: string | null;
};
