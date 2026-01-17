import { LiveOrderbookEngine } from "../infra/exchanges/polymarket/live.orderbook";
import { Volatility15mAccumulator } from "../features/volatility/volatility15m";
import { BinanceSpotOrderbookEngine } from "../infra/exchanges/binance/spot.orderbook";
import { setSeconds, setMilliseconds, setMinutes, startOfHour } from "date-fns";

const CLOB_TOKEN_IDS = [
  // outcome: up
  "8547840444447283166292105246767534359391748202933909101209110054290120449481",
  // outcome: down
  "100454805810903676084444808265391436602820324423071566574500542850002678015400"
] as const;

const DISPLAY_LEVELS = 12;
const SIZE_SCALE = 6;

const BTC_SYMBOLS = ["BTCUSDT"] as const;
const BTC_SIZE_SCALE = 8;

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

const engine = new LiveOrderbookEngine(CLOB_TOKEN_IDS, {
  ringCapacity: 4096,
  sizeScale: SIZE_SCALE,
  defaultTickSize: 0.01,
}).connect();

const btcEngine = new BinanceSpotOrderbookEngine(BTC_SYMBOLS, {
  ringCapacity: 4096,
  sizeScale: BTC_SIZE_SCALE,
  snapshotLimit: 1000,
  wsUpdateMs: 100,
}).connect();

const features = new Volatility15mAccumulator();

const HORIZON_MS = 15 * 60 * 1000;

// Volatility can be under-estimated in quiet microstructure; add a floor so p doesn't saturate.
const SIGMA15M_FLOOR = 0.0035; // 0.35% stddev of log-return over 15 minutes
const SIGMA_TRUST_SAMPLES = 300; // after ~5 minutes of 1s samples, trust observed vol

// Overreaction heuristics (tune these against real fills).
// All are intentionally conservative: avoid trading every wiggle.
const MIN_MISPRICING = 0.03; // 3 cents on the YES price
const OVERREACTION_Z = 2.0; // mispricing measured in “sigmaT units” (heuristic)
const OVERREACTION_VSIG = 2.0; // velocity measured in “sigmaT per second” (heuristic)

// Small path-conditioning tilt from very recent BTC returns.
// Used only to make p respond when BTC is barely above/below K.
const MOMENTUM_TILT_MAX = 0.02;
const MOMENTUM_RET_SCALE = 2e-5;

function phi(x: number): number {
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

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function effectiveSigma15m(observed: number | null, sampleCount: number): number | null {
  const n = Math.max(0, sampleCount);
  const w = Math.min(1, n / SIGMA_TRUST_SAMPLES);
  const floor = SIGMA15M_FLOOR;

  if (observed == null || !Number.isFinite(observed) || observed <= 0) return floor;
  const obs2 = observed * observed;
  const floor2 = floor * floor;
  const blended = Math.sqrt(w * obs2 + (1 - w) * floor2);
  return Math.max(floor, blended);
}

type FairUpQuote = {
  p: number;
  pTerminal: number;
  pFirstPass: number;
  momentumAdj: number;
  z: number;
  sigmaT: number;
  Tfrac: number;
};

/**
 * Fair probability for the UP leg of the binary.
 *
 * This is a minimal model with a stable ordering:
 * 1) Driftless terminal probability: P(S_T > K)
 * 2) One-sided first-passage correction ONLY when starting below K
 * 3) Small momentum tilt from most recent BTC return (strongest near K)
 * 4) Soft bounds to avoid fake certainty
 */
function fairUpQuote(args: {
  S0: number;
  K: number;
  sigma15m: number;
  timeRemainingMs: number;
  logReturn1s?: number | null;
}): FairUpQuote {
  const { S0, K, sigma15m, timeRemainingMs, logReturn1s } = args;

  const Tfrac = Math.max(1e-6, timeRemainingMs / HORIZON_MS);
  const sigmaT = sigma15m * Math.sqrt(Tfrac);

  if (!Number.isFinite(sigmaT) || sigmaT <= 0) {
    const pFallback = S0 > K ? 0.75 : 0.25;
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

  const z = Math.log(S0 / K) / sigmaT;
  const pTerminal = phi(z);

  // Path-aware adjustment: the market discounts shallow excursions above K.
  // From below we use the reflection-principle shortcut; from above we apply a mean-reversion penalty.
  let pFirstPass: number;
  if (S0 < K) {
    pFirstPass = clamp(2 * pTerminal, 0.05, 0.95);
  } else {
    const dist = z;
    const reversionPenalty = Math.exp(-0.5 * dist * dist);
    pFirstPass = clamp(pTerminal * reversionPenalty, 0.05, 0.95);
  }

  let momentumAdj = 0;
  if (logReturn1s != null && Number.isFinite(logReturn1s) && logReturn1s !== 0) {
    const signed = Math.tanh(logReturn1s / MOMENTUM_RET_SCALE);
    const nearBarrierWeight = Math.exp(-0.5 * z * z);
    momentumAdj = MOMENTUM_TILT_MAX * signed * nearBarrierWeight;
  }

  const pRaw = pFirstPass + momentumAdj;
  const p = clamp(pRaw, 0.05, 0.95);
  return { p, pTerminal, pFirstPass, momentumAdj, z, sigmaT, Tfrac };
}

function quarterHourAnchorMs(tMs: number): number {
  const d = new Date(tMs);
  const m = d.getMinutes();
  const q = m - (m % 15);
  const base = startOfHour(d);
  return setMilliseconds(setSeconds(setMinutes(base, q), 0), 0).getTime();
}

/**
 * Quarter-hour anchor in UTC.
 *
 * Many venues define “15 minute buckets” on UTC boundaries.
 * Using UTC avoids local timezone/DST surprises.
 */
function quarterHourAnchorMsUtc(tMs: number): number {
  const d = new Date(tMs);
  const q = d.getUTCMinutes() - (d.getUTCMinutes() % 15);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), q, 0, 0);
}

const kByQuarterHour = new Map<number, number>();

// Same K semantics as the Binance demo: if you start after the anchor,
// you cannot infer the true anchor mid without historical data.
const K_OVERRIDE_BY_ANCHOR_MS: Record<string, number> = {
  // Example:
  [String(new Date(2026, 0, 13, 17, 0, 0, 0).getTime())]: 92128.63,
};
const K_INFER_MAX_LAG_MS = 10_000;

type LastPx = { t: number; mid: number };
const lastYesMidByToken = new Map<string, LastPx>();

function bestBidAskMid(book: Map<number, bigint>, side: "bid" | "ask", tickSize: number): number | null {
  let best: number | null = null;
  for (const idx of book.keys()) {
    if (best == null) best = idx;
    else best = side === "bid" ? Math.max(best, idx) : Math.min(best, idx);
  }
  return best == null ? null : idxToPrice(best, tickSize);
}

// Drain fast; render slower.
setInterval(() => engine.drainOnce(), 10);
setInterval(() => btcEngine.drainOnce(), 5);


// Benchmark: show orderbook update throughput (updates/sec)
let lastVersions: Record<string, bigint> = {};
let lastTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTime) / 1000;
  let totalUpdates = 0;
  let perBook: string[] = [];

  // eslint-disable-next-line no-console
  console.clear();

  // --- BTC fair value inputs (S0, K, sigma)
  const btcOb = btcEngine.getOrderbook(BTC_SYMBOLS[0]);
  const btcSnap = btcOb ? (features.observeBook(BTC_SYMBOLS[0], btcOb, now), features.computeSnapshot(BTC_SYMBOLS[0], btcOb, now)) : null;

  const S0 = btcSnap?.mid ?? null;
  const sigma15m = effectiveSigma15m(btcSnap?.vol15m ?? null, btcSnap?.sampleCount ?? 0);
  const tMs = btcSnap?.timestampMs ?? now;
  const anchorLocal = quarterHourAnchorMs(tMs);
  const anchorUtc = quarterHourAnchorMsUtc(tMs);

  // If your K override “doesn’t work”, it’s almost always because you keyed
  // it to the wrong anchor convention (local vs UTC). We support both:
  // - compute both anchors
  // - if an override exists for either, prefer that anchor
  // - otherwise default to UTC (more robust for market buckets)
  let anchor = anchorUtc;
  let overrideK = K_OVERRIDE_BY_ANCHOR_MS[String(anchor)] ?? null;
  if (overrideK == null) {
    const local = K_OVERRIDE_BY_ANCHOR_MS[String(anchorLocal)] ?? null;
    const utc = K_OVERRIDE_BY_ANCHOR_MS[String(anchorUtc)] ?? null;
    if (local != null) {
      anchor = anchorLocal;
      overrideK = local;
    } else if (utc != null) {
      anchor = anchorUtc;
      overrideK = utc;
    }
  }

  const expiryMs = anchor + 15 * 60 * 1000;
  const timeRemainingMs = Math.max(0, expiryMs - tMs);

  if (overrideK != null && Number.isFinite(overrideK) && overrideK > 0) {
    kByQuarterHour.set(anchor, overrideK);
  }

  if (!kByQuarterHour.has(anchor) && S0 != null) {
    const lag = tMs - anchor;
    if (lag >= 0 && lag <= K_INFER_MAX_LAG_MS) {
      kByQuarterHour.set(anchor, S0);
    }
  }

  const K = kByQuarterHour.get(anchor) ?? null;

  const upQuote =
    S0 != null && K != null && sigma15m != null && sigma15m > 0 && timeRemainingMs > 0
      ? fairUpQuote({
          S0,
          K,
          sigma15m,
          timeRemainingMs,
          // exactOptionalPropertyTypes: don't pass `undefined`.
          logReturn1s: btcSnap?.logReturn ?? null,
        })
      : null;
  const fairUp = upQuote?.p ?? null;
  const fairDown = fairUp != null ? 1 - fairUp : null;

  // eslint-disable-next-line no-console
  console.table([
    {
      S0,
      K,
      sigma15m,
      timeRemainingMs,
      // Anchor keys to help you set K overrides correctly.
      // Use the *numeric key* shown here inside K_OVERRIDE_BY_ANCHOR_MS.
      anchor,
      anchorLocal,
      anchorUtc,
      anchorIso: new Date(anchor).toISOString(),
      z: upQuote?.z ?? null,
      sigmaT: upQuote?.sigmaT ?? null,
      p_terminal: upQuote?.pTerminal ?? null,
      p_firstPass: upQuote?.pFirstPass ?? null,
      p_momentumAdj: upQuote?.momentumAdj ?? null,
      fairUp,
      fairDown,
    },
  ]);

  const rows: Array<Record<string, unknown>> = [];
  const upTokenId = CLOB_TOKEN_IDS[0];
  const downTokenId = CLOB_TOKEN_IDS[1];
  let marketUpMid: number | null = null;
  let marketDownMid: number | null = null;

  for (const id of CLOB_TOKEN_IDS) {
    const ob = engine.getOrderbook(id);
    if (!ob) continue;

    features.observeBook(id, ob, now);

    // Throughput calculation
    const prev = lastVersions[id] ?? 0n;
    const updates = Number(ob.version - prev);
    totalUpdates += updates;
    perBook.push(`${id.slice(0, 8)}: ${updates} upd/s`);
    lastVersions[id] = ob.version;

    // eslint-disable-next-line no-console
    console.log("=");
    // eslint-disable-next-line no-console
    console.log("clobTokenId:", id);
    // eslint-disable-next-line no-console
    console.log("tickSize:", ob.tickSize ?? "(waiting)", "version:", ob.version.toString(), "ts:", ob.lastTimestamp.toString());

    if (ob.tickSize == null) {
      // eslint-disable-next-line no-console
      console.log("waiting for initial book...");
      continue;
    }

    const bids = topLevels(ob.bids, "bid", DISPLAY_LEVELS);
    const asks = topLevels(ob.asks, "ask", DISPLAY_LEVELS);

    const bestBid = bids.length ? idxToPrice(bids[0]![0], ob.tickSize) : null;
    const bestAsk = asks.length ? idxToPrice(asks[0]![0], ob.tickSize) : null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

    // eslint-disable-next-line no-console
    console.log("bestBid:", bestBid?.toFixed(6) ?? "-", "bestAsk:", bestAsk?.toFixed(6) ?? "-", "spread:", spread?.toFixed(6) ?? "-");

    // Polymarket YES token best bid/ask are already probabilities in [0,1].
    const yesBid = ob.tickSize != null ? bestBidAskMid(ob.bids, "bid", ob.tickSize) : null;
    const yesAsk = ob.tickSize != null ? bestBidAskMid(ob.asks, "ask", ob.tickSize) : null;
    const yesMid = yesBid != null && yesAsk != null ? (yesBid + yesAsk) / 2 : null;

    const isUp = id === CLOB_TOKEN_IDS[0];
    const fairYes = isUp ? fairUp : fairDown;

    if (isUp) marketUpMid = yesMid;
    else marketDownMid = yesMid;

    const mispricingMid = fairYes != null && yesMid != null ? yesMid - fairYes : null;
    const zOverreaction =
      mispricingMid != null && upQuote?.sigmaT != null && upQuote.sigmaT > 0
        ? mispricingMid / upQuote.sigmaT
        : null;

    // Microstructure: very short-horizon market price velocity.
    let velocityPps: number | null = null; // probability points per second
    let velocitySigmaPerSec: number | null = null;
    if (yesMid != null) {
      const prev = lastYesMidByToken.get(id) ?? null;
      if (prev) {
        const dtSec = Math.max(1e-6, (now - prev.t) / 1000);
        velocityPps = (yesMid - prev.mid) / dtSec;
        if (upQuote?.sigmaT != null && upQuote.sigmaT > 0) {
          velocitySigmaPerSec = velocityPps / upQuote.sigmaT;
        }
      }
      lastYesMidByToken.set(id, { t: now, mid: yesMid });
    }

    // Signal: if the market YES mid has sprinted above fair value fast, fade it and hedge with the other leg.
    // Note: this is a *signal generator* only (no execution here).
    const isOverheated =
      mispricingMid != null &&
      zOverreaction != null &&
      velocitySigmaPerSec != null &&
      mispricingMid > MIN_MISPRICING &&
      zOverreaction > OVERREACTION_Z &&
      velocitySigmaPerSec > OVERREACTION_VSIG;

    const signal = isOverheated
      ? isUp
        ? "SHORT_UP_YES + LONG_DOWN_YES"
        : "SHORT_DOWN_YES + LONG_UP_YES"
      : "";

    rows.push({
      outcome: isUp ? "UP" : "DOWN",
      fairYes,
      yesBid,
      yesAsk,
      yesMid,
      mispricingMid,
      zOverreaction,
      velocityPps,
      velocitySigmaPerSec,
      signal,
    });

    // eslint-disable-next-line no-console
    console.log("\nASKS (price -> size)");
    for (const [idx, size] of asks) {
      const px = idxToPrice(idx, ob.tickSize);
      // eslint-disable-next-line no-console
      console.log(px.toFixed(6).padStart(12), " -> ", formatScaledBigInt(size, SIZE_SCALE));
    }

    // eslint-disable-next-line no-console
    console.log("\nBIDS (price -> size)");
    for (const [idx, size] of bids) {
      const px = idxToPrice(idx, ob.tickSize);
      // eslint-disable-next-line no-console
      console.log(px.toFixed(6).padStart(12), " -> ", formatScaledBigInt(size, SIZE_SCALE));
    }
  }

  // Summary tables (scan-friendly)
  const pairSumMid = marketUpMid != null && marketDownMid != null ? marketUpMid + marketDownMid : null;
  // eslint-disable-next-line no-console
  console.table(rows);
  // eslint-disable-next-line no-console
  console.table([
    {
      marketUpMid,
      marketDownMid,
      pairSumMid,
      pairArbBuyBoth: pairSumMid != null ? pairSumMid < 0.96 : null,
    },
  ]);

  // Print throughput summary
  // eslint-disable-next-line no-console
  console.log("\nOrderbook update throughput:", totalUpdates, "updates/sec", perBook.join(" | "));
  lastTime = now;
}, 1000);

process.on("SIGINT", () => {
  engine.disconnect();
  process.exit(0);
});
