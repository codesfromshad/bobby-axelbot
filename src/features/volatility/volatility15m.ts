import type { OrderbookState } from "../../domain/orderbook/engine";

/* =======================
 * Types
 * ======================= */

export type VolatilityFeatureOptions = {
  /**
   * EWMA half-life for volatility (default: 15 minutes).
   * Controls how fast volatility adapts to regime changes.
   */
  ewmaHalfLifeMs?: number;

  /** @deprecated Kept for backwards compatibility */
  windowMs?: number;

  /** Sampling interval for returns in ms (default: 1 second). */
  sampleMs?: number;

  /** How long to retain mid samples for lookback queries (unused for EWMA; kept for compatibility). */
  midSampleWindowMs?: number;
};

export type VolatilitySnapshot = {
  id: string;
  /** Monotonic timestamp used for sampling */
  timestampMs: number;
  /** Latest sampled mid price */
  mid: number | null;
  /** Log return over `sampleMs` (unitless). */
  logReturn: number | null;
  /** EWMA-based 15m volatility (unitless, fractional) */
  vol15m: number | null;
  /** Number of samples absorbed into the EWMA */
  sampleCount: number;
};

/* =======================
 * Helpers
 * ======================= */

function priceFromIndex(priceIndex: number, tickSize: number): number {
  return priceIndex * tickSize;
}

function bestBidIndex(bids: Map<number, bigint>): number | null {
  let best: number | null = null;
  for (const idx of bids.keys()) {
    if (best == null || idx > best) best = idx;
  }
  return best;
}

function bestAskIndex(asks: Map<number, bigint>): number | null {
  let best: number | null = null;
  for (const idx of asks.keys()) {
    if (best == null || idx < best) best = idx;
  }
  return best;
}

function logReturn(now: number, then: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(then)) return null;
  if (now <= 0 || then <= 0) return null;
  return Math.log(now / then);
}

/* =======================
 * EWMA Variance
 * ======================= */

class EwmVariance {
  private readonly halfLifeMs: number;
  private variance: number | null = null;
  private lastTs: number | null = null;
  private n = 0;

  constructor(args: { halfLifeMs: number }) {
    this.halfLifeMs = Math.max(1, args.halfLifeMs);
  }

  push(nowMs: number, r2: number): void {
    if (!Number.isFinite(nowMs) || nowMs <= 0) return;
    if (!Number.isFinite(r2) || r2 < 0) return;

    this.n++;

    if (this.variance == null || this.lastTs == null) {
      this.variance = r2;
      this.lastTs = nowMs;
      return;
    }

    const dt = Math.max(0, nowMs - this.lastTs);
    const decay = Math.exp(Math.log(0.5) * (dt / this.halfLifeMs));

    this.variance = decay * this.variance + (1 - decay) * r2;
    this.lastTs = nowMs;
  }

  sigma(): number | null {
    if (this.variance == null) return null;
    return Math.sqrt(Math.max(0, this.variance));
  }

  count(): number {
    return this.n;
  }
}

/* =======================
 * Per-Symbol State
 * ======================= */

class SymbolVolatilityState {
  private readonly sampleMs: number;
  private readonly scale15m: number;
  private readonly ewma: EwmVariance;

  private lastTs = 0;
  private lastBucket: number | null = null;
  private lastMid: number | null = null;
  private lastSampledMid: number | null = null;
  private lastLogReturn: number | null = null;

  constructor(options?: VolatilityFeatureOptions) {
    const halfLifeMs =
      Math.max(
        1_000,
        options?.ewmaHalfLifeMs ??
          options?.windowMs ??
          900_000 // 15 minutes
      );

    this.sampleMs = Math.max(100, options?.sampleMs ?? 1000);
    this.scale15m = Math.sqrt(900_000 / this.sampleMs);
    this.ewma = new EwmVariance({ halfLifeMs });
  }

  observeBook(book: OrderbookState, nowMs: number): void {
    this.updateFromBook(book, nowMs);
  }

  computeSnapshot(id: string, book: OrderbookState, nowMs: number): VolatilitySnapshot {
    this.updateFromBook(book, nowMs);
    return this.snapshot(id);
  }

  private updateFromBook(book: OrderbookState, nowMs: number): void {
    if (book.tickSize == null) return;

    const rawTs = Number(book.lastTimestamp);
    const proposedTs = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : nowMs;
    const t = proposedTs > this.lastTs ? proposedTs : this.lastTs + 1;
    this.lastTs = t;

    const bb = bestBidIndex(book.bids);
    const ba = bestAskIndex(book.asks);
    if (bb == null || ba == null) return;

    const bid = priceFromIndex(bb, book.tickSize);
    const ask = priceFromIndex(ba, book.tickSize);
    const mid = (bid + ask) / 2;
    this.lastMid = mid;

    const bucket = Math.floor(t / this.sampleMs);
    if (this.lastBucket != null && bucket <= this.lastBucket) return;

    if (this.lastSampledMid != null) {
      const lr = logReturn(mid, this.lastSampledMid);
      this.lastLogReturn = lr;
      if (lr != null) this.ewma.push(t, lr * lr);
    } else {
      this.lastLogReturn = null;
    }

    this.lastSampledMid = mid;
    this.lastBucket = bucket;
  }

  private snapshot(id: string): VolatilitySnapshot {
    const sigmaSample = this.ewma.sigma();
    const vol15m = sigmaSample != null ? sigmaSample * this.scale15m : null;

    return {
      id,
      timestampMs: this.lastTs,
      mid: this.lastMid,
      logReturn: this.lastLogReturn,
      vol15m,
      sampleCount: this.ewma.count(),
    };
  }
}

/* =======================
 * Public Accumulator
 * ======================= */

export class Volatility15mAccumulator {
  private readonly options: VolatilityFeatureOptions | undefined;
  private readonly perId: Map<string, SymbolVolatilityState> = new Map();

  constructor(options?: VolatilityFeatureOptions) {
    this.options = options;
  }

  private state(id: string): SymbolVolatilityState {
    const existing = this.perId.get(id);
    if (existing) return existing;

    const created = new SymbolVolatilityState(this.options);
    this.perId.set(id, created);
    return created;
  }

  observeBook(id: string, book: OrderbookState, nowMs: number): void {
    this.state(id).observeBook(book, nowMs);
  }

  computeSnapshot(id: string, book: OrderbookState, nowMs: number): VolatilitySnapshot {
    return this.state(id).computeSnapshot(id, book, nowMs);
  }
}
