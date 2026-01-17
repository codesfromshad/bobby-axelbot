import type { OrderbookSnapshot, OrderbookState } from "./types";
import { priceToIndex, sizeNumberToScaledBigInt } from "./math";

export function applyLevel(
  book: Map<number, bigint>,
  priceIndex: number,
  size: bigint
): void {
  if (size === 0n) book.delete(priceIndex);
  else book.set(priceIndex, size);
}

export function rebuildFromSnapshot(args: {
  book: OrderbookState;
  snapshot: OrderbookSnapshot;
  sizeScale: number;
}): void {
  const { book, snapshot, sizeScale } = args;
  if (book.tickSize == null) return;

  book.bids.clear();
  book.asks.clear();

  for (const [price, size] of snapshot.bids) {
    const idx = priceToIndex(price, book.tickSize);
    applyLevel(book.bids, idx, sizeNumberToScaledBigInt(size, sizeScale));
  }
  for (const [price, size] of snapshot.asks) {
    const idx = priceToIndex(price, book.tickSize);
    applyLevel(book.asks, idx, sizeNumberToScaledBigInt(size, sizeScale));
  }

  book.lastTimestamp = snapshot.timestamp;
  // if (snapshot.hash != null) book.lastFeedHash = snapshot.hash;
}
