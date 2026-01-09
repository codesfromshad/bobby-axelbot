import { PolymarketWSClient } from "./ws.client";

/**
 * Polymarket websocket channel.
 *
 * - `market`: public market data (book, price_changes, etc.)
 * - `user`: authenticated user stream (orders, trades, etc.)
 */
export type Channel = "market" | "user";

/** Connection status of the websocket client. */
export enum ConnectionStatus {
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  DISCONNECTED = "DISCONNECTED",
}

/** Order side. */
export const SIDE = {
  BUY: "BUY",
  SELL: "SELL",
} as const;

/** Type representing order side. */
export type Side = (typeof SIDE)[keyof typeof SIDE];

/** Trader side. */
export const TRADER_SIDE = {
  TAKER: "TAKER",
  MAKER: "MAKER",
} as const;

/** Type representing trader side. */
export type TraderSide = (typeof TRADER_SIDE)[keyof typeof TRADER_SIDE];

/**
 * Trade status values as string constants.
 *
 * Each status represents a distinct lifecycle state for a trade as reported by the API.
 *
 * - `MATCHED`: The trade has been successfully matched.
 * - `MINED`: The trade has been mined (included in a block).
 * - `CONFIRMED`: The trade has been confirmed (finalized according to the system’s confirmation rules).
 *
 * This constant object is used to guarantee consistent status values throughout your codebase,
 * and enables convenient type inference for TypeScript.
 */
export const TRADE_STATUS = {
  MATCHED: "MATCHED",
  MINED: "MINED",
  CONFIRMED: "CONFIRMED",
} as const;

/**
 * Type representing all valid trade status values.
 *
 * Includes all known trade statuses defined by {@link TRADE_STATUS}, as well as an open-ended
 * object-variant for unrecognized or future statuses returned by the API.
 *
 * This approach mirrors open enum patterns in Rust and ensures your code safely handles
 * unknown status values, improving forward compatibility:
 * - If the API adds a new status, deserialize into `{ Unknown: string }`.
 * - When writing code that processes trade statuses, always handle the `Unknown` case.
 *
 * @example
 * function handleTradeStatus(status: TradeStatus) {
 *   if (typeof status === "string") {
 *     switch (status) {
 *       case TRADE_STATUS.MATCHED:
 *         // logic for matched trades
 *         break;
 *       case TRADE_STATUS.MINED:
 *         // logic for mined trades
 *         break;
 *       case TRADE_STATUS.CONFIRMED:
 *         // logic for confirmed trades
 *         break;
 *     }
 *   } else {
 *     // logic for unknown trade status
 *     console.warn("Unknown trade status:", status.Unknown);
 *   }
 * }
 *
 * @see {@link TRADE_STATUS}
 */
export type TradeStatus =
  | (typeof TRADE_STATUS)[keyof typeof TRADE_STATUS]
  | { Unknown: string };

/**
 * Order status values as string constants.
 *
 * Each status represents a distinct lifecycle state for an order as reported by the API.
 * 
 * - `LIVE`: The order is currently active and may be filled or canceled.
 * - `MATCHED`: The order has been successfully matched and filled.
 * - `CANCELED`: The order was canceled before being fully filled.
 * - `DELAYED`: The order is currently delayed, possibly due to market or technical conditions.
 * - `UNMATCHED`: The order was not matched with any counterpart.
 *
 * This constant object is used to guarantee consistent status values throughout your codebase,
 * and enables convenient type inference for TypeScript.
 */
export const ORDER_STATUS = {
  LIVE: "LIVE",
  MATCHED: "MATCHED",
  CANCELED: "CANCELED",
  DELAYED: "DELAYED",
  UNMATCHED: "UNMATCHED",
} as const;

/**
 * Type representing all valid order status values.
 *
 * Includes all known order statuses defined by {@link ORDER_STATUS}, as well as an open-ended
 * object-variant for unrecognized or future statuses returned by the API.
 *
 * This approach mirrors open enum patterns in Rust and ensures your code safely handles
 * unknown status values, improving forward compatibility:
 * - If the API adds a new status, deserialize into `{ Unknown: string }`.
 * - When writing code that processes order statuses, always handle the `Unknown` case.
 *
 * @example
 * function handleStatus(status: OrderStatus) {
 *   if (typeof status === "string") {
 *     switch (status) {
 *       case ORDER_STATUS.LIVE:
 *         // logic for live orders
 *         break;
 *       // ...handle other known statuses
 *     }
 *   } else {
 *     // logic for unknown status
 *     console.warn("Unknown status:", status.Unknown);
 *   }
 * }
 * 
 * @see {@link ORDER_STATUS}
 */
export type OrderStatus =
  | (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS]
  | { Unknown: string };

/**
 * WebSocket order **type** values as string constants.
 *
 * Each value represents a distinct *order lifecycle state or order-event classification* as reported
 * on the authenticated WebSocket `order` channel.
 *
 * Known values:
 * - `OPEN`: The order is open and active on the book (may be filled or canceled).
 * - `MATCHED`: The order has been fully matched (filled).
 * - `PARTIALLY_FILLED`: The order has been partially filled; remaining size may still be open.
 * - `CANCELLED`: The order has been canceled and is no longer active.
 * - `PLACEMENT`: An order placement event (initial creation/acceptance of the order).
 * - `UPDATE`: An order update event (often emitted for partial fills or other server-side updates).
 * - `CANCELLATION`: A cancellation event (cancellation requested / in progress / confirmed, depending on payload).
 *
 * This constant object is used to guarantee consistent order type values throughout your codebase,
 * and enables convenient type inference for TypeScript.
 */
export const ORDER_TYPE = {
  OPEN: "OPEN",
  MATCHED: "MATCHED",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  CANCELLED: "CANCELLED",
  PLACEMENT: "PLACEMENT",
  UPDATE: "UPDATE",
  CANCELLATION: "CANCELLATION",
} as const;

/**
 * Type representing all valid WebSocket order **type** values.
 *
 * Includes all known order types defined by {@link ORDER_TYPE}, as well as an open-ended
 * object-variant for unrecognized or future values returned by the API.
 *
 * This approach mirrors open enum patterns in Rust (e.g., `Unknown(String)`) and ensures your code
 * safely handles unknown order types, improving forward compatibility:
 * - If the API adds a new order type, deserialize into `{ Unknown: string }`.
 * - When writing code that processes order types, always handle the `Unknown` case.
 *
 * @example
 * function handleOrderType(t: OrderType) {
 *   if (typeof t === "string") {
 *     switch (t) {
 *       case ORDER_TYPE.OPEN:
 *         // logic for open orders
 *         break;
 *       case ORDER_TYPE.PLACEMENT:
 *         // logic for new placements
 *         break;
 *       // ...handle other known values
 *     }
 *   } else {
 *     // logic for unknown/future values
 *     console.warn("Unknown order type:", t.Unknown);
 *   }
 * }
 *
 * @see {@link ORDER_TYPE}
 */
export type OrderType =
  | (typeof ORDER_TYPE)[keyof typeof ORDER_TYPE]
  | { Unknown: string };

/**
 * Credentials required for the `user` websocket channel.
 *
 * These values correspond to your CLOB API key/secret/passphrase.
 */
export interface PolymarketWSCredentials {
  apiKey: string;
  passphrase: string;
  secret: string;
}

/**
 * Constructor args for {@link PolymarketWSClient}.
 *
 * @example
 * // Market channel
 * new PolymarketWSClient({
 *   channel: "market",
 *   assetIds: ["token_id_1", "token_id_2"],
 *   initialDump: true,
 *   customFeatureEnabled: false,
 * })
 *
 * @example
 * // User channel (markets is optional filter)
 * new PolymarketWSClient({
 *   channel: "user",
 *   credentials: { apiKey, secret, passphrase },
 *   markets: ["condition_id_1"],
 * })
 */
export interface PolymarketWSClientArgs {
  /**
   * Channel to connect to ('market' or 'user').
   * @see {@link Channel}
   */
  channel: Channel;
  /** Market-channel only. Array of token IDs to subscribe to. */
  assetIds?: string[];
  /** User-channel only. Optional array of condition IDs to filter events. */
  markets?: string[];
  /** User-channel only. If omitted, the client may read from env (see env.ts). */
  credentials?: PolymarketWSCredentials;
  /**
   * Enables/disables Polymarket websocket "custom features".
   *
   * Sent as `custom_feature_enabled` on subscribe and subscribe/unsubscribe operations.
   * @default false
   */
  customFeatureEnabled?: boolean;
  /**
   * Market-channel only. Controls whether Polymarket sends the initial full orderbook
   * snapshot (`book` event) on subscription.
   * @default true
   */
  initialDump?: boolean;
  /** Websocket host URL. @default wss://ws-subscriptions-clob.polymarket.com */
  host?: string;
  /** Heartbeat ping interval (ms). @default 10_000 */
  pingIntervalMs?: number;
  /** Automatically reconnect after disconnects. @default true */
  autoReconnect?: boolean;
  /** Delay before reconnecting (ms). @default 1_000 */
  reconnectDelayMs?: number;
  /** Receives parsed, typed messages emitted by the client. */
  onMessage?: (message: PolymarketWSClientMessage) => void;
  /** Receives connection status changes. */
  onStatusChange?: (status: ConnectionStatus) => void;
}

/**
 * Raw orderbook level.
 *
 * Note: numeric fields come over the wire as strings.
 *
 * @example
 * { "price": "0.48", "size": "30" }
 */
export interface RawOrderSummary {
  /** Price of the orderbook level */
  price: string;
  /** Size available at that price level */
  size: string;
}

/**
 * Price change detail object
 *
 * Represents a single price level change when an order is placed or cancelled
 */
export interface RawPriceChange {
  /** Asset ID (token ID) */
  asset_id: string;
  /** Price level affected */
  price: string;
  /** New aggregate size for price level */
  size: string;
  /** Order side */
  side: Side;
  /** Hash of the order */
  hash: string;
  /** Current best bid price */
  best_bid: string;
  /** Current best ask price */
  best_ask: string;
}

/**
 * Maker order in a trade
 *
 * Represents a maker order that was matched in a trade
 */
export interface RawMakerOrder {
  /** Maker order ID */
  order_id: string;
  /** Owner of maker order */
  owner: string;
  /** Address of the maker */
  maker_address: string;
  /** Amount of maker order matched in trade */
  matched_amount: string;
  /** Price of maker order */
  price: string;
  /** Fee rate in basis points */
  fee_rate_bps: string;
  /** Asset ID of the maker order */
  asset_id: string;
  /** Outcome (e.g., "YES", "NO" , "Up", "Down") */
  outcome: string;
  /** Index of the outcome */
  outcome_index: number;
  /** Side of the order */
  side: Side;
}

/**
 * Raw `book` websocket message.
 *
 * Emitted when:
 * - First subscribed to a market
 * - When there is a trade that affects the book
 */
export interface RawBookWSMessage {
  event_type: "book";
  /** Asset ID (token ID) */
  asset_id: string;
  /** Condition ID of market */
  market: string;
  /** Unix timestamp (ms) as a string */
  timestamp: string;
  /** Hash summary of the orderbook content */
  hash: string;
  /** List of aggregate book levels for buys */
  bids: RawOrderSummary[];
  /** List of aggregate book levels for sells */
  asks: RawOrderSummary[];
}

/**
 * Raw `price_change` websocket message.
 *
 * Emitted when:
 * - A new order is placed
 * - An order is cancelled
 */
export interface RawPriceChangeWSMessage {
  event_type: "price_change";
  /** Condition ID of market */
  market: string;
  /** Array of price change objects */
  price_changes: RawPriceChange[];
  /** Unix timestamp (ms) as a string */
  timestamp: string;
}

/**
 * Raw `tick_size_change` websocket message.
 *
 * Emitted when:
 * - The minimum tick size of the market changes
 * - This happens when the book's price reaches the limits: price > 0.96 or price < 0.04
 */
export interface RawTickSizeChangeWSMessage {
  event_type: "tick_size_change";
  /** Asset ID (token ID) */
  asset_id: string;
  /** Condition ID of market */
  market: string;
  /** Previous minimum tick size */
  old_tick_size: string;
  /** Current minimum tick size */
  new_tick_size: string;
  /** Buy/sell side */
  side?: string;
  /** Unix timestamp (ms) as a string */
  timestamp: string;
}

/**
 * Raw `last_trade_price` websocket message.
 *
 * Emitted when:
 * - A maker and taker order is matched creating a trade event
 */
export interface RawLastTradePriceWSMessage {
  event_type: "last_trade_price";
  /** Asset ID (token ID) */
  asset_id: string;
  /** Fee rate in basis points */
  fee_rate_bps: string;
  /** Market identifier (condition ID) */
  market: string;
  /** Trade price */
  price: string;
  /** Trade side */
  side: Side;
  /** Trade size */
  size: string;
  /** Unix timestamp (ms) as a string */
  timestamp: string;
  /** Transaction hash of the trade */
  transaction_hash: string;
}

/**
 * Raw `trade` websocket message (user channel).
 *
 * Emitted when:
 * - A market order is matched ("MATCHED")
 * - A limit order for the user is included in a trade ("MATCHED")
 * - Subsequent status changes for trade ("MINED", "CONFIRMED", "RETRYING", "FAILED")
 */
export interface RawTradeWSMessage {
  /** @deprecated Not sent by Polymarket; use {@link TradeMessage.event_type}. */
  type?: "TRADE";
  /** Trade ID */
  id: string;
  /** ID of taker order */
  taker_order_id: string;
  /** Market identifier (condition ID) */
  market: string;
  /** Asset ID (token ID) of order (market order) */
  asset_id: string;
  /** Trade side */
  side: Side;
  /** Trade size */
  size: string;
  /** Fee rate in basis points */
  fee_rate_bps: string;
  /** Trade price */
  price: string;
  /** Trade status: MATCHED → MINED → CONFIRMED, or RETRYING/FAILED */
  status: TradeStatus;
  /** Time trade was matched (unix timestamp) */
  match_time: string;
  /** Time of last update to trade (unix timestamp) */
  last_update: string;
  /** Outcome (e.g., "YES", "NO", "Up", "Down") */
  outcome: string;
  /** API key of event owner */
  owner: string;
  /** API key of trade owner */
  trade_owner: string;
  /** Address of the maker involved in this trade */
  maker_address: string;
  /** Transaction hash of the trade */
  transaction_hash: string;
  /** Bucket index of the trade */
  bucket_index: number;
  /** Array of maker order details included in this trade */
  maker_orders: RawMakerOrder[];
  /** Side of the trader */
  trader_side: TraderSide;
  /** Unix timestamp (ms) as a string */
  timestamp: string;
  /** Message type discriminator */
  event_type: "trade";
}

/**
 * Raw `order` websocket message (user channel).
 *
 * Emitted when:
 * - An order is placed (PLACEMENT)
 * - An order is updated, e.g., partially matched (UPDATE)
 * - An order is canceled (CANCELLATION)
 */
export interface RawOrderWSMessage {
  /** Order ID */
  id: string;
  /** Owner of orders */
  owner: string;
  /** Market identifier (condition ID) */
  market: string;
  /** Asset ID (token ID) of order */
  asset_id: string;
  /** Order side */
  side: Side;
  /** Owner of order */
  order_owner: string;
  /** Original order size */
  original_size: string;
  /** Size of order that has been matched */
  size_matched: string;
  /** Order price */
  price: string;
  /** Array of trade IDs this order has been included in */
  associate_trades: string[] | null;
  /** Outcome (e.g., "YES", "NO") */
  outcome: string;
  /** Order type: PLACEMENT, UPDATE, or CANCELLATION */
  type: OrderType;
  /** Time order was created */
  created_at: string;
  /** Time order was last updated */
  expiration: string;
  /** Order type: FOK, FAK, GTC, or GTD */
  order_type: string;
  /** Order status: LIVE, CANCELED, PARTIALLY_FILLED, FILLED */
  status: OrderStatus;
  /** Address of the maker */
  maker_address: string;
  /** Unix timestamp (ms) as a string */
  timestamp: string;
  /** Event type discriminator */
  event_type: "order";
}

/**
 * Raw `best_bid_ask` websocket message (market channel).
 *
 * Emitted when the best bid and ask prices for a market change.
 * (Behind the `custom_feature_enabled` flag.)
 */
export interface RawBestBidAskWSMessage {
  event_type: "best_bid_ask";
  /** Condition ID of market */
  market: string;
  /** Asset ID (token ID) */
  asset_id: string;
  /** Current best bid price */
  best_bid: string;
  /** Current best ask price */
  best_ask: string;
  /** Spread between best bid and ask */
  spread: string;
  /** Unix timestamp (ms) as a string */
  timestamp: string;
}

/** Event message object included in certain custom feature messages. */
export interface RawMarketEventMessage {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description: string;
}

/**
 * Raw `new_market` websocket message (market channel).
 *
 * Emitted when a new market is created.
 * (Behind the `custom_feature_enabled` flag.)
 */
export interface RawNewMarketWSMessage {
  event_type: "new_market";
  /** Market ID */
  id: string;
  /** Market question */
  question: string;
  /** Condition ID of market */
  market: string;
  /** Market slug */
  slug: string;
  /** Market description */
  description: string;
  /** List of asset IDs */
  assets_ids: string[];
  /** List of outcomes */
  outcomes: string[];
  /** Event message object */
  event_message: RawMarketEventMessage;
  /** Unix timestamp (ms) as a string */
  timestamp: string;
}

/**
 * Raw `market_resolved` websocket message (market channel).
 *
 * Emitted when a market is resolved.
 * (Behind the `custom_feature_enabled` flag.)
 */
export interface RawMarketResolvedWSMessage {
  event_type: "market_resolved";
  /** Market ID */
  id: string;
  /** Market question */
  question: string;
  /** Condition ID of market */
  market: string;
  /** Market slug */
  slug: string;
  /** Market description */
  description: string;
  /** List of asset IDs */
  assets_ids: string[];
  /** List of outcomes */
  outcomes: string[];
  /** Winning asset ID */
  winning_asset_id: string;
  /** Winning outcome */
  winning_outcome: string;
  /** Event message object */
  event_message: RawMarketEventMessage;
  /** Unix timestamp (ms) as a string */
  timestamp: string;
}

/**
 * Union of raw websocket messages from Polymarket.
 *
 * These are the on-the-wire shapes (numbers often encoded as strings).
 */
export type RawPolymarketWSMessage =
  | RawBookWSMessage
  | RawPriceChangeWSMessage
  | RawTickSizeChangeWSMessage
  | RawLastTradePriceWSMessage
  | RawTradeWSMessage
  | RawOrderWSMessage
  | RawBestBidAskWSMessage
  | RawNewMarketWSMessage
  | RawMarketResolvedWSMessage;

/**
 * Processed maker order for downstream consumers.
 *
 * Unlike {@link RawMakerOrder}, numeric fields are converted to `number`.
 */
export interface MakerOrder {
  orderId: string;
  owner: string;
  makerAddress: string;
  matchedAmount: number;
  price: number;
  feeRateBps: number;
  assetId: string;
  outcome: string;
  side: Side;
}

/**
 * Processed order summary for downstream consumers.
 *
 * Tuple form: [price, size]
 */
export type OrderSummary = readonly [
  /** Price of the orderbook level */
  price: number,
  /** Size available at that price level */
  size: number
];

export type MarketEventMessage = RawMarketEventMessage;

/**
 * Internal lifecycle events emitted by the client.
 */
export type LifecycleWSMessage =
  | { type: "READY"; channel: Channel }
  | { type: "ERROR"; reason: string };


/**
 * Normalized market-channel messages emitted by the client.
 *
 * These are transformed from raw messages:
 * - numeric fields are `number`
 * - keys are camelCased
 */
export type MarketWSMessage =
  | {
      type: "BOOK";
      clobTokenId: string;
      marketConditionId: string;
      bids: OrderSummary[];
      asks: OrderSummary[];
      timestamp: number;
      hash: string;
    }
  | {
      type: "BEST_BID_ASK";
      clobTokenId: string;
      marketConditionId: string;
      bestBid: number;
      bestAsk: number;
      spread: number;
      timestamp: number;
    }
  | {
      type: "NEW_MARKET";
      marketConditionId: string;
      slug: string;
      question: string;
      description: string;
      clobTokenIds: string[];
      outcomes: string[];
      eventMessage: MarketEventMessage;
      timestamp: number;
    }
  | {
      type: "MARKET_RESOLVED";
      marketConditionId: string;
      slug: string;
      question: string;
      description: string;
      clobTokenIds: string[];
      outcomes: string[];
      winningClobTokenId: string;
      winningOutcome: string;
      eventMessage: MarketEventMessage;
      timestamp: number;
    }
  | {
      type: "PRICE_CHANGE";
      marketConditionId: string;
      priceChanges: Array<{
        clobTokenId: string;
        price: number;
        size: number;
        side: Side;
        hash: string;
        bestBid: number;
        bestAsk: number;
      }>;
      timestamp: number;
    }
  | {
      type: "TICK_SIZE_CHANGE";
      clobTokenId: string;
      marketConditionId: string;
      oldTickSize: number;
      newTickSize: number;
      timestamp: number;
    }
  | {
      type: "LAST_TRADE_PRICE";
      clobTokenId: string;
      marketConditionId: string;
      price: number;
      size: number;
      side: Side;
      feeRateBps: number;
      timestamp: number;
      transactionHash: string;
    };

/**
 * Normalized user-channel messages emitted by the client.
 */
export type UserWSMessage =
  | {
      type: "TRADE";
      tradeId: string;
      takerOrderId: string;
      marketConditionId: string;
      clobTokenId: string;
      side: Side;
      size: number;
      feeRateBps: number;
      price: number;
      status: TradeStatus;
      matchTime: number;
      lastUpdate: number;
      outcome: string;
      bucketIndex: number;
      owner: string;
      makerAddress: string;
      transactionHash: string;
      makerOrders: MakerOrder[];
      traderSide: TraderSide;
      timestamp: number;
    }
  | {
      type: "ORDER";
      orderId: string;
      clobTokenId: string;
      marketConditionId: string;
      price: number;
      originalSize: number;
      sizeMatched: number;
      side: Side;
      outcome: string;
      owner: string;
      orderOwner: string;
      makerAddress: string;
      orderType: OrderType;
      orderStatus: OrderStatus;
      associatedTrades: string[] | null;
      createdAt: number;
      expiration: number;
      timestamp: number;
    };

/**
 * All messages a {@link PolymarketWSClient} can emit.
 */
export type PolymarketWSClientMessage =
  | LifecycleWSMessage
  | MarketWSMessage
  | UserWSMessage;
