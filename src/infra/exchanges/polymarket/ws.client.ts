import WebSocket from "ws";
import { env } from "../../../env";

import {
  ConnectionStatus,
  type RawBookWSMessage,
  type Channel,
  type RawLastTradePriceWSMessage,
  type MakerOrder,
  type RawMakerOrder,
  type RawOrderWSMessage,
  type PolymarketWSClientArgs,
  type PolymarketWSCredentials,
  type RawPriceChangeWSMessage,
  type RawTickSizeChangeWSMessage,
  type RawTradeWSMessage,
  type RawMarketResolvedWSMessage,
  type RawBestBidAskWSMessage,
  type RawNewMarketWSMessage,
  type OrderSummary,
  type MarketWSMessage,
  type UserWSMessage,
  type PolymarketWSClientMessage,
  type RawPolymarketWSMessage,
} from "./ws.types";

const DEFAULT_WS_HOST = "wss://ws-subscriptions-clob.polymarket.com";
const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;

/**
 * WebSocket client for Polymarket CLOB feeds.
 */
export class PolymarketWSClient {
  private readonly channel: Channel;
  private assetIds: string[];
  private assetIdSet: Set<string>;
  private markets: string[];
  private readonly credentials: PolymarketWSCredentials | null;
  private customFeatureEnabled: boolean;
  private initialDump: boolean;
  private readonly host: string;
  private readonly pingIntervalMs: number;
  private autoReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly onMessage: ((message: PolymarketWSClientMessage) => void) | null;
  private readonly onStatusChange: ((status: ConnectionStatus) => void) | null;

  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(args: PolymarketWSClientArgs) {
    this.channel = args.channel;
    this.assetIds = args.assetIds ?? [];
    this.assetIdSet = new Set(this.assetIds);
    this.markets = args.markets ?? [];
    this.credentials = args.credentials ?? null;
    this.customFeatureEnabled = args.customFeatureEnabled ?? false;
    this.initialDump = args.initialDump ?? true;
    this.host = args.host ?? DEFAULT_WS_HOST;
    this.pingIntervalMs = args.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.autoReconnect = args.autoReconnect ?? true;
    this.reconnectDelayMs = args.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;

    this.onMessage = args.onMessage ?? null;
    this.onStatusChange = args.onStatusChange ?? null;
  }

  private normalizeIds(ids: string[]) {
    return Array.from(new Set(ids)).filter(Boolean);
  }

  private isWsOpen() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  private sendJson(payload: unknown) {
    if (!this.isWsOpen()) return;
    this.ws!.send(JSON.stringify(payload));
  }

  private resolveUserCredentialsOrThrowError(): PolymarketWSCredentials {
    const credentials = this.resolveUserCredentials();
    if (credentials === null) {
      throw new Error(
        "'credentials' are required when channel is 'user' " +
          "(pass 'credentials' or set 'POLYMARKET_USER_API_KEY', " +
          "'POLYMARKET_USER_API_SECRET', 'POLYMARKET_USER_API_PASSPHRASE' " +
          "in environment variables)"
      );
    }

    return credentials;
  }

  /** Open a websocket connection and begin streaming. */
  public connect() {
    if (this.channel === "market" && this.assetIds.length === 0) {
      throw new Error("'assetIds' are required when channel is 'market'");
    }

    if (this.channel === "user" && this.resolveUserCredentials() === null) {
      this.resolveUserCredentialsOrThrowError();
    }

    this.notifyStatus(ConnectionStatus.CONNECTING);
    this.ws = new WebSocket(`${this.host}/ws/${this.channel}`, {
      perMessageDeflate: false,
    });

    this.ws.on("open", this.onOpen);
    this.ws.on("message", this.onMessageEvent);
    this.ws.on("error", this.onError);
    this.ws.on("close", this.onClose);

    return this;
  }

  /** Update the market-channel 'assetIds' and re-send subscription when connected. */
  public setMarketAssetIds(assetIds: string[]) {
    if (this.channel !== "market") return;

    const next = this.normalizeIds(assetIds);
    if (next.length === 0) return;

    this.assetIds = next;
    this.assetIdSet = new Set(next);

    this.sendSubscribePayload();
  }

  /** Update the user-channel 'markets' and re-send subscription when connected. */
  public setUserMarkets(markets: string[]) {
    if (this.channel !== "user") return;

    this.markets = this.normalizeIds(markets);
    this.sendSubscribePayload();
  }

  /** Enable/disable Polymarket websocket custom features. */
  public setCustomFeatureEnabled(enabled: boolean) {
    this.customFeatureEnabled = enabled;

    this.sendSubscribePayload();
  }

  /** Market-channel only. Enable/disable the initial orderbook snapshot on subscribe ('initial_dump'). */
  public setMarketInitialDump(enabled: boolean) {
    if (this.channel !== "market") return;

    this.initialDump = enabled;

    this.sendSubscribePayload();
  }

  /** Subscribe to more assets (market channel) or markets (user channel). */
  public subscribe(ids: string[]) {
    const next = this.normalizeIds(ids);
    if (next.length === 0) return;

    if (this.channel === "market") {
      this.assetIds = Array.from(new Set([...this.assetIds, ...next]));
      for (const id of next) this.assetIdSet.add(id);
    } else {
      this.markets = Array.from(new Set([...this.markets, ...next]));
    }

    this.sendSubscriptionOperation("subscribe", next);
  }

  /** Unsubscribe from assets ('market' channel) or markets ('user' channel). */
  public unsubscribe(ids: string[]) {
    const next = this.normalizeIds(ids);
    if (next.length === 0) return;

    if (this.channel === "market") {
      const remove = new Set(next);
      this.assetIds = this.assetIds.filter((id) => !remove.has(id));
      for (const id of next) this.assetIdSet.delete(id);
    } else {
      const remove = new Set(next);
      this.markets = this.markets.filter((id) => !remove.has(id));
    }

    this.sendSubscriptionOperation("unsubscribe", next);
  }

  /** Disconnect and stop automatic reconnects. */
  public disconnect() {
    this.autoReconnect = false;
    this.stopPing();
    this.clearReconnectTimer();
    this.ws?.close();
    this.ws = null;
  }

  private onOpen = () => {
    this.clearReconnectTimer();
    this.notifyStatus(ConnectionStatus.CONNECTED);
    this.emit({ type: "READY", channel: this.channel });
    this.sendSubscribePayload();
    this.startPing();
  };

  private onMessageEvent = (data: WebSocket.RawData) => {
    const text = data.toString();
    if (text === "PING" || text === "PONG") return;

    let parsed: RawPolymarketWSMessage;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (!parsed || !parsed.event_type) return;

    switch (parsed.event_type as string) {
      case "book":
        this.handleBook(parsed as RawBookWSMessage);
        break;
      case "best_bid_ask":
        this.handleBestBidAsk(parsed as RawBestBidAskWSMessage);
        break;
      case "new_market":
        this.handleNewMarket(parsed as RawNewMarketWSMessage);
        break;
      case "market_resolved":
        this.handleMarketResolved(parsed as RawMarketResolvedWSMessage);
        break;
      case "price_change":
        this.handlePriceChange(parsed as RawPriceChangeWSMessage);
        break;
      case "tick_size_change":
        this.handleTickSizeChange(parsed as RawTickSizeChangeWSMessage);
        break;
      case "last_trade_price":
        this.handleLastTradePrice(parsed as RawLastTradePriceWSMessage);
        break;
      case "trade":
        this.handleTrade(parsed as RawTradeWSMessage);
        break;
      case "order":
        this.handleOrder(parsed as RawOrderWSMessage);
        break;
      default:
        break;
    }
  };

  private onError = (err: Error) => {
    this.emit({ type: "ERROR", reason: err.message });
    this.handleDisconnect();
  };

  private onClose = (code: number, reason: Buffer) => {
    const reasonText = reason.toString();
    const detail = reasonText ? `${code} ${reasonText}` : `${code}`;
    this.emit({
      type: "ERROR",
      reason: `WS (${this.channel}) closed. ${detail}`,
    });
    this.handleDisconnect();
  };

  private handleDisconnect() {
    this.stopPing();
    this.notifyStatus(ConnectionStatus.DISCONNECTED);

    if (!this.autoReconnect) return;

    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send("PING");
    }, this.pingIntervalMs);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendSubscribePayload() {
    if (!this.isWsOpen()) return;

    const payload =
      this.channel === "market"
        ? {
            type: "market",
            assets_ids: this.assetIds,
            initial_dump: this.initialDump,
            custom_feature_enabled: this.customFeatureEnabled,
          }
        : {
            type: "user",
            markets: this.markets.length > 0 ? this.markets : undefined,
            custom_feature_enabled: this.customFeatureEnabled,
            auth: this.resolveUserCredentialsOrThrowError(),
          };

    this.sendJson(payload);
  }

  private sendSubscriptionOperation(
    operation: "subscribe" | "unsubscribe",
    ids: string[]
  ) {
    if (!this.isWsOpen()) return;

    if (this.channel === "market") {
      const payload: Record<string, unknown> = {
        assets_ids: ids,
        operation,
        custom_feature_enabled: this.customFeatureEnabled,
      };

      if (operation === "subscribe") {
        payload.initial_dump = this.initialDump;
      }

      this.sendJson(payload);
      return;
    }

    this.sendJson({
      markets: ids,
      operation,
      custom_feature_enabled: this.customFeatureEnabled,
    });
  }

  private handleBook(msg: RawBookWSMessage) {
    const clobTokenId = msg.asset_id;
    if (!clobTokenId) return;

    const marketConditionId = msg.market;
    const hash = msg.hash;

    if (this.channel === "market" && !this.assetIdSet.has(clobTokenId)) return;

    const bids: OrderSummary[] = msg.bids?.map((b) => [+b.price, +b.size] as const) ?? [];
    const asks: OrderSummary[] = msg.asks?.map((a) => [+a.price, +a.size] as const) ?? [];

    if (bids.length === 0 || asks.length === 0) return;

    const timestamp = Number(msg.timestamp);
    if (!Number.isFinite(timestamp)) return;

    this.emit({
      type: "BOOK",
      clobTokenId,
      marketConditionId,
      bids,
      asks,
      timestamp,
      hash,
    } as MarketWSMessage);
  }

  private handlePriceChange(msg: RawPriceChangeWSMessage) {
    const priceChanges = (msg.price_changes ?? [])
      .map((change) => {
        const clobTokenId = change.asset_id;
        if (this.channel === "market" && !this.assetIdSet.has(clobTokenId))
          return null;

        const price = Number(change.price);
        const size = Number(change.size);
        const bestBid = Number(change.best_bid);
        const bestAsk = Number(change.best_ask);

        if (![price, size, bestBid, bestAsk].every(Number.isFinite))
          return null;

        return {
          clobTokenId,
          price,
          size,
          side: change.side,
          hash: change.hash,
          bestBid,
          bestAsk,
        } as const;
      })
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    if (priceChanges.length === 0) return;

    const timestamp = Number(msg.timestamp);
    if (!Number.isFinite(timestamp)) return;

    const priceChangeMsg: MarketWSMessage = {
      type: "PRICE_CHANGE",
      marketConditionId: msg.market,
      priceChanges,
      timestamp,
    };

    this.emit(priceChangeMsg);
  }

  private handleTickSizeChange(msg: RawTickSizeChangeWSMessage) {
    const clobTokenId = msg.asset_id;
    if (this.channel === "market" && !this.assetIdSet.has(clobTokenId))
      return;

    const oldTickSize = Number(msg.old_tick_size);
    const newTickSize = Number(msg.new_tick_size);
    const timestamp = Number(msg.timestamp);

    if (![oldTickSize, newTickSize, timestamp].every(Number.isFinite)) return;

    const tickMsg: MarketWSMessage = {
      type: "TICK_SIZE_CHANGE",
      clobTokenId,
      marketConditionId: msg.market,
      oldTickSize,
      newTickSize,
      timestamp,
    };

    this.emit(tickMsg);
  }

  private handleLastTradePrice(msg: RawLastTradePriceWSMessage) {
    const clobTokenId = msg.asset_id;
    if (this.channel === "market" && !this.assetIdSet.has(clobTokenId))
      return;

    const price = Number(msg.price);
    const size = Number(msg.size);
    const feeRateBps = Number(msg.fee_rate_bps);
    const timestamp = Number(msg.timestamp);

    if (![price, size, timestamp].every(Number.isFinite)) return;

    const tradeMsg: MarketWSMessage = {
      type: "LAST_TRADE_PRICE",
      clobTokenId,
      marketConditionId: msg.market,
      price,
      size,
      side: msg.side,
      feeRateBps,
      timestamp,
      transactionHash: msg.transaction_hash,
    };

    this.emit(tradeMsg);
  }

  private handleTrade(msg: RawTradeWSMessage) {
    const clobTokenId = msg.asset_id;
    const price = Number(msg.price);
    const size = Number(msg.size);
    const feeRateBps = Number(msg.fee_rate_bps);
    const matchTime = Number(msg.match_time);
    const lastUpdate = Number(msg.last_update);
    const timestamp = Number(msg.timestamp);

    if (![price, size, matchTime, lastUpdate, timestamp].every(Number.isFinite)) return;

    const makerOrders: MakerOrder[] = (msg.maker_orders ?? []).map(
      (m: RawMakerOrder) => ({
        orderId: m.order_id,
        owner: m.owner,
        makerAddress: m.maker_address,
        matchedAmount: Number(m.matched_amount),
        price: Number(m.price),
        feeRateBps: Number(m.fee_rate_bps),
        assetId: m.asset_id,
        outcome: m.outcome,
        side: m.side,
      })
    );

    const tradeMsg: UserWSMessage = {
      type: "TRADE",
      tradeId: msg.id,
      takerOrderId: msg.taker_order_id,
      marketConditionId: msg.market,
      clobTokenId,
      side: msg.side,
      size,
      feeRateBps,
      price,
      status: msg.status,
      matchTime,
      lastUpdate,
      outcome: msg.outcome,
      owner: msg.owner,
      makerAddress: msg.maker_address,
      transactionHash: msg.transaction_hash,
      bucketIndex: msg.bucket_index,
      makerOrders,
      traderSide: msg.trader_side,
      timestamp,
    };

    this.emit(tradeMsg);
  }

  private handleOrder(msg: RawOrderWSMessage) {
    const clobTokenId = msg.asset_id;
    const price = Number(msg.price);
    const originalSize = Number(msg.original_size);
    const sizeMatched = Number(msg.size_matched);
    const createdAt = Number(msg.created_at);
    const expiration = Number(msg.expiration);
    const timestamp = Number(msg.timestamp);

    if (![price, originalSize, sizeMatched, createdAt, expiration, timestamp].every(Number.isFinite))
      return;

    const orderMsg: UserWSMessage = {
      type: "ORDER",
      orderId: msg.id,
      clobTokenId,
      marketConditionId: msg.market,
      price,
      originalSize,
      sizeMatched,
      side: msg.side,
      outcome: msg.outcome,
      owner: msg.owner,
      orderOwner: msg.order_owner,
      orderType: msg.type,
      orderStatus: msg.status,
      makerAddress: msg.maker_address,
      associatedTrades: msg.associate_trades,
      createdAt,
      expiration,
      timestamp,
    };

    this.emit(orderMsg);
  }

  private handleBestBidAsk(msg: RawBestBidAskWSMessage) {
    const clobTokenId = msg.asset_id;
    if (this.channel === "market" && !this.assetIdSet.has(clobTokenId)) return;

    const bestBid = Number(msg.best_bid);
    const bestAsk = Number(msg.best_ask);
    const spread = Number(msg.spread);
    const timestamp = Number(msg.timestamp);

    if (![bestBid, bestAsk, spread, timestamp].every(Number.isFinite)) return;

    const bestBidAskMsg: MarketWSMessage = {
      type: "BEST_BID_ASK",
      clobTokenId,
      marketConditionId: msg.market,
      bestBid,
      bestAsk,
      spread,
      timestamp,
    };

    this.emit(bestBidAskMsg);
  }

  private handleNewMarket(msg: RawNewMarketWSMessage) {
    const timestamp = Number(msg.timestamp);
    if (!Number.isFinite(timestamp)) return;

    const newMarketMsg: MarketWSMessage = {
      type: "NEW_MARKET",
      marketConditionId: msg.market,
      slug: msg.slug,
      question: msg.question,
      description: msg.description,
      clobTokenIds: msg.assets_ids,
      outcomes: msg.outcomes,
      eventMessage: msg.event_message,
      timestamp,
    };

    this.emit(newMarketMsg);
  }

  private handleMarketResolved(msg: RawMarketResolvedWSMessage) {
    const timestamp = Number(msg.timestamp);
    if (!Number.isFinite(timestamp)) return;

    const resolvedMsg: MarketWSMessage = {
      type: "MARKET_RESOLVED",
      marketConditionId: msg.market,
      slug: msg.slug,
      question: msg.question,
      description: msg.description,
      clobTokenIds: msg.assets_ids,
      outcomes: msg.outcomes,
      winningClobTokenId: msg.winning_asset_id,
      winningOutcome: msg.winning_outcome,
      eventMessage: msg.event_message,
      timestamp,
    };

    this.emit(resolvedMsg);
  }

  private emit(message: PolymarketWSClientMessage) {
    if (this.onMessage) {
      this.onMessage(message);
    }
  }

  private notifyStatus(status: ConnectionStatus) {
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  private resolveUserCredentials(): PolymarketWSCredentials | null {
    if (this.credentials !== null) {
      const { apiKey, passphrase, secret } = this.credentials;
      const hasAll = [apiKey, passphrase, secret].every(
        (value) => typeof value === "string" && value.length > 0
      );

      // If credentials were explicitly provided, treat them as all-or-nothing.
      // Do not merge partial args with env.
      if (hasAll) return this.credentials;
    }

    const apiKey = env.POLYMARKET_USER_API_KEY;
    const passphrase = env.POLYMARKET_USER_API_PASSPHRASE;
    const secret = env.POLYMARKET_USER_API_SECRET;

    if (!apiKey || !passphrase || !secret) return null;

    return {
      apiKey,
      passphrase,
      secret,
    };
  }
}
