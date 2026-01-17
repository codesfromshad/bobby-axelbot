import type { AppliedLevelUpdate, OrderbookState } from "../../domain/orderbook/engine";
import { RingBuffer } from "../../storage/shared/ringBuffer";

export type MicrostructureFeatureOptions = {
  /** Rolling window for event-rate / OFI style metrics. */
  windowMs?: number;
  /** Bucket width for rolling window (tradeoff: resolution vs CPU). */
  bucketMs?: number;
  /** If set, compute flow metrics over the last N applied updates (event-time), instead of wall-clock buckets. */
  eventWindowUpdates?: number;

  /** Depth band around best for Lk-style OFI (in ticks). */
  ofiDepthTicks?: number;
  /** EMA half-life (ms) for short OFI EMA. */
  ofiEmaShortHalflifeMs?: number;
  /** EMA half-life (ms) for long OFI EMA. */
  ofiEmaLongHalflifeMs?: number;

  /** Depth band for depth-within-k-ticks features. */
  depthTicks?: number;
  /** Depth band for depth-within-bps features. */
  depthBps?: number;
  /** Number of ticks used for gap/slope calculations. */
  shapeTicks?: number;

  /** Rolling window for realized-vol style normalizations (default: 5m). */
  volWindowMs?: number;
  /** Rolling window for 15m volatility (default: 15m). */
  vol15mWindowMs?: number;
  /** EMA half-life (ms) for persistence on normalized OFI (default: 30s). */
  persistenceHalflifeMs?: number;
  /** EMA half-life (ms) for regime drift on r1s (default: 30s). */
  regimeHalflifeMs?: number;
  /** How long to keep mid samples for return lookbacks (default: 65s). */
  midSampleWindowMs?: number;
};

type SideAgg = {
  updates: number;
  adds: number;
  cancels: number;
  zeroSize: number;
  deltaAbs: bigint;
  deltaSigned: bigint;
  deltaSignedL1: bigint;
  deltaSignedLk: bigint;
  deltaSignedWeighted: number;
};

type Bucket = {
  t0: number; // bucket start ms
  bid: SideAgg;
  ask: SideAgg;
  bestPriceChanges: number;
};

type Sample = { t: number; x: number };
type MidSample = { t: number; mid: number };

type EventRollRecord = {
  ts: number;
  side: "bid" | "ask";
  adds: number;
  cancels: number;
  zeroSize: number;
  deltaAbs: bigint;
  deltaSigned: bigint;
  deltaSignedL1: bigint;
  deltaSignedLk: bigint;
  deltaSignedWeighted: number;
  bestPriceChanges: number;
};

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function nextPowerOfTwo(n: number): number {
  let x = 1;
  while (x < n) x <<= 1;
  return x;
}

function makeSideAgg(): SideAgg {
  return {
    updates: 0,
    adds: 0,
    cancels: 0,
    zeroSize: 0,
    deltaAbs: 0n,
    deltaSigned: 0n,
    deltaSignedL1: 0n,
    deltaSignedLk: 0n,
    deltaSignedWeighted: 0,
  };
}

function resetBucket(b: Bucket, t0: number): void {
  b.t0 = t0;
  b.bid = makeSideAgg();
  b.ask = makeSideAgg();
  b.bestPriceChanges = 0;
}

function scaledBigintToNumber(x: bigint, sizeScale: number): number {
  const factor = 10 ** sizeScale;
  return Number(x) / factor;
}

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

function safeStdFromMoments(sum: number, sumSq: number, n: number): number | null {
  if (n < 2) return null;
  const mean = sum / n;
  const v = sumSq / n - mean * mean;
  return Math.sqrt(Math.max(0, v));
}

function signnz(x: number): -1 | 0 | 1 {
  if (!Number.isFinite(x) || x === 0) return 0;
  return x > 0 ? 1 : -1;
}

function logReturn(now: number, then: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(then)) return null;
  if (now <= 0 || then <= 0) return null;
  return Math.log(now / then);
}

class RollingTimeWindowStats {
  private readonly windowMs: number;
  private readonly buf: RingBuffer<Sample>;
  private sum = 0;
  private sumSq = 0;
  private n = 0;

  constructor(args: { windowMs: number; capacityPow2?: number }) {
    this.windowMs = Math.max(1, args.windowMs);
    const cap = args.capacityPow2 ?? 2048;
    this.buf = new RingBuffer<Sample>(cap);
  }

  push(t: number, x: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(x)) return;

    while (this.buf.isFull) {
      const old = this.buf.shift();
      if (!old) break;
      this.sum -= old.x;
      this.sumSq -= old.x * old.x;
      this.n--;
    }

    this.buf.push({ t, x });
    this.sum += x;
    this.sumSq += x * x;
    this.n++;

    this.evictOld(t);
  }

  private evictOld(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (;;) {
      const p = this.buf.peek();
      if (!p) break;
      if (p.t >= cutoff) break;
      const old = this.buf.shift();
      if (!old) break;
      this.sum -= old.x;
      this.sumSq -= old.x * old.x;
      this.n--;
    }
  }

  stddev(): number | null {
    return safeStdFromMoments(this.sum, this.sumSq, this.n);
  }

  variance(): number | null {
    const sd = this.stddev();
    return sd == null ? null : sd * sd;
  }
}

class TimeEma {
  private lastT: number | null = null;
  private value = 0;
  private initialized = false;

  update(nowMs: number, x: number, halflifeMs: number): number {
    if (!Number.isFinite(nowMs) || !Number.isFinite(x)) return this.value;
    const hl = Math.max(1, halflifeMs);
    const last = this.lastT;
    this.lastT = nowMs;

    if (!this.initialized || last == null) {
      this.value = x;
      this.initialized = true;
      return this.value;
    }

    const dt = Math.max(0, nowMs - last);
    const ln2 = Math.log(2);
    const a = 1 - Math.exp((-ln2 * dt) / hl);
    this.value = this.value + a * (x - this.value);
    return this.value;
  }

  get(): number | null {
    return this.initialized ? this.value : null;
  }
}

export type MicrostructureSnapshot = {
  id: string;
  timestampMs: number;

  // Top of book
  /** Best bid price (price units, e.g. USDT). */
  bestBid: number | null;
  /** Best ask price (price units, e.g. USDT). */
  bestAsk: number | null;
  /** Mid price: (bestBid + bestAsk) / 2. */
  mid: number | null;
  /** Absolute spread: bestAsk - bestBid (price units). */
  spreadAbs: number | null;
  /** Relative spread: (bestAsk - bestBid) / mid (unitless). */
  spreadRel: number | null;
  /** Spread expressed in ticks: (bestAsk - bestBid) / tickSize. */
  spreadTicks: number | null;

  /** Size resting at best bid (native size units; scaled back from bigint). */
  bestBidSize: number | null;
  /** Size resting at best ask (native size units; scaled back from bigint). */
  bestAskSize: number | null;
  /** L1 size imbalance: (bestBidSize - bestAskSize) / (bestBidSize + bestAskSize), in [-1, 1]. */
  l1Imbalance: number | null;

  /** Microprice (size-weighted top-of-book price): (ask*bidSize + bid*askSize)/(bidSize+askSize). */
  microprice: number | null;
  /** Microprice - mid (price units). Often interpreted as short-term pressure proxy. */
  micropriceMinusMid: number | null;

  // Depth / shape
  /** Total bid depth across all bid levels (native size units). */
  depthBidTotal: number | null;
  /** Total ask depth across all ask levels (native size units). */
  depthAskTotal: number | null;
  /** Total bid depth within `depthTicks` of best bid (native size units). */
  depthBidWithinTicks: number | null;
  /** Total ask depth within `depthTicks` of best ask (native size units). */
  depthAskWithinTicks: number | null;
  /** Total bid depth in a +/- `depthBps` band around mid (native size units). */
  depthBidWithinBps: number | null;
  /** Total ask depth in a +/- `depthBps` band around mid (native size units). */
  depthAskWithinBps: number | null;
  /** Depth imbalance within ticks: (depthBidWithinTicks - depthAskWithinTicks)/(sum), in [-1,1]. */
  depthImbalanceWithinTicks: number | null;

  /** First empty-price gap (in ticks) on bid side within `shapeTicks` of best bid. */
  bidFirstGapTicks: number | null;
  /** First empty-price gap (in ticks) on ask side within `shapeTicks` of best ask. */
  askFirstGapTicks: number | null;
  /** Maximum empty-price gap (in ticks) on bid side within `shapeTicks` of best bid. */
  bidMaxGapTicks: number | null;
  /** Maximum empty-price gap (in ticks) on ask side within `shapeTicks` of best ask. */
  askMaxGapTicks: number | null;

  // Flow / OFI (rolling window)
  /** Applied bid-side level updates per second over the rolling window (`windowMs` or event-window span). */
  updatesPerSecBid: number;
  /** Applied ask-side level updates per second over the rolling window (`windowMs` or event-window span). */
  updatesPerSecAsk: number;
  /** Bid adds per second over the rolling window (deltaSize > 0 at bid levels). */
  addRateBid: number;
  /** Ask adds per second over the rolling window (deltaSize > 0 at ask levels). */
  addRateAsk: number;
  /** Bid cancels per second over the rolling window (deltaSize < 0 at bid levels). */
  cancelRateBid: number;
  /** Ask cancels per second over the rolling window (deltaSize < 0 at ask levels). */
  cancelRateAsk: number;
  /** Bid cancel/add count ratio over the rolling window: cancels / adds (unitless). */
  cancelAddRatioBid: number | null;
  /** Ask cancel/add count ratio over the rolling window: cancels / adds (unitless). */
  cancelAddRatioAsk: number | null;

  /** Net signed order flow (native size units) over the rolling window: (bid signed delta) - (ask signed delta). */
  netOrderFlow: number;
  /** Update-count imbalance over the rolling window: (bidUpdates - askUpdates)/(sum), in [-1,1]. */
  eventImbalance: number | null;

  /** Order Flow Imbalance at L1 (native size units) over the rolling window: Δbid@best - Δask@best. */
  ofiL1: number;
  /** Order Flow Imbalance within `ofiDepthTicks` of best (native size units) over the rolling window. */
  ofiLk: number;
  /** Distance-weighted OFI (native size units) over the rolling window; closer-to-best updates count more. */
  ofiWeighted: number;
  /** Time-decayed EMA of per-update signed flow (native size units), short half-life (`ofiEmaShortHalflifeMs`). */
  ofiEmaShort: number;
  /** Time-decayed EMA of per-update signed flow (native size units), long half-life (`ofiEmaLongHalflifeMs`). */
  ofiEmaLong: number;

  /** Best-quote changes per second over the rolling window (how often best bid/ask index changes). */
  quoteFlickerPerSec: number;

  // Volatility (rolling window)
  /** Variance of mid price samples observed via `observeBook()` over ~`windowMs` (price^2 units). */
  midVar: number | null;
  /** Variance of spread samples observed via `observeBook()` over ~`windowMs` (price^2 units). */
  spreadVar: number | null;

  // ---- scale-free signals (returns + normalized microstructure)
  /** Log return over 1s: r1s = log(mid_t / mid_{t-1s}). Scale-free. */
  logReturn1s: number | null;
  /** Log return over 5s: r5s = log(mid_t / mid_{t-5s}). */
  logReturn5s: number | null;
  /** Log return over 15s: r15s = log(mid_t / mid_{t-15s}). */
  logReturn15s: number | null;
  /** Log return over 60s: r60s = log(mid_t / mid_{t-60s}). */
  logReturn60s: number | null;

  /** Realized-vol proxy: standard deviation of `logReturn1s` over `volWindowMs` (unitless). */
  r1sSigma: number | null;
  /** 15-minute realized volatility: standard deviation of `logReturn1s` over `vol15mWindowMs` (unitless). */
  r15mSigma: number | null;
  /** Normalized OFI: ofiLk / sigma(ofiLk, `volWindowMs`). Unitless and regime-comparable. */
  ofiLkNorm: number | null;
  /** Normalized L1 imbalance: l1Imbalance / sigma(l1Imbalance, `volWindowMs`). Unitless. */
  l1ImbalanceNorm: number | null;

  /** EMA of normalized OFI using `persistenceHalflifeMs` (signed; direction of pressure). */
  ofiNormEma: number | null;
  /** Pressure persistence: |ofiNormEma| (magnitude of sustained pressure, independent of sign). */
  ofiPersistence: number | null;

  /** Regime score: |EMA(r1s, `regimeHalflifeMs`)| / sigma(r1s, `volWindowMs`). High => trending, low => chop. */
  regimeScore: number | null;
  /** Directional agreement filter: sign(ofiNormEma) equals sign(logReturn60s). If false => skip. */
  agreeOfiAndR60s: boolean | null;
};

class SymbolMicrostructureState {
  private readonly windowMs: number;
  private readonly bucketMs: number;
  private readonly bucketCount: number;
  private readonly bucketMask: number;
  private readonly buckets: Bucket[];

  private readonly eventWindowUpdates: number | null;
  private readonly eventBuf: RingBuffer<EventRollRecord> | null;
  private readonly eventRollBid: SideAgg;
  private readonly eventRollAsk: SideAgg;
  private eventBestPriceChanges = 0;

  private readonly volWindowMs: number;
  private readonly vol15mWindowMs: number;
  private readonly midSampleWindowMs: number;
  private readonly persistenceHalflifeMs: number;
  private readonly regimeHalflifeMs: number;

  private readonly ofiDepthTicks: number;
  private readonly ofiEmaShortHalflifeMs: number;
  private readonly ofiEmaLongHalflifeMs: number;

  private readonly depthTicks: number;
  private readonly depthBps: number;
  private readonly shapeTicks: number;

  private lastBestBidIndex: number | null = null;
  private lastBestAskIndex: number | null = null;

  private lastEmaTs: number | null = null;
  private ofiEmaShortValue = 0;
  private ofiEmaLongValue = 0;

  private readonly midStats: RollingTimeWindowStats;
  private readonly spreadStats: RollingTimeWindowStats;

  private readonly midSamples: RingBuffer<MidSample>;
  private readonly r1sStats: RollingTimeWindowStats;
  private readonly r15mStats: RollingTimeWindowStats;
  private readonly ofiStats: RollingTimeWindowStats;
  private readonly imbStats: RollingTimeWindowStats;

  private readonly ofiNormEma: TimeEma;
  private readonly r1sEma: TimeEma;

  private lastReturn1sBucket: number | null = null;

  constructor(options?: MicrostructureFeatureOptions) {
    this.windowMs = Math.max(250, options?.windowMs ?? 5000);
    this.bucketMs = Math.max(10, options?.bucketMs ?? 100);

    this.eventWindowUpdates =
      typeof options?.eventWindowUpdates === "number" && Number.isFinite(options.eventWindowUpdates)
        ? Math.max(4, Math.floor(options.eventWindowUpdates))
        : null;

    const rawBuckets = Math.ceil(this.windowMs / this.bucketMs);
    const pow2 = nextPowerOfTwo(rawBuckets);
    this.bucketCount = pow2;
    this.bucketMask = pow2 - 1;

    this.ofiDepthTicks = Math.max(0, options?.ofiDepthTicks ?? 5);
    this.ofiEmaShortHalflifeMs = Math.max(1, options?.ofiEmaShortHalflifeMs ?? 1000);
    this.ofiEmaLongHalflifeMs = Math.max(1, options?.ofiEmaLongHalflifeMs ?? 5000);

    this.depthTicks = Math.max(0, options?.depthTicks ?? 5);
    this.depthBps = Math.max(0, options?.depthBps ?? 10);
    this.shapeTicks = Math.max(1, options?.shapeTicks ?? 20);

    this.volWindowMs = Math.max(1_000, options?.volWindowMs ?? 300_000);
    this.vol15mWindowMs = Math.max(1_000, options?.vol15mWindowMs ?? 900_000);
    this.midSampleWindowMs = Math.max(5_000, options?.midSampleWindowMs ?? 65_000);
    this.persistenceHalflifeMs = Math.max(1, options?.persistenceHalflifeMs ?? 30_000);
    this.regimeHalflifeMs = Math.max(1, options?.regimeHalflifeMs ?? 30_000);

    if (!isPowerOfTwo(this.bucketCount)) {
      throw new Error(`bucketCount must be power of two (got ${this.bucketCount})`);
    }

    this.buckets = new Array(this.bucketCount);
    for (let i = 0; i < this.bucketCount; i++) {
      this.buckets[i] = {
        t0: 0,
        bid: makeSideAgg(),
        ask: makeSideAgg(),
        bestPriceChanges: 0,
      };
    }

    this.eventRollBid = makeSideAgg();
    this.eventRollAsk = makeSideAgg();
    this.eventBuf =
      this.eventWindowUpdates != null
        ? new RingBuffer<EventRollRecord>(nextPowerOfTwo(this.eventWindowUpdates))
        : null;

    this.midSamples = new RingBuffer<MidSample>(2048);
    this.midStats = new RollingTimeWindowStats({ windowMs: this.windowMs, capacityPow2: 2048 });
    this.spreadStats = new RollingTimeWindowStats({ windowMs: this.windowMs, capacityPow2: 2048 });
    this.r1sStats = new RollingTimeWindowStats({ windowMs: this.volWindowMs, capacityPow2: 4096 });
    this.r15mStats = new RollingTimeWindowStats({ windowMs: this.vol15mWindowMs, capacityPow2: 4096 });
    this.ofiStats = new RollingTimeWindowStats({ windowMs: this.volWindowMs, capacityPow2: 4096 });
    this.imbStats = new RollingTimeWindowStats({ windowMs: this.volWindowMs, capacityPow2: 4096 });
    this.ofiNormEma = new TimeEma();
    this.r1sEma = new TimeEma();
  }

  onAppliedLevelUpdate(u: AppliedLevelUpdate): void {
    const ts = Number(u.timestamp);
    if (!Number.isFinite(ts)) return;

    const bestChanged =
      u.bestBidIndex !== this.lastBestBidIndex || u.bestAskIndex !== this.lastBestAskIndex;
    if (bestChanged) {
      this.lastBestBidIndex = u.bestBidIndex;
      this.lastBestAskIndex = u.bestAskIndex;
    }

    if (this.eventBuf) {
      this.applyEventRecord(u, ts, bestChanged);
    } else {
      this.advanceTo(ts);
      if (bestChanged) this.currentBucket(ts).bestPriceChanges++;
      const sideAgg = u.side === "bid" ? this.currentBucket(ts).bid : this.currentBucket(ts).ask;
      this.applyToSideAgg(sideAgg, u);
    }

    // EMAs on signed flow (bid positive, ask negative).
    const signedFlow = (u.side === "bid" ? 1 : -1) * Number(u.deltaSize);
    this.updateOfiEma(ts, signedFlow);
  }

  observeBook(book: OrderbookState, _sizeScale: number, nowMs: number): void {
    if (book.tickSize == null) return;

    const feedTs = Number(book.lastTimestamp);
    const t = Number.isFinite(feedTs) && feedTs > 0 ? feedTs : nowMs;

    const bestBidIdx = bestBidIndex(book.bids);
    const bestAskIdx = bestAskIndex(book.asks);
    if (bestBidIdx == null || bestAskIdx == null) return;

    const bid = priceFromIndex(bestBidIdx, book.tickSize);
    const ask = priceFromIndex(bestAskIdx, book.tickSize);
    const mid = (bid + ask) / 2;
    const spread = ask - bid;

    this.midStats.push(t, mid);
    this.spreadStats.push(t, spread);

    while (this.midSamples.isFull) this.midSamples.shift();
    this.midSamples.push({ t, mid });

    const cutoff = t - this.midSampleWindowMs;
    for (;;) {
      const p = this.midSamples.peek();
      if (!p) break;
      if (p.t >= cutoff) break;
      this.midSamples.shift();
    }
  }

  computeSnapshot(id: string, book: OrderbookState, sizeScale: number, nowMs: number): MicrostructureSnapshot {
    const tickSize = book.tickSize;

    let bestBid: number | null = null;
    let bestAsk: number | null = null;
    let bestBidSz: number | null = null;
    let bestAskSz: number | null = null;

    let mid: number | null = null;
    let spreadAbs: number | null = null;
    let spreadRel: number | null = null;
    let spreadTicks: number | null = null;

    let microprice: number | null = null;
    let micropriceMinusMid: number | null = null;
    let l1Imbalance: number | null = null;

    let depthBidTotal: number | null = null;
    let depthAskTotal: number | null = null;
    let depthBidWithinTicks: number | null = null;
    let depthAskWithinTicks: number | null = null;
    let depthBidWithinBps: number | null = null;
    let depthAskWithinBps: number | null = null;
    let depthImbalanceWithinTicks: number | null = null;

    let bidFirstGapTicks: number | null = null;
    let askFirstGapTicks: number | null = null;
    let bidMaxGapTicks: number | null = null;
    let askMaxGapTicks: number | null = null;

    if (tickSize != null) {
      const bb = bestBidIndex(book.bids);
      const ba = bestAskIndex(book.asks);

      if (bb != null) {
        bestBid = priceFromIndex(bb, tickSize);
        bestBidSz = scaledBigintToNumber(book.bids.get(bb) ?? 0n, sizeScale);
      }
      if (ba != null) {
        bestAsk = priceFromIndex(ba, tickSize);
        bestAskSz = scaledBigintToNumber(book.asks.get(ba) ?? 0n, sizeScale);
      }

      if (bestBid != null && bestAsk != null) {
        mid = (bestBid + bestAsk) / 2;
        spreadAbs = bestAsk - bestBid;
        spreadRel = mid > 0 ? spreadAbs / mid : null;
        spreadTicks = spreadAbs / tickSize;
      }

      if (bestBidSz != null && bestAskSz != null) {
        const denom = bestBidSz + bestAskSz;
        l1Imbalance = denom > 0 ? (bestBidSz - bestAskSz) / denom : null;

        if (bestBid != null && bestAsk != null) {
          microprice = denom > 0 ? (bestAsk * bestBidSz + bestBid * bestAskSz) / denom : null;
          micropriceMinusMid = microprice != null && mid != null ? microprice - mid : null;
        }
      }

      let bidTot = 0;
      for (const sz of book.bids.values()) bidTot += scaledBigintToNumber(sz, sizeScale);
      let askTot = 0;
      for (const sz of book.asks.values()) askTot += scaledBigintToNumber(sz, sizeScale);
      depthBidTotal = bidTot;
      depthAskTotal = askTot;

      if (bestBid != null && bestAsk != null) {
        const bbIdx = bb;
        const baIdx = ba;
        if (bbIdx != null && baIdx != null) {
          let bidK = 0;
          let askK = 0;

          const bidFloor = bbIdx - this.depthTicks;
          const askCeil = baIdx + this.depthTicks;

          for (const [idx, sz] of book.bids.entries()) {
            if (idx >= bidFloor && idx <= bbIdx) bidK += scaledBigintToNumber(sz, sizeScale);
          }
          for (const [idx, sz] of book.asks.entries()) {
            if (idx >= baIdx && idx <= askCeil) askK += scaledBigintToNumber(sz, sizeScale);
          }

          depthBidWithinTicks = bidK;
          depthAskWithinTicks = askK;
          const denom = bidK + askK;
          depthImbalanceWithinTicks = denom > 0 ? (bidK - askK) / denom : null;

          const bidIdxs: number[] = [];
          for (const idx of book.bids.keys()) {
            if (idx >= bbIdx - this.shapeTicks && idx <= bbIdx) bidIdxs.push(idx);
          }
          bidIdxs.sort((a, b) => b - a);

          const askIdxs: number[] = [];
          for (const idx of book.asks.keys()) {
            if (idx >= baIdx && idx <= baIdx + this.shapeTicks) askIdxs.push(idx);
          }
          askIdxs.sort((a, b) => a - b);

          bidFirstGapTicks = null;
          bidMaxGapTicks = null;
          for (let i = 0; i + 1 < bidIdxs.length; i++) {
            const gap = bidIdxs[i]! - bidIdxs[i + 1]! - 1;
            if (gap > 0) {
              if (bidFirstGapTicks == null) bidFirstGapTicks = gap;
              bidMaxGapTicks = bidMaxGapTicks == null ? gap : Math.max(bidMaxGapTicks, gap);
            }
          }

          askFirstGapTicks = null;
          askMaxGapTicks = null;
          for (let i = 0; i + 1 < askIdxs.length; i++) {
            const gap = askIdxs[i + 1]! - askIdxs[i]! - 1;
            if (gap > 0) {
              if (askFirstGapTicks == null) askFirstGapTicks = gap;
              askMaxGapTicks = askMaxGapTicks == null ? gap : Math.max(askMaxGapTicks, gap);
            }
          }
        }
      }

      if (mid != null && bestBid != null && bestAsk != null) {
        const band = (mid * this.depthBps) / 10_000;
        const lo = mid - band;
        const hi = mid + band;

        let bidBps = 0;
        let askBps = 0;

        for (const [idx, sz] of book.bids.entries()) {
          const px = priceFromIndex(idx, tickSize);
          if (px >= lo && px <= mid) bidBps += scaledBigintToNumber(sz, sizeScale);
        }
        for (const [idx, sz] of book.asks.entries()) {
          const px = priceFromIndex(idx, tickSize);
          if (px <= hi && px >= mid) askBps += scaledBigintToNumber(sz, sizeScale);
        }

        depthBidWithinBps = bidBps;
        depthAskWithinBps = askBps;
      }
    }

    const feedTs = Number(book.lastTimestamp);
    const t = Number.isFinite(feedTs) && feedTs > 0 ? feedTs : nowMs;

    const roll = this.rollup(t);
    const windowSec = roll.windowSec;

    const updatesPerSecBid = roll.bucket.bid.updates / windowSec;
    const updatesPerSecAsk = roll.bucket.ask.updates / windowSec;

    const addRateBid = roll.bucket.bid.adds / windowSec;
    const addRateAsk = roll.bucket.ask.adds / windowSec;

    const cancelRateBid = roll.bucket.bid.cancels / windowSec;
    const cancelRateAsk = roll.bucket.ask.cancels / windowSec;

    const cancelAddRatioBid = roll.bucket.bid.adds > 0 ? roll.bucket.bid.cancels / roll.bucket.bid.adds : null;
    const cancelAddRatioAsk = roll.bucket.ask.adds > 0 ? roll.bucket.ask.cancels / roll.bucket.ask.adds : null;

    const netOrderFlow = scaledBigintToNumber(roll.bucket.bid.deltaSigned - roll.bucket.ask.deltaSigned, sizeScale);

    const eventImbalance =
      roll.bucket.bid.updates + roll.bucket.ask.updates > 0
        ? (roll.bucket.bid.updates - roll.bucket.ask.updates) /
          (roll.bucket.bid.updates + roll.bucket.ask.updates)
        : null;

    const ofiL1 = scaledBigintToNumber(roll.bucket.bid.deltaSignedL1 - roll.bucket.ask.deltaSignedL1, sizeScale);
    const ofiLk = scaledBigintToNumber(roll.bucket.bid.deltaSignedLk - roll.bucket.ask.deltaSignedLk, sizeScale);
    const ofiWeighted = (roll.bucket.bid.deltaSignedWeighted - roll.bucket.ask.deltaSignedWeighted) / (10 ** sizeScale);

    const quoteFlickerPerSec = roll.bucket.bestPriceChanges / windowSec;

    const midVar = this.midStats.variance();
    const spreadVar = this.spreadStats.variance();

    // ---- scale-free features
    const samples = this.midSamples.toArray();
    const midAtOrBefore = (t: number): number | null => {
      for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i]!;
        if (s.t <= t) return s.mid;
      }
      return null;
    };

    const lr1 = mid != null ? (midAtOrBefore(t - 1000) != null ? logReturn(mid, midAtOrBefore(t - 1000)!) : null) : null;
    const lr5 = mid != null ? (midAtOrBefore(t - 5000) != null ? logReturn(mid, midAtOrBefore(t - 5000)!) : null) : null;
    const lr15 = mid != null ? (midAtOrBefore(t - 15000) != null ? logReturn(mid, midAtOrBefore(t - 15000)!) : null) : null;
    const lr60 = mid != null ? (midAtOrBefore(t - 60000) != null ? logReturn(mid, midAtOrBefore(t - 60000)!) : null) : null;

    // De-duplicate return samples: only accept one 1s-return per (feed) second.
    const bucket1s = Math.floor(t / 1000);
    const shouldSample = this.lastReturn1sBucket == null || bucket1s > this.lastReturn1sBucket;
    if (lr1 != null && shouldSample) {
      this.lastReturn1sBucket = bucket1s;
      this.r1sStats.push(t, lr1);
      this.r15mStats.push(t, lr1);
    }
    const r1sSigma = this.r1sStats.stddev();
    const r15mSigma = this.r15mStats.stddev();
    const r1sEma = lr1 != null ? this.r1sEma.update(t, lr1, this.regimeHalflifeMs) : this.r1sEma.get();
    const regimeScore =
      r1sEma != null && r1sSigma != null && r1sSigma > 0 ? Math.abs(r1sEma) / r1sSigma : null;

    this.ofiStats.push(t, ofiLk);
    const ofiSigma = this.ofiStats.stddev();
    const ofiLkNorm = ofiSigma != null && ofiSigma > 0 ? ofiLk / ofiSigma : null;
    const ofiNormEma = ofiLkNorm != null ? this.ofiNormEma.update(t, ofiLkNorm, this.persistenceHalflifeMs) : this.ofiNormEma.get();
    const ofiPersistence = ofiNormEma != null ? Math.abs(ofiNormEma) : null;

    if (l1Imbalance != null) this.imbStats.push(t, l1Imbalance);
    const imbSigma = this.imbStats.stddev();
    const l1ImbalanceNorm =
      l1Imbalance != null && imbSigma != null && imbSigma > 0 ? l1Imbalance / imbSigma : null;

    const agreeOfiAndR60s =
      ofiNormEma != null && lr60 != null
        ? (() => {
            const a = signnz(ofiNormEma);
            const b = signnz(lr60);
            return a !== 0 && b !== 0 ? a === b : null;
          })()
        : null;

    return {
      id,
      timestampMs: t,

      bestBid,
      bestAsk,
      mid,
      spreadAbs,
      spreadRel,
      spreadTicks,

      bestBidSize: bestBidSz,
      bestAskSize: bestAskSz,
      l1Imbalance,

      microprice,
      micropriceMinusMid,

      depthBidTotal,
      depthAskTotal,
      depthBidWithinTicks,
      depthAskWithinTicks,
      depthBidWithinBps,
      depthAskWithinBps,
      depthImbalanceWithinTicks,

      bidFirstGapTicks,
      askFirstGapTicks,
      bidMaxGapTicks,
      askMaxGapTicks,

      updatesPerSecBid,
      updatesPerSecAsk,
      addRateBid,
      addRateAsk,
      cancelRateBid,
      cancelRateAsk,
      cancelAddRatioBid,
      cancelAddRatioAsk,

      netOrderFlow,
      eventImbalance,

      ofiL1,
      ofiLk,
      ofiWeighted,
      ofiEmaShort: this.ofiEmaShortValue / (10 ** sizeScale),
      ofiEmaLong: this.ofiEmaLongValue / (10 ** sizeScale),

      quoteFlickerPerSec,

      midVar,
      spreadVar,

      logReturn1s: lr1,
      logReturn5s: lr5,
      logReturn15s: lr15,
      logReturn60s: lr60,

      r1sSigma,
      r15mSigma,
      ofiLkNorm,
      l1ImbalanceNorm,

      ofiNormEma,
      ofiPersistence,

      regimeScore,
      agreeOfiAndR60s,
    };
  }

  // ---- internals

  private bucketStart(t: number): number {
    return Math.floor(t / this.bucketMs) * this.bucketMs;
  }

  private bucketIndex(t0: number): number {
    return Math.floor(t0 / this.bucketMs) & this.bucketMask;
  }

  private currentBucket(nowMs: number): Bucket {
    const t0 = this.bucketStart(nowMs);
    const idx = this.bucketIndex(t0);
    const b = this.buckets[idx]!;
    if (b.t0 !== t0) resetBucket(b, t0);
    return b;
  }

  private advanceTo(nowMs: number): void {
    this.currentBucket(nowMs);
    const cutoff = nowMs - this.windowMs;
    for (const b of this.buckets) {
      if (b.t0 === 0) continue;
      if (b.t0 < cutoff) resetBucket(b, 0);
    }
  }

  private rollup(nowMs: number): { bucket: Bucket; windowSec: number } {
    if (this.eventBuf) {
      const arr = this.eventBuf.toArray();
      const oldest = arr.length ? arr[0]!.ts : nowMs;
      const newest = arr.length ? arr[arr.length - 1]!.ts : nowMs;
      const spanSec = Math.max(1e-3, (newest - oldest) / 1000);
      return {
        bucket: {
          t0: nowMs,
          bid: { ...this.eventRollBid },
          ask: { ...this.eventRollAsk },
          bestPriceChanges: this.eventBestPriceChanges,
        },
        windowSec: spanSec,
      };
    }

    const cutoff = nowMs - this.windowMs;
    const out: Bucket = {
      t0: nowMs,
      bid: makeSideAgg(),
      ask: makeSideAgg(),
      bestPriceChanges: 0,
    };

    for (const b of this.buckets) {
      if (b.t0 === 0) continue;
      if (b.t0 < cutoff) continue;

      out.bid.updates += b.bid.updates;
      out.bid.adds += b.bid.adds;
      out.bid.cancels += b.bid.cancels;
      out.bid.zeroSize += b.bid.zeroSize;
      out.bid.deltaAbs += b.bid.deltaAbs;
      out.bid.deltaSigned += b.bid.deltaSigned;
      out.bid.deltaSignedL1 += b.bid.deltaSignedL1;
      out.bid.deltaSignedLk += b.bid.deltaSignedLk;
      out.bid.deltaSignedWeighted += b.bid.deltaSignedWeighted;

      out.ask.updates += b.ask.updates;
      out.ask.adds += b.ask.adds;
      out.ask.cancels += b.ask.cancels;
      out.ask.zeroSize += b.ask.zeroSize;
      out.ask.deltaAbs += b.ask.deltaAbs;
      out.ask.deltaSigned += b.ask.deltaSigned;
      out.ask.deltaSignedL1 += b.ask.deltaSignedL1;
      out.ask.deltaSignedLk += b.ask.deltaSignedLk;
      out.ask.deltaSignedWeighted += b.ask.deltaSignedWeighted;

      out.bestPriceChanges += b.bestPriceChanges;
    }

    return { bucket: out, windowSec: this.windowMs / 1000 };
  }

  private applyToSideAgg(sideAgg: SideAgg, u: AppliedLevelUpdate): void {
    sideAgg.updates++;

    const delta = u.deltaSize;
    if (delta === 0n) {
      if (u.newSize === 0n) sideAgg.zeroSize++;
    } else if (delta > 0n) {
      sideAgg.adds++;
      sideAgg.deltaAbs += delta;
    } else {
      sideAgg.cancels++;
      sideAgg.deltaAbs += -delta;
    }

    sideAgg.deltaSigned += delta;

    const bestIdx = u.side === "bid" ? u.bestBidIndex : u.bestAskIndex;
    if (bestIdx != null) {
      const dist = u.side === "bid" ? bestIdx - u.priceIndex : u.priceIndex - bestIdx;
      if (dist === 0) sideAgg.deltaSignedL1 += delta;
      if (dist >= 0 && dist <= this.ofiDepthTicks) sideAgg.deltaSignedLk += delta;
      if (dist >= 0) {
        const w = 1 / (1 + dist);
        sideAgg.deltaSignedWeighted += w * Number(delta);
      }
    }
  }

  private applyEventRecord(u: AppliedLevelUpdate, ts: number, bestChanged: boolean): void {
    if (!this.eventBuf) return;

    const rec: EventRollRecord = {
      ts,
      side: u.side,
      adds: 0,
      cancels: 0,
      zeroSize: 0,
      deltaAbs: 0n,
      deltaSigned: 0n,
      deltaSignedL1: 0n,
      deltaSignedLk: 0n,
      deltaSignedWeighted: 0,
      bestPriceChanges: bestChanged ? 1 : 0,
    };

    const delta = u.deltaSize;
    rec.deltaSigned = delta;
    if (delta === 0n) {
      if (u.newSize === 0n) rec.zeroSize = 1;
    } else if (delta > 0n) {
      rec.adds = 1;
      rec.deltaAbs = delta;
    } else {
      rec.cancels = 1;
      rec.deltaAbs = -delta;
    }

    const bestIdx = u.side === "bid" ? u.bestBidIndex : u.bestAskIndex;
    if (bestIdx != null) {
      const dist = u.side === "bid" ? bestIdx - u.priceIndex : u.priceIndex - bestIdx;
      if (dist === 0) rec.deltaSignedL1 = delta;
      if (dist >= 0 && dist <= this.ofiDepthTicks) rec.deltaSignedLk = delta;
      if (dist >= 0) {
        const w = 1 / (1 + dist);
        rec.deltaSignedWeighted = w * Number(delta);
      }
    }

    while (this.eventBuf.isFull) {
      const old = this.eventBuf.shift();
      if (!old) break;
      this.subtractEvent(old);
    }

    this.eventBuf.push(rec);
    this.addEvent(rec);

    if (this.eventWindowUpdates != null) {
      while (this.eventBuf.size > this.eventWindowUpdates) {
        const old = this.eventBuf.shift();
        if (!old) break;
        this.subtractEvent(old);
      }
    }
  }

  private addEvent(rec: EventRollRecord): void {
    const side = rec.side === "bid" ? this.eventRollBid : this.eventRollAsk;
    side.updates += 1;
    side.adds += rec.adds;
    side.cancels += rec.cancels;
    side.zeroSize += rec.zeroSize;
    side.deltaAbs += rec.deltaAbs;
    side.deltaSigned += rec.deltaSigned;
    side.deltaSignedL1 += rec.deltaSignedL1;
    side.deltaSignedLk += rec.deltaSignedLk;
    side.deltaSignedWeighted += rec.deltaSignedWeighted;
    this.eventBestPriceChanges += rec.bestPriceChanges;
  }

  private subtractEvent(rec: EventRollRecord): void {
    const side = rec.side === "bid" ? this.eventRollBid : this.eventRollAsk;
    side.updates -= 1;
    side.adds -= rec.adds;
    side.cancels -= rec.cancels;
    side.zeroSize -= rec.zeroSize;
    side.deltaAbs -= rec.deltaAbs;
    side.deltaSigned -= rec.deltaSigned;
    side.deltaSignedL1 -= rec.deltaSignedL1;
    side.deltaSignedLk -= rec.deltaSignedLk;
    side.deltaSignedWeighted -= rec.deltaSignedWeighted;
    this.eventBestPriceChanges -= rec.bestPriceChanges;
  }

  private updateOfiEma(nowMs: number, ofiIncrement: number): void {
    const last = this.lastEmaTs;
    this.lastEmaTs = nowMs;

    if (last == null) {
      this.ofiEmaShortValue = ofiIncrement;
      this.ofiEmaLongValue = ofiIncrement;
      return;
    }

    const dt = Math.max(0, nowMs - last);

    const ln2 = Math.log(2);
    const aShort = 1 - Math.exp((-ln2 * dt) / this.ofiEmaShortHalflifeMs);
    const aLong = 1 - Math.exp((-ln2 * dt) / this.ofiEmaLongHalflifeMs);

    this.ofiEmaShortValue = this.ofiEmaShortValue + aShort * (ofiIncrement - this.ofiEmaShortValue);
    this.ofiEmaLongValue = this.ofiEmaLongValue + aLong * (ofiIncrement - this.ofiEmaLongValue);
  }
}

export class MicrostructureFeatureAccumulator {
  private readonly options: MicrostructureFeatureOptions | undefined;
  private readonly perId: Map<string, SymbolMicrostructureState> = new Map();

  constructor(options?: MicrostructureFeatureOptions) {
    this.options = options;
  }

  private state(id: string): SymbolMicrostructureState {
    const existing = this.perId.get(id);
    if (existing) return existing;
    const created = new SymbolMicrostructureState(this.options);
    this.perId.set(id, created);
    return created;
  }

  onAppliedLevelUpdate(u: AppliedLevelUpdate): void {
    this.state(u.id).onAppliedLevelUpdate(u);
  }

  /** Call periodically after `drainOnce()` to update rolling mid/spread moments. */
  observeBook(id: string, book: OrderbookState, sizeScale: number, nowMs: number): void {
    this.state(id).observeBook(book, sizeScale, nowMs);
  }

  computeSnapshot(id: string, book: OrderbookState, sizeScale: number, nowMs: number): MicrostructureSnapshot {
    return this.state(id).computeSnapshot(id, book, sizeScale, nowMs);
  }
}
