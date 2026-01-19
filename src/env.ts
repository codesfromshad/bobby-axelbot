import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    CHAINLINK_API_KEY: z.string().min(1),
    CHAINLINK_API_SECRET: z.string().min(1),
    POLYMARKET_USER_PRIVATE_KEY: z.string().min(1),
    POLYMARKET_USER_FUNDER_ADDRESS: z.string().min(1),
    POLYMARKET_USER_API_KEY: z.string().min(1),
    POLYMARKET_USER_API_SECRET: z.string().min(1),
    POLYMARKET_USER_API_PASSPHRASE: z.string().min(1),
    POLYMARKET_BUILDER_API_KEY: z.string().min(1),
    POLYMARKET_BUILDER_API_SECRET: z.string().min(1),
    POLYMARKET_BUILDER_API_PASSPHRASE: z.string().min(1),
    AXELBOT_STRATEGY: z.string().min(1).default("pair96"),
    AXELBOT_LIVE_TRADING: z.coerce.boolean().default(false),
    AXELBOT_LIVE_REDEEM: z.coerce.boolean().default(false),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
