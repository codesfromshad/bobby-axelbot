import { BinanceSpotOrderbookEngine } from "../infra/exchanges/binance/spot.orderbook";
import { Volatility15mAccumulator } from "../features/volatility/volatility15m";
import { setSeconds, setMilliseconds, setMinutes, startOfHour } from "date-fns";

const SYMBOLS = ["BTCUSDT"] as const;

const DISPLAY_LEVELS = 20;
const SIZE_SCALE = 8;
// Display aggregation: group levels into ~$ bins for readability.
// Example: 5 means show depth in $5 buckets (rounded to nearest tick).
const DISPLAY_BUCKET_USD = 10;

function formatScaledBigInt(value: bigint, scale: number): string {
  const neg = value < 0n;
  let s = (neg ? -value : value).toString();
  if (scale === 0) return (neg ? "-" : "") + s;

  if (s.length <= scale) s = s.padStart(scale + 1, "0");
  const intPart = s.slice(0, -scale);
  let fracPart = s.slice(-scale);
  fracPart = fracPart.replace(/0+$/, "");
  return (neg ? "-" : "") + (fracPart.length ? `${intPart}.${fracPart}` : intPart);
}

function idxToPrice(priceIndex: number, tickSize: number): number {
  return priceIndex * tickSize;
}

function topLevels(
  book: Map<number, bigint>,
  side: "bid" | "ask",
  n: number
): Array<[priceIndex: number, size: bigint]> {
  const arr = Array.from(book.entries());
  arr.sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0]));
  return arr.slice(0, n) as Array<[number, bigint]>;
}

function topAggregatedLevels(args: {
  book: Map<number, bigint>;
  side: "bid" | "ask";
  n: number;
  bucketTicks: number;
}): Array<[bucketStartIndex: number, size: bigint]> {
  const { book, side, n, bucketTicks } = args;
  const bt = Math.max(1, Math.floor(bucketTicks));

  const agg = new Map<number, bigint>();
  for (const [idx, sz] of book.entries()) {
    const bucketStart = Math.floor(idx / bt) * bt;
    agg.set(bucketStart, (agg.get(bucketStart) ?? 0n) + sz);
  }

  const arr = Array.from(agg.entries());
  arr.sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0]));
  return arr.slice(0, n) as Array<[number, bigint]>;
}

const engine = new BinanceSpotOrderbookEngine(SYMBOLS, {
  ringCapacity: 4096,
  sizeScale: SIZE_SCALE,
  snapshotLimit: 1000,
  wsUpdateMs: 100,
}).connect();

const features = new Volatility15mAccumulator();

function phi(x: number): number {
  // Standard normal CDF via erf approximation.
  // Abramowitz-Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * erf);
}

function quarterHourAnchorMs(tMs: number): number {
  // Anchor to :00, :15, :30, :45 of the hour in local time.
  const d = new Date(tMs);
  const m = d.getMinutes();
  const q = m - (m % 15);
  const base = startOfHour(d);
  return setMilliseconds(setSeconds(setMinutes(base, q), 0), 0).getTime();
}

function fmtLocal(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

const kByQuarterHour = new Map<number, number>();
const HORIZON_MS = 15 * 60 * 1000;

// Volatility can be wildly under-estimated early (small sampleCount) or during quiet microstructure.
// Add a gentle floor so p_up/p_down don't instantly saturate to 0/1.
const SIGMA15M_FLOOR = 0.0035; // 0.35% stddev of log-return over 15 minutes
const SIGMA_TRUST_SAMPLES = 300; // after ~5 minutes of 1s samples, trust observed vol

// Small conditional-path tilt from very recent returns.
// This is intentionally tiny (a few % points max) and strongest near the barrier.
const MOMENTUM_TILT_MAX = 0.025;
// Scale for 1s log returns (unitless). Typical 1s BTC log-return magnitudes are ~1e-6..1e-4.
const MOMENTUM_RET_SCALE = 2e-5;

function effectiveSigma15m(observed: number | null, sampleCount: number): number | null {
  const n = Math.max(0, sampleCount);
  const w = Math.min(1, n / SIGMA_TRUST_SAMPLES);
  const floor = SIGMA15M_FLOOR;

  if (observed == null || !Number.isFinite(observed) || observed <= 0) return floor;
  const obs2 = observed * observed;
  const floor2 = floor * floor;
  // Blend early, but never allow vol to fall below the tail-risk floor.
  const blended = Math.sqrt(w * obs2 + (1 - w) * floor2);
  return Math.max(floor, blended);
}

/**
 * Minimal Polymarket-style pricer for an Up/Down binary settling at time expiry.
 *
 * Important: this is intentionally *not* a stacked heuristic model.
 * - Base model is driftless diffusion in log-price over the remaining time.
 * - Apply a first-passage/path correction to avoid pricing the wrong event.
 *   From below: reflection principle approximation P(hit K before T | m < K) ≈ 2·P(S_T > K).
 *   From above: markets discount “already above by a few ticks” via return-to-barrier risk;
 *   we apply a simple mean-reversion penalty to avoid p saturating to ~1 in crushed vol.
 * - Add soft bounds to avoid fake certainty minutes before expiry.
 */
type FairUpQuote = {
  p: number;
  pTerminal: number;
  pFirstPass: number;
  momentumAdj: number;
  z: number;
  sigmaT: number;
  Tfrac: number;
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Minimal Polymarket-style pricer for an Up/Down binary settling at time expiry.
 *
 * This intentionally avoids the previous “stack of corrections” that can fight each other.
 * The pieces here are ordered and scoped so they stay stable:
 *
 * 1) Driftless terminal probability
 *    pTerminal = P(S_T > K) under log-price Brownian motion with 0 drift.
 *
 * 2) One-sided first-passage (crossing) adjustment ONLY when starting below K
 *    From below, the probability of ever touching K before expiry is larger than the
 *    terminal probability; a classic approximation is:
 *      P(hit K before T | m < K) ≈ 2 * P(S_T > K)
 *    This is the “reflection principle” shortcut and it is NOT applied when m > K.
 *
 * 3) Small momentum tilt (path conditioning)
 *    If the most recent return is negative, slightly tilt p downward, and vice-versa.
 *    This makes p react to short-run direction even when m is only a hair above K.
 *    It is weighted to be strongest near the barrier (|z| small) to avoid nonsense far away.
 *
 * Finally, apply soft bounds: markets hate true certainty minutes before expiry.
 */
function fairUpQuote(args: {
  m: number;
  K: number;
  sigma15m: number;
  timeRemainingMs: number;
  logReturn1s?: number | null;
}): FairUpQuote {
  const { m, K, sigma15m, timeRemainingMs, logReturn1s } = args;

  const Tfrac = Math.max(1e-6, timeRemainingMs / HORIZON_MS);
  const sigmaT = sigma15m * Math.sqrt(Tfrac);

  if (!Number.isFinite(sigmaT) || sigmaT <= 0) {
    const pFallback = m >= K ? 0.8 : 0.2;
    return {
      p: pFallback,
      pTerminal: pFallback,
      pFirstPass: pFallback,
      momentumAdj: 0,
      z: 0,
      sigmaT,
      Tfrac,
    };
  }

  const z = Math.log(m / K) / sigmaT;

  // --- 1) Terminal probability ---
  const pTerminal = phi(z);

  // --- 2) First-passage probability (reflection principle) ---
  let pFirstPass: number;
  if (m < K) {
    // Correct approximation
    pFirstPass = clamp(2 * (1 - phi(Math.abs(z))), 0, 0.98);
  } else {
    // Already above barrier: discount shallow “above K” via return-to-barrier / mean-reversion risk.
    // Heuristic: apply a Gaussian penalty in sigmaT-units.
    const dist = z;
    const reversionPenalty = Math.exp(-0.5 * dist * dist);
    pFirstPass = clamp(pTerminal * reversionPenalty, 0.05, 0.95);
  }

  // --- 3) Momentum tilt (ONLY when near barrier) ---
  let momentumAdj = 0;
  if (
    logReturn1s != null &&
    Number.isFinite(logReturn1s) &&
    Math.abs(z) < 0.8 // << critical fix
  ) {
    const signed = Math.tanh(logReturn1s / MOMENTUM_RET_SCALE);
    const nearBarrierWeight = Math.exp(-z * z);
    momentumAdj = MOMENTUM_TILT_MAX * signed * nearBarrierWeight;
  }

  const pRaw = pFirstPass + momentumAdj;

  // --- 4) Soft bounds ---
  const p = clamp(pRaw, 0.03, 0.97);

  return { p, pTerminal, pFirstPass, momentumAdj, z, sigmaT, Tfrac };
}


// If you start the process *after* the quarter-hour anchor (e.g. at 02:23),
// the true K at 02:15 cannot be inferred from a live orderbook.
// Provide an override for the current anchor to get correct pricing.
// Key is the anchor timestamp in ms (see `quarterHourAnchorMs`).
const K_OVERRIDE_BY_ANCHOR_MS: Record<string, number> = {
  // Example:
  [String(new Date(2026, 0, 13, 17, 15, 0, 0).getTime())]: 92218.36,
};

// Convenience: if you think in terms of the *settlement time* (end of the bucket),
// you can also override by expiry timestamp.
// Example: for the 16:45→17:00 bucket, expiry is 17:00 and anchor is 16:45.
const K_OVERRIDE_BY_EXPIRY_MS: Record<string, number> = {
  // Example:
  // [String(new Date(2026, 0, 13, 17, 0, 0, 0).getTime())]: 92128.63,
};

// Only infer K automatically if the first observation is close to the anchor.
const K_INFER_MAX_LAG_MS = 10_000;

// Drain fast; render slower.
setInterval(() => engine.drainOnce(), 5);

let lastVersions: Record<string, bigint> = {};
let lastTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTime) / 1000;
  let totalUpdates = 0;
  let perBook: string[] = [];

  // eslint-disable-next-line no-console
  console.clear();

  for (const symbol of SYMBOLS) {
    const ob = engine.getOrderbook(symbol);
    if (!ob) continue;

    features.observeBook(symbol, ob, now);

    const prev = lastVersions[symbol] ?? 0n;
    const updates = Number(ob.version - prev);
    totalUpdates += updates;
    perBook.push(`${symbol}: ${updates} upd/s`);
    lastVersions[symbol] = ob.version;

    // eslint-disable-next-line no-console
    console.log("=");
    // eslint-disable-next-line no-console
    console.log("symbol:", symbol);
    // eslint-disable-next-line no-console
    console.log(
      "tickSize:",
      ob.tickSize ?? "(waiting)",
      "version:",
      ob.version.toString(),
      "ts:",
      ob.lastTimestamp.toString()
    );

    if (ob.tickSize == null) {
      // eslint-disable-next-line no-console
      console.log("waiting for tickSize/snapshot...");
      continue;
    }

    const bucketTicks = Math.max(1, Math.round(DISPLAY_BUCKET_USD / ob.tickSize));

    const rawBids = topLevels(ob.bids, "bid", DISPLAY_LEVELS);
    const rawAsks = topLevels(ob.asks, "ask", DISPLAY_LEVELS);

    const bids = topAggregatedLevels({
      book: ob.bids,
      side: "bid",
      n: DISPLAY_LEVELS,
      bucketTicks,
    });
    const asks = topAggregatedLevels({
      book: ob.asks,
      side: "ask",
      n: DISPLAY_LEVELS,
      bucketTicks,
    });

    const bestBid = rawBids.length ? idxToPrice(rawBids[0]![0], ob.tickSize) : null;
    const bestAsk = rawAsks.length ? idxToPrice(rawAsks[0]![0], ob.tickSize) : null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

    // eslint-disable-next-line no-console
    console.log(
      "bestBid:",
      bestBid?.toFixed(8) ?? "-",
      "bestAsk:",
      bestAsk?.toFixed(8) ?? "-",
      "spread:",
      spread?.toFixed(8) ?? "-"
    );

    const snap = features.computeSnapshot(symbol, ob, now);

    // Reference price K: mid at the quarter-hour anchor.
    const anchor = quarterHourAnchorMs(snap.timestampMs);
    const expiryMs = anchor + 15 * 60 * 1000;

    // Apply manual overrides first.
    // Common gotcha: users often override 17:00 thinking it's the anchor, but it's actually the expiry.
    const overrideKAnchor = K_OVERRIDE_BY_ANCHOR_MS[String(anchor)];
    const overrideKExpiry = K_OVERRIDE_BY_EXPIRY_MS[String(expiryMs)];
    const overrideK = overrideKAnchor ?? overrideKExpiry ?? null;
    if (overrideK != null && Number.isFinite(overrideK) && overrideK > 0) {
      kByQuarterHour.set(anchor, overrideK);
    }

    // Infer K only if we are close to the anchor; otherwise leave it unset.
    if (!kByQuarterHour.has(anchor) && snap.mid != null) {
      const lag = snap.timestampMs - anchor;
      if (lag >= 0 && lag <= K_INFER_MAX_LAG_MS) {
        kByQuarterHour.set(anchor, snap.mid);
      }
    }

    const K = kByQuarterHour.get(anchor) ?? null;

    // Time-to-expiry: until the end of the current quarter-hour bucket.
    const timeRemainingMs = Math.max(0, expiryMs - snap.timestampMs);
    const sigma15m = effectiveSigma15m(snap.vol15m, snap.sampleCount);

    // Minimal, stable fair probability model.
    const pUp =
      snap.mid != null && K != null && sigma15m != null && sigma15m > 0 && timeRemainingMs > 0
        ? (() => {
            const m = snap.mid!;
            const q = fairUpQuote({ m, K, sigma15m, timeRemainingMs, logReturn1s: snap.logReturn });
            return q.p;
          })()
        : snap.mid != null && K != null && timeRemainingMs === 0
          ? (snap.mid > K ? 1 : 0)
          : null;
    const pDown = pUp != null ? 1 - pUp : null;

    const fairYesUp = pUp;
    const fairYesDown = pDown;
    // Table view is much easier to scan than JSON for fast iteration.
    // eslint-disable-next-line no-console
    console.table([
      {
        anchorMs: anchor,
        anchorLocal: fmtLocal(anchor),
        expiryMs,
        expiryLocal: fmtLocal(expiryMs),
        mid: snap.mid,
        r1s: snap.logReturn,
        vol15m: snap.vol15m,
        n: snap.sampleCount,
        K,
        K_overrideUsed: overrideK,
        timeRemainingMs,
        // Diagnostics for debugging the fair-value model.
        // If probabilities look “stuck”, check z / sigmaT / pTerminal.
        ...(snap.mid != null && K != null && sigma15m != null && sigma15m > 0 && timeRemainingMs > 0
          ? (() => {
              const q = fairUpQuote({
                m: snap.mid!,
                K,
                sigma15m,
                timeRemainingMs,
                logReturn1s: snap.logReturn,
              });
              return {
                z: q.z,
                sigmaT: q.sigmaT,
                p_terminal: q.pTerminal,
                p_firstPass: q.pFirstPass,
                p_momentumAdj: q.momentumAdj,
              };
            })()
          : null),
        p_up: pUp,
        p_down: pDown,
        fairYesUp,
        fairYesDown,
      },
    ]);

    // eslint-disable-next-line no-console
    console.log(`\nASKS (~$${DISPLAY_BUCKET_USD} bins; ${bucketTicks} ticks/bin) (priceRange -> size)`);
    for (const [bucketStartIdx, size] of asks) {
      const lo = idxToPrice(bucketStartIdx, ob.tickSize);
      const hi = idxToPrice(bucketStartIdx + bucketTicks - 1, ob.tickSize);
      // eslint-disable-next-line no-console
      console.log(
        `${lo.toFixed(8)}..${hi.toFixed(8)}`.padStart(30),
        " -> ",
        formatScaledBigInt(size, SIZE_SCALE)
      );
    }

    // eslint-disable-next-line no-console
    console.log(`\nBIDS (~$${DISPLAY_BUCKET_USD} bins; ${bucketTicks} ticks/bin) (priceRange -> size)`);
    for (const [bucketStartIdx, size] of bids) {
      const lo = idxToPrice(bucketStartIdx, ob.tickSize);
      const hi = idxToPrice(bucketStartIdx + bucketTicks - 1, ob.tickSize);
      // eslint-disable-next-line no-console
      console.log(
        `${lo.toFixed(8)}..${hi.toFixed(8)}`.padStart(30),
        " -> ",
        formatScaledBigInt(size, SIZE_SCALE)
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    "\nOrderbook update throughput:",
    Math.round(totalUpdates / Math.max(1e-9, dt)),
    "updates/sec",
    perBook.join(" | ")
  );

  lastTime = now;
}, 5);

process.on("SIGINT", () => {
  engine.disconnect();
  process.exit(0);
});
