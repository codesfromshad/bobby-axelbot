/**
 * API credentials for CLOB authentication.
 */
export interface ClobApiKeyCreds {
    /** API key used for authentication */
    key: string;

    /** API secret associated with the key */
    secret: string;

    /** Passphrase required for authentication */
    passphrase: string;
}

/**
 * Authentication details for Gamma authentication.
 */
export interface GammaAuth {
    /** Address used for authentication */
    address: string;
}

/**
 * Message structure for subscription requests.
 */
export interface SubscriptionMessage {
    subscriptions: {
        /** Topic to subscribe to */
        topic: string;

        /** Type of subscription */
        type: string;

        /** Optional filters for the subscription */
        filters?: string;

        /** Optional CLOB authentication credentials */
        clob_auth?: ClobApiKeyCreds;

        /** Optional Gamma authentication credentials */
        gamma_auth?: GammaAuth;
    }[];
}

/**
 * Represents a real-time message received from the WebSocket server.
 */
export type RTDSMessage = RTDSSubscribeMessage | RTDSUpdateMessage;

export interface ChainlinkPricesUpdatePayload {
    /** Full accuracy value as a string */
    full_accuracy_value: string;

    /** Symbol representing the asset */
    symbol: string;

    /** Timestamp of the price data */
    timestamp: number;

    /** Numeric value of the price */
    value: number;
}

export interface ChainlinkPricesSubscribePoint {
    /** Timestamp of the price data */
    timestamp: number;
    /** Numeric value of the price */
    value: number;
}

export interface ChainlinkPricesSubscribePayload {
    /** Historical data array */
    data: ChainlinkPricesSubscribePoint[];
    /** Symbol representing the asset */
    symbol: string;
}

export interface RTDSSubscribeMessage {
    /** Connection ID (may be omitted on subscribe snapshots) */
    connection_id?: string;
    /** Payload containing the message data */
    payload: ChainlinkPricesSubscribePayload;
    /** Timestamp of when the message was sent */
    timestamp: number;
    /** Topic of the message */
    topic: string;
    /** Type of the message */
    type: "subscribe";
}

export interface RTDSUpdateMessage {
    /** Connection ID */
    connection_id: string;
    /** Payload containing the message data */
    payload: ChainlinkPricesUpdatePayload;
    /** Timestamp of when the message was sent */
    timestamp: number;
    /** Topic of the message */
    topic: string;
    /** Type of the message */
    type: "update";
}

/**
 * Represents websocket connection status
 */
export enum ConnectionStatus {
    CONNECTING = "CONNECTING",
    CONNECTED = "CONNECTED",
    DISCONNECTED = "DISCONNECTED",
}