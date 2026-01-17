import React, { useEffect, useMemo, useRef, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";

import { BinanceSpotOrderbookEngine } from "../infra/exchanges/binance/spot.orderbook";

const SYMBOLS = ["BTCUSDT"] as const;

const SIZE_SCALE = 8;
const DISPLAY_BUCKET_USD = 10;
const MAX_LEVELS = 400;

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

type DepthRow = {
  lo: number;
  hi: number;
  size: bigint;
};

function clampInt(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

const engine = new BinanceSpotOrderbookEngine(SYMBOLS, {
  ringCapacity: 4096,
  sizeScale: SIZE_SCALE,
  snapshotLimit: 1000,
  wsUpdateMs: 100,
}).connect();

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [dims, setDims] = useState(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () =>
      setDims({
        columns: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      });
    stdout.on("resize", onResize);
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [status, setStatus] = useState<string>("connecting...");
  const [tickSize, setTickSize] = useState<number | null>(null);
  const [version, setVersion] = useState<bigint>(0n);
  const [ts, setTs] = useState<bigint>(0n);

  const [bestBid, setBestBid] = useState<number | null>(null);
  const [bestAsk, setBestAsk] = useState<number | null>(null);
  const [spread, setSpread] = useState<number | null>(null);

  const [bids, setBids] = useState<DepthRow[]>([]);
  const [asks, setAsks] = useState<DepthRow[]>([]);

  const [scroll, setScroll] = useState(0);
  const lastVersionRef = useRef<bigint>(0n);
  const lastRateAtRef = useRef<number>(Date.now());
  const rateAccRef = useRef<number>(0);
  const [updatesPerSec, setUpdatesPerSec] = useState<number>(0);

  // Drain frequently (keeps the ring buffer moving) and refresh UI at a sane rate.
  useEffect(() => {
    const drain = setInterval(() => engine.drainOnce(), 5);
    const renderTick = setInterval(() => {
      const symbol = SYMBOLS[0];
      const ob = engine.getOrderbook(symbol);
      if (!ob) {
        setStatus("connecting...");
        return;
      }

      setVersion(ob.version);
      setTs(ob.lastTimestamp);
      setTickSize(ob.tickSize ?? null);

      const prev = lastVersionRef.current;
      const dv = Number(ob.version - prev);
      if (dv > 0) rateAccRef.current += dv;
      lastVersionRef.current = ob.version;

      const now = Date.now();
      const dt = (now - lastRateAtRef.current) / 1000;
      if (dt >= 0.5) {
        setUpdatesPerSec(Math.round(rateAccRef.current / Math.max(1e-9, dt)));
        rateAccRef.current = 0;
        lastRateAtRef.current = now;
      }

      if (ob.tickSize == null) {
        setStatus("waiting for snapshot/tickSize...");
        setBids([]);
        setAsks([]);
        setBestBid(null);
        setBestAsk(null);
        setSpread(null);
        return;
      }

      setStatus("live");

      // Best bid/ask
      let bbIdx: number | null = null;
      for (const idx of ob.bids.keys()) bbIdx = bbIdx == null ? idx : Math.max(bbIdx, idx);
      let baIdx: number | null = null;
      for (const idx of ob.asks.keys()) baIdx = baIdx == null ? idx : Math.min(baIdx, idx);

      const bb = bbIdx == null ? null : idxToPrice(bbIdx, ob.tickSize);
      const ba = baIdx == null ? null : idxToPrice(baIdx, ob.tickSize);
      setBestBid(bb);
      setBestAsk(ba);
      setSpread(bb != null && ba != null ? ba - bb : null);

      const bucketTicks = Math.max(1, Math.round(DISPLAY_BUCKET_USD / ob.tickSize));
      const maxN = MAX_LEVELS;

      const aggAsks = topAggregatedLevels({
        book: ob.asks,
        side: "ask",
        n: maxN,
        bucketTicks,
      });
      const aggBids = topAggregatedLevels({
        book: ob.bids,
        side: "bid",
        n: maxN,
        bucketTicks,
      });

      setAsks(
        aggAsks.map(([bucketStartIdx, size]) => {
          const lo = idxToPrice(bucketStartIdx, ob.tickSize);
          const hi = idxToPrice(bucketStartIdx + bucketTicks - 1, ob.tickSize);
          return { lo, hi, size };
        })
      );
      setBids(
        aggBids.map(([bucketStartIdx, size]) => {
          const lo = idxToPrice(bucketStartIdx, ob.tickSize);
          const hi = idxToPrice(bucketStartIdx + bucketTicks - 1, ob.tickSize);
          return { lo, hi, size };
        })
      );
    }, 80);

    return () => {
      clearInterval(drain);
      clearInterval(renderTick);
      engine.disconnect();
    };
  }, []);

  const rowsAvailable = useMemo(() => {
    // Header (3) + footer/help (2) + a little breathing room.
    return Math.max(5, dims.rows - 6);
  }, [dims.rows]);

  const maxScrollable = useMemo(() => {
    const depth = Math.max(bids.length, asks.length);
    return Math.max(0, depth - rowsAvailable);
  }, [asks.length, bids.length, rowsAvailable]);

  useEffect(() => {
    setScroll((s) => clampInt(s, 0, maxScrollable));
  }, [maxScrollable]);

  useInput((input, key) => {
    if (input === "q" || key.escape || (key.ctrl && input === "c")) {
      engine.disconnect();
      exit();
      return;
    }

    if (key.downArrow || input === "j") setScroll((s) => clampInt(s + 1, 0, maxScrollable));
    if (key.upArrow || input === "k") setScroll((s) => clampInt(s - 1, 0, maxScrollable));
    if (key.pageDown) setScroll((s) => clampInt(s + rowsAvailable, 0, maxScrollable));
    if (key.pageUp) setScroll((s) => clampInt(s - rowsAvailable, 0, maxScrollable));
    if (key.home) setScroll(0);
    if (key.end) setScroll(maxScrollable);
  });

  const askSlice = asks.slice(scroll, scroll + rowsAvailable);
  const bidSlice = bids.slice(scroll, scroll + rowsAvailable);

  const priceColWidth = 26;
  const sizeColWidth = 18;
  const colGap = 4;
  const totalCols = priceColWidth + sizeColWidth;
  const fitsSideBySide = dims.columns >= totalCols * 2 + colGap;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          {SYMBOLS[0]} | {status} | upd/s {updatesPerSec}
        </Text>
        <Text>
          v {version.toString()} | ts {ts.toString()}
        </Text>
      </Box>

      <Box justifyContent="space-between">
        <Text>
          tick {tickSize ?? "-"} | bb {bestBid?.toFixed(2) ?? "-"} | ba {bestAsk?.toFixed(2) ?? "-"} | spr {spread?.toFixed(2) ?? "-"}
        </Text>
        <Text>
          scroll {scroll}/{maxScrollable}
        </Text>
      </Box>

      <Box>
        {fitsSideBySide ? (
          <>
            <Box flexDirection="column" width={totalCols}>
              <Text>ASKS (bin ~${DISPLAY_BUCKET_USD})</Text>
              {askSlice.map((r, i) => (
                <Text key={`a-${scroll + i}`}>
                  {`${r.lo.toFixed(2)}..${r.hi.toFixed(2)}`.padStart(priceColWidth)}{" ".repeat(2)}
                  {formatScaledBigInt(r.size, SIZE_SCALE).padStart(sizeColWidth)}
                </Text>
              ))}
            </Box>

            <Box width={colGap} />

            <Box flexDirection="column" width={totalCols}>
              <Text>BIDS (bin ~${DISPLAY_BUCKET_USD})</Text>
              {bidSlice.map((r, i) => (
                <Text key={`b-${scroll + i}`}>
                  {`${r.lo.toFixed(2)}..${r.hi.toFixed(2)}`.padStart(priceColWidth)}{" ".repeat(2)}
                  {formatScaledBigInt(r.size, SIZE_SCALE).padStart(sizeColWidth)}
                </Text>
              ))}
            </Box>
          </>
        ) : (
          <Box flexDirection="column">
            <Text>ASKS (bin ~${DISPLAY_BUCKET_USD})</Text>
            {askSlice.map((r, i) => (
              <Text key={`a-${scroll + i}`}>
                {`${r.lo.toFixed(2)}..${r.hi.toFixed(2)}`.padStart(priceColWidth)}{" ".repeat(2)}
                {formatScaledBigInt(r.size, SIZE_SCALE).padStart(sizeColWidth)}
              </Text>
            ))}
            <Text> </Text>
            <Text>BIDS (bin ~${DISPLAY_BUCKET_USD})</Text>
            {bidSlice.map((r, i) => (
              <Text key={`b-${scroll + i}`}>
                {`${r.lo.toFixed(2)}..${r.hi.toFixed(2)}`.padStart(priceColWidth)}{" ".repeat(2)}
                {formatScaledBigInt(r.size, SIZE_SCALE).padStart(sizeColWidth)}
              </Text>
            ))}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Controls: ↑/↓ or j/k scroll, PgUp/PgDn page, Home/End, q to quit.
        </Text>
      </Box>
    </Box>
  );
}

render(<App />);
