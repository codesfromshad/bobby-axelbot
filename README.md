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

## License

UNLICENSED (no license granted).
