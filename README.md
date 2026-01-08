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

This project is configured as an ESM TypeScript project (`"type": "module"`). A simple way to run the entrypoint is via Node + the ts-node ESM loader:

```bash
node --loader ts-node/esm src/main.ts
```

Alternatively:

```bash
pnpm exec ts-node --esm src/main.ts
```

## Project layout

- `src/main.ts` — entrypoint
- `src/infra/` — infrastructure integrations
- `src/orderbook/` — orderbook / market data
- `src/protocol/` — protocol clients & adapters
- `src/storage/` — persistence
- `src/strategy/` — strategy logic
- `src/workers/` — background workers

## License

UNLICENSED (no license granted).
