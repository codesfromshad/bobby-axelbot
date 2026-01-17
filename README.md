# bobby-axelbot

Polymarket trading bot with microstructure analysis.

## Prerequisites

- Node.js (recommended: 20+)
- pnpm (this repo is pinned via `packageManager`)

## Setup

```bash
pnpm install
```

## Run

This project is configured as an ESM TypeScript project (`"type": "module"`). Since Node ESM requires explicit file extensions for relative imports, the recommended way to run the bot is to bundle first.

```bash
pnpm build
pnpm start
```

## Dev

Watches and rebuilds on changes, auto-restarting the bot:

```bash
pnpm dev
```

This loads environment variables from `.env` (repo root) if present.

## Project layout

- `src/main.ts` — entrypoint
- `src/infra/` — infrastructure integrations
- `src/orderbook/` — orderbook / market data
- `src/protocol/` — protocol clients & adapters
- `src/storage/` — persistence
- `src/strategy/` — strategy logic
- `src/workers/` — background workers

## Shared SPMC ring buffers (HFT)

This repo includes a SharedArrayBuffer-backed SPMC (single-producer, multi-consumer) ring buffer suitable for non-blocking, low-GC market-data fanout across `worker_threads`.

- Implementation: `src/storage/shared/spmcRingBuffer.ts`
- Ask/bid per `clobTokenId` helper: `src/orderbook/orderbookRingBuffers.ts`

Producer thread (creates the buffers and writes tuples):

```ts
import { Worker } from "node:worker_threads";
import { createOrderbookRingBuffers } from "./orderbook/orderbookRingBuffers";

const { state, writers } = createOrderbookRingBuffers(["<clobTokenId>"] as const, {
	capacity: 1024,
});

// Share `state` to many workers (structured-clone carries SharedArrayBuffer by reference)
const w = new Worker(new URL("./workers/consumer.js", import.meta.url), {
	workerData: state,
});

// Non-blocking publish: tuple is [price, size]
writers.get("<clobTokenId>")!.bid.push([0.52, 100]);
writers.get("<clobTokenId>")!.ask.push([0.53, 120]);
```

Consumer worker (attaches and reads without blocking):

```ts
import { workerData } from "node:worker_threads";
import { attachOrderbookRingBuffers } from "../orderbook/orderbookRingBuffers";

const { readers } = attachOrderbookRingBuffers(workerData, { from: "latest" });
const bidReader = readers.get("<clobTokenId>")!.bid;

// Poll-style loop: drain available entries each tick
setInterval(() => {
	for (;;) {
		const msg = bidReader.tryRead();
		if (!msg) break;
		// msg.tuple is [price, size]
		// msg.dropped === true means you fell behind and entries were overwritten
	}
}, 1);
```

## License

MIT. See [LICENSE](./LICENSE).
