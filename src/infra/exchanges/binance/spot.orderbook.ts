import {
  MainClient,
  WebsocketClient,
  type WsFormattedMessage,
  type SymbolExchangeInfo,
} from "binance";
import {
  CoreOrderbookEngine,
  type AppliedLevelUpdate,
} from "../../../domain/orderbook/engine";
import type {
  OrderbookSnapshot,
  OrderbookState,
} from "../../../domain/orderbook/types";
import { RingBuffer } from "../../../storage/shared/ringBuffer";

export type BinanceSpotOrderbookEngineOptions = {
  /** Must be power of two. */
  ringCapacity?: number;
  /**
   * Bounded buffer for raw WS depthUpdate events while waiting for a REST snapshot.
   * Must be power of two.
   */
  syncBufferCapacity?: number;
  /** Size scale used when converting Binance quantities to bigint. */
  sizeScale?: number;
  /** REST snapshot depth. */
  snapshotLimit?: 5 | 10 | 20 | 50 | 100 | 500 | 1000 | 5000;
  /** Websocket depth update interval. */
  wsUpdateMs?: 1000 | 100;
  /** WS key for spot market streams. */
  wsKey?: "main" | "main2" | "main3";

  /** Controls how we retry REST snapshots to satisfy Binance's sync condition. */
  snapshotRetry?: {
    /** Default: `until-satisfied` */
    mode?: "until-satisfied" | "max-attempts";
    /** Used when mode is `max-attempts`. Default: 5 */
    maxAttempts?: number;
    /** Optional wall-clock cap for retries. If exceeded, resync stops (inSync stays false). */
    maxMs?: number;
    /** Backoff tuning (applies to both modes). */
    backoffMs?: {
      initial?: number;
      max?: number;
      factor?: number;
    };
  };
};

type DepthUpdateEvent = Extract<
  WsFormattedMessage,
  { eventType: "depthUpdate"; symbol: string }
>;

function isDepthUpdate(m: WsFormattedMessage): m is DepthUpdateEvent {
  return (m as DepthUpdateEvent).eventType === "depthUpdate";
}

function numberFromBinance(x: string | number): number {
  return typeof x === "number" ? x : Number(x);
}

function getTickSizeFromExchangeInfo(
  exchangeInfo: SymbolExchangeInfo
): number | null {
  const priceFilter = exchangeInfo.filters.find(
    (f) => f.filterType === "PRICE_FILTER"
  );
  const tickSize = priceFilter?.tickSize;
  if (tickSize == null) return null;
  const n = numberFromBinance(tickSize);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type SymbolSyncState = {
  /** Binance lastUpdateId applied/accepted. */
  lastUpdateId: number | null;
  /** Whether initial REST snapshot has been loaded and we are applying deltas. */
  inSync: boolean;
  /** Prevent overlapping resync loops for the same symbol. */
  resyncing: boolean;
  /** A resync was requested while resyncing; run again after current resync completes. */
  resyncRequested: boolean;
  /** Buffered WS events while snapshot is loading / resyncing. */
  buffered: RingBuffer<DepthUpdateEvent>;
  /** Latest raw snapshot cached (for rebuilds). */
  snapshot: OrderbookSnapshot | null;
};

export class BinanceSpotOrderbookEngine {
  private readonly symbols: readonly string[];
  private readonly sizeScale: number;
  private readonly snapshotLimit: 5 | 10 | 20 | 50 | 100 | 500 | 1000 | 5000;
  private readonly wsUpdateMs: 1000 | 100;
  private readonly wsKey: "main" | "main2" | "main3";
  private readonly syncBufferCapacity: number;

  private stopped = false;

  private readonly snapshotRetryMode: "until-satisfied" | "max-attempts";
  private readonly snapshotRetryMaxAttempts: number;
  private readonly snapshotRetryMaxMs: number | null;
  private readonly snapshotRetryBackoffInitialMs: number;
  private readonly snapshotRetryBackoffMaxMs: number;
  private readonly snapshotRetryBackoffFactor: number;

  private readonly rest: MainClient;
  private readonly ws: WebsocketClient;

  private readonly sync: Map<string, SymbolSyncState> = new Map();

  private readonly engine: CoreOrderbookEngine;

  constructor(
    symbols: readonly string[],
    options?: BinanceSpotOrderbookEngineOptions
  ) {
    this.symbols = symbols;
    this.sizeScale = options?.sizeScale ?? 8;
    this.snapshotLimit = options?.snapshotLimit ?? 1000;
    this.wsUpdateMs = options?.wsUpdateMs ?? 100;
    this.wsKey = options?.wsKey ?? "main";
    this.syncBufferCapacity = options?.syncBufferCapacity ?? 8192;

    this.snapshotRetryMode = options?.snapshotRetry?.mode ?? "until-satisfied";
    this.snapshotRetryMaxAttempts = Math.max(
      1,
      options?.snapshotRetry?.maxAttempts ?? 5
    );
    this.snapshotRetryMaxMs =
      typeof options?.snapshotRetry?.maxMs === "number" &&
      Number.isFinite(options.snapshotRetry.maxMs)
        ? Math.max(0, options.snapshotRetry.maxMs)
        : null;
    this.snapshotRetryBackoffInitialMs = Math.max(
      0,
      options?.snapshotRetry?.backoffMs?.initial ?? 25
    );
    this.snapshotRetryBackoffMaxMs = Math.max(
      1,
      options?.snapshotRetry?.backoffMs?.max ?? 1000
    );
    this.snapshotRetryBackoffFactor = Math.max(
      1.0,
      options?.snapshotRetry?.backoffMs?.factor ?? 1.5
    );

    this.engine = new CoreOrderbookEngine(this.symbols, {
      ringCapacity: options?.ringCapacity ?? 4096,
      sizeScale: this.sizeScale,
    });

    for (const symbol of this.symbols) {
      this.sync.set(symbol, {
        lastUpdateId: null,
        inSync: false,
        resyncing: false,
        resyncRequested: false,
        buffered: new RingBuffer<DepthUpdateEvent>(this.syncBufferCapacity),
        snapshot: null,
      });
    }

    this.rest = new MainClient({});

    this.ws = new WebsocketClient({
      // Prefer formatted messages so prices/qty are numbers
      beautify: true,
    });

    this.ws.on("formattedMessage", (m) => {
      if (!isDepthUpdate(m)) return;
      const symbol = m.symbol;
      if (!this.engine.getOrderbook(symbol)) return;
      this.onDepthUpdate(symbol, m);
    });

    // If a reconnect happens, we should resync via REST to avoid drift.
    this.ws.on("reconnected", (evt) => {
      if (evt.wsKey !== this.wsKey) return;
      for (const symbol of this.symbols) {
        void this.resyncSymbol(symbol);
      }
    });

    this.ws.on("exception", () => {
      // Intentionally ignore here; consumers can add their own listeners.
    });
  }

  /** Begin syncing snapshots and subscribing to diff depth streams. */
  connect(): this {
    this.stopped = false;
    void this.bootstrap();
    return this;
  }

  disconnect(): void {
    this.stopped = true;
    this.ws.closeAll(true);
  }

  /**
   * Drain ring buffers and apply updates to the in-memory orderbooks.
   * Call this in a tight loop or on a timer.
   */
  drainOnce(): void {
    this.engine.drainOnce();
  }

  setOnAppliedLevelUpdateListener(
    listener: ((u: AppliedLevelUpdate) => void) | null
  ): void {
    this.engine.setOnAppliedLevelUpdateListener(listener);
  }

  getOrderbook(symbol: string): OrderbookState | undefined {
    return this.engine.getOrderbook(symbol);
  }

  // ---- bootstrap & sync

  private async bootstrap(): Promise<void> {
    await this.loadTickSizes();

    // Reset local sync state before starting WS subscriptions.
    for (const symbol of this.symbols) {
      const sync = this.sync.get(symbol);
      if (!sync) continue;
      sync.inSync = false;
      sync.resyncing = false;
      sync.resyncRequested = false;
      sync.lastUpdateId = null;
      sync.buffered.clear();
    }

    // Start WS subscriptions first to begin buffering immediately.
    for (const symbol of this.symbols) {
      await this.ws.subscribeSpotDiffBookDepth(symbol, this.wsUpdateMs);
    }

    // Then fetch initial snapshots.
    await Promise.all(this.symbols.map((s) => this.resyncSymbol(s)));
  }

  private async waitForFirstBufferedEvent(
    symbol: string,
    timeoutMs: number
  ): Promise<boolean> {
    const sync = this.sync.get(symbol);
    if (!sync) return false;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (sync.buffered.size > 0) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return sync.buffered.size > 0;
  }

  private async loadTickSizes(): Promise<void> {
    const info = await this.rest.getExchangeInfo({
      symbols: [...this.symbols],
    });
    for (const s of info.symbols) {
      const symbol = s.symbol;
      if (!this.engine.getOrderbook(symbol)) continue;

      const tickSize = getTickSizeFromExchangeInfo(s);
      if (tickSize != null) this.engine.setTickSize(symbol, tickSize);
    }
  }

  private async resyncSymbol(symbol: string): Promise<void> {
    const sync = this.sync.get(symbol);
    if (!sync) return;

    if (sync.resyncing) return;
    sync.resyncing = true;

    // Clear any pending request at the start of this run.
    sync.resyncRequested = false;

    try {
      sync.inSync = false;

      // Binance requires us to buffer WS events and note U of the first event.
      // If we cleared the buffer here, we'd violate the sync procedure.
      // Ensure we have at least one buffered event (or proceed if none arrive quickly).
      await this.waitForFirstBufferedEvent(symbol, 2000);

      const firstBufferedU = sync.buffered.peek()?.firstUpdateId ?? null;

      // Step 4 in Binance docs: if snapshot.lastUpdateId < firstBufferedU, retry snapshot.
      // Keep buffering in parallel while we retry.
      const retryStart = Date.now();
      let backoffMs = this.snapshotRetryBackoffInitialMs;

      let ob = await this.rest.getOrderBook({
        symbol,
        limit: this.snapshotLimit,
      });

      if (firstBufferedU != null) {
        if (this.snapshotRetryMode === "max-attempts") {
          for (
            let attempt = 0;
            !this.stopped &&
            attempt < this.snapshotRetryMaxAttempts &&
            ob.lastUpdateId < firstBufferedU;
            attempt++
          ) {
            if (
              this.snapshotRetryMaxMs != null &&
              Date.now() - retryStart > this.snapshotRetryMaxMs
            ) {
              return;
            }
            await new Promise((r) => setTimeout(r, backoffMs));
            ob = await this.rest.getOrderBook({
              symbol,
              limit: this.snapshotLimit,
            });
            backoffMs = Math.min(
              this.snapshotRetryBackoffMaxMs,
              Math.trunc(backoffMs * this.snapshotRetryBackoffFactor)
            );
          }
        } else {
          while (!this.stopped && ob.lastUpdateId < firstBufferedU) {
            if (
              this.snapshotRetryMaxMs != null &&
              Date.now() - retryStart > this.snapshotRetryMaxMs
            ) {
              return;
            }
            await new Promise((r) => setTimeout(r, backoffMs));
            ob = await this.rest.getOrderBook({
              symbol,
              limit: this.snapshotLimit,
            });
            backoffMs = Math.min(
              this.snapshotRetryBackoffMaxMs,
              Math.trunc(backoffMs * this.snapshotRetryBackoffFactor)
            );
          }
        }
      }

      if (this.stopped) return;

      sync.lastUpdateId = ob.lastUpdateId;

      const snapshot: OrderbookSnapshot = {
        bids: ob.bids.map(
          ([p, q]) => [numberFromBinance(p), numberFromBinance(q)] as const
        ),
        asks: ob.asks.map(
          ([p, q]) => [numberFromBinance(p), numberFromBinance(q)] as const
        ),
        timestamp: BigInt(Date.now()),
        // hash: null,
      };

      sync.snapshot = snapshot;

      this.engine.applySnapshot(symbol, snapshot);

      // After snapshot load, attempt to apply any buffered deltas.
      const ok = this.applyBufferedDeltas(symbol);
      // If there were no buffered events, ok will be true.
      if (ok) sync.inSync = true;
    } finally {
      sync.resyncing = false;

      if (sync.resyncRequested && !this.stopped) {
        // Run again after current resync completes.
        void this.resyncSymbol(symbol);
      }
    }
  }

  private requestResync(symbol: string, sync?: SymbolSyncState): void {
    const s = sync ?? this.sync.get(symbol);
    if (!s) return;
    s.inSync = false;
    s.resyncRequested = true;
    if (!s.resyncing && !this.stopped) {
      void this.resyncSymbol(symbol);
    }
  }

  private onDepthUpdate(symbol: string, evt: DepthUpdateEvent): void {
    const sync = this.sync.get(symbol);
    if (!sync) return;

    if (!sync.inSync) {
      // bounded buffering during snapshot gap; overflow forces resync
      if (!sync.buffered.push(evt)) {
        this.requestResync(symbol, sync);
      }
      return;
    }

    this.applyDeltaEvent(symbol, evt);
  }

  private applyBufferedDeltas(symbol: string): boolean {
    const sync = this.sync.get(symbol);
    if (!sync || sync.lastUpdateId == null) return false;

    if (sync.buffered.size === 0) return true;

    const events = sync.buffered.toArray();
    if (events.length === 0) return true;

    // Binance events are ordered per stream, but we defensively sort by firstUpdateId.
    events.sort((a, b) => a.firstUpdateId - b.firstUpdateId);

    const snapshotLastUpdateId = sync.lastUpdateId;

    // If all buffered events are <= snapshot, the snapshot already includes them.
    // We can drop them and proceed in-sync.
    const hasNewerThanSnapshot = events.some(
      (e) => e.lastUpdateId > snapshotLastUpdateId
    );
    if (!hasNewerThanSnapshot) {
      sync.buffered.clear();
      return true;
    }

    // Find the first event that bridges the snapshot.
    let startIndex = -1;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.lastUpdateId <= snapshotLastUpdateId) continue;
      if (
        e.firstUpdateId <= snapshotLastUpdateId + 1 &&
        snapshotLastUpdateId + 1 <= e.lastUpdateId
      ) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) {
      // Could not bridge snapshot yet. Keep buffering and request a resync.
      // Keep the events around (sorted) so the next resync attempt can re-evaluate.
      sync.buffered.clear();
      for (const e of events) sync.buffered.push(e);
      this.requestResync(symbol, sync);
      return false;
    }

    const remaining: DepthUpdateEvent[] = [];
    for (let i = startIndex; i < events.length; i++) {
      const e = events[i]!;
      const last = sync.lastUpdateId;
      if (last == null) {
        remaining.push(...events.slice(i));
        break;
      }

      if (e.lastUpdateId <= last) continue;

      // If gap detected, stop and let caller resync.
      if (!(e.firstUpdateId <= last + 1 && last + 1 <= e.lastUpdateId)) {
        remaining.push(...events.slice(i));
        this.requestResync(symbol, sync);
        break;
      }

      this.applyDeltaEvent(symbol, e);
    }

    sync.buffered.clear();
    for (const e of remaining) sync.buffered.push(e);
    return remaining.length === 0;
  }

  private applyDeltaEvent(symbol: string, evt: DepthUpdateEvent): void {
    const sync = this.sync.get(symbol);
    if (!sync) return;

    const last = sync.lastUpdateId;

    // Drop events that are not newer than what we've already applied.
    if (last != null && evt.lastUpdateId <= last) return;

    // Validate sequence if we have a baseline.
    if (last != null) {
      if (!(evt.firstUpdateId <= last + 1 && last + 1 <= evt.lastUpdateId)) {
        // sequence gap; require resync
        this.requestResync(symbol, sync);
        return;
      }
    }

    const timestamp = BigInt(
      Math.trunc(evt.transactionTime ?? evt.eventTime ?? Date.now())
    );

    for (const level of evt.bidDepthDelta) {
      this.engine.pushLevelUpdate({
        id: symbol,
        side: "bid",
        price: level.price,
        size: level.quantity,
        timestamp,
      });
    }

    for (const level of evt.askDepthDelta) {
      this.engine.pushLevelUpdate({
        id: symbol,
        side: "ask",
        price: level.price,
        size: level.quantity,
        timestamp,
      });
    }

    sync.lastUpdateId = evt.lastUpdateId;
  }
}

export type { OrderbookState };
