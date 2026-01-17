import { PolymarketWSClient } from "./ws.client";
import type { MarketWSMessage, PolymarketWSClientMessage } from "./ws.types";
import {
  CoreOrderbookEngine,
  type CoreOrderbookEngineOptions,
  type AppliedLevelUpdate,
} from "../../../domain/orderbook/engine";
import type {
  LiveOrderbookEngineOptions,
  OrderbookSnapshot,
  OrderbookState,
} from "../../../domain/orderbook/types";

function isMarketMessage(m: PolymarketWSClientMessage): m is MarketWSMessage {
  return (
    m.type !== "READY" &&
    m.type !== "ERROR" &&
    m.type !== "TRADE" &&
    m.type !== "ORDER"
  );
}

export class LiveOrderbookEngine {
  private readonly clobTokenIds: readonly string[];
  private readonly sizeScale: number;
  private readonly defaultTickSize: number | null;

  private readonly core: CoreOrderbookEngine;
  private readonly snapshotCache: Map<string, OrderbookSnapshot> = new Map();

  private readonly client: PolymarketWSClient;

  constructor(clobTokenIds: readonly string[], options?: LiveOrderbookEngineOptions) {
    this.clobTokenIds = clobTokenIds;
    this.sizeScale = options?.sizeScale ?? 6;
    this.defaultTickSize =
      typeof options?.defaultTickSize === "number" &&
      Number.isFinite(options.defaultTickSize)
        ? options.defaultTickSize
        : null;

    const coreOptions: CoreOrderbookEngineOptions = {
      ringCapacity: options?.ringCapacity ?? 4096,
      sizeScale: this.sizeScale,
    };
    if (this.defaultTickSize != null) coreOptions.defaultTickSize = this.defaultTickSize;

    this.core = new CoreOrderbookEngine(this.clobTokenIds, coreOptions);

    this.client = new PolymarketWSClient({
      channel: "market",
      assetIds: [...this.clobTokenIds],
      initialDump: true,
      onMessage: (m: PolymarketWSClientMessage) => {
        if (!isMarketMessage(m)) return;
        this.onMarketMessage(m);
      },
    });
  }

  connect(): this {
    this.client.connect();
    return this;
  }

  disconnect(): void {
    this.client.disconnect();
  }

  /**
   * Drain ring buffers and apply updates to the in-memory orderbooks.
   * Call this in a tight loop or on a timer.
   */
  drainOnce(): void {
    this.core.drainOnce();
  }

  setOnAppliedLevelUpdateListener(listener: ((u: AppliedLevelUpdate) => void) | null): void {
    this.core.setOnAppliedLevelUpdateListener(listener);
  }

  getOrderbook(clobTokenId: string): OrderbookState | undefined {
    return this.core.getOrderbook(clobTokenId);
  }

  // getLatestFeedHash(clobTokenId: string): string | null {
  //   return this.core.getLatestFeedHash(clobTokenId);
  // }

  // ---- Ingestion (producer side)

  private onMarketMessage(msg: MarketWSMessage): void {
    switch (msg.type) {
      case "BOOK": {
        const timestamp = BigInt(Math.trunc(msg.timestamp));

        // Cache the latest snapshot in raw-price form so we can rebuild if tickSize arrives later.
        this.snapshotCache.set(msg.clobTokenId, {
          bids: msg.bids.map((x) => [x[0], x[1]] as const),
          asks: msg.asks.map((x) => [x[0], x[1]] as const),
          timestamp,
          // hash: msg.hash,
        });

        // If tickSize is missing and we have a default, apply it now.
        const ob = this.core.getOrderbook(msg.clobTokenId);
        if (ob?.tickSize == null && this.defaultTickSize != null) {
          this.core.setTickSize(msg.clobTokenId, this.defaultTickSize);
        }

        const snap = this.snapshotCache.get(msg.clobTokenId);
        if (snap) this.core.applySnapshot(msg.clobTokenId, snap);

        return;
      }

      case "TICK_SIZE_CHANGE": {
        this.core.setTickSize(msg.clobTokenId, msg.newTickSize);

        // If we already have a cached snapshot, rebuild to align indices.
        const snap = this.snapshotCache.get(msg.clobTokenId);
        if (snap) this.core.applySnapshot(msg.clobTokenId, snap);

        return;
      }

      case "PRICE_CHANGE": {
        const timestamp = BigInt(Math.trunc(msg.timestamp));

        for (const change of msg.priceChanges) {
          const clobTokenId = change.clobTokenId;
          const side = change.side === "BUY" ? "bid" : "ask";

          // !IMPORTANT: Polymarket "PRICE_CHANGE" carries the *new aggregate size* at this level.
          this.core.pushLevelUpdate({
            id: clobTokenId,
            side,
            price: change.price,
            size: change.size,
            timestamp,
            // feedHash: change.hash,
          });
        }

        return;
      }

      default:
        return;
    }
  }
}

export type { LiveOrderbookEngineOptions, OrderbookState };
