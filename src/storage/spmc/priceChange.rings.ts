import {
  SpmcStructRingBuffer,
  type SpmcReaderOptions,
  type SpmcStructRingBufferState,
  type SpmcStructRingReader,
  type SpmcStructRingWriter,
} from "./index";

export type PriceChangeTuple = readonly [
  priceIndex: number,
  size: bigint,
  version: bigint,
  timestamp: bigint
];

export type PriceChangeRingsState = {
  version: 1;
  entries: Array<{
    clobTokenId: string;
    bid: SpmcStructRingBufferState;
    ask: SpmcStructRingBufferState;
  }>;
};

export function createPriceChangeRings(
  clobTokenIds: readonly string[],
  options: { capacity: number }
): {
  state: PriceChangeRingsState;
  writers: Map<
    string,
    {
      bid: SpmcStructRingWriter<PriceChangeTuple>;
      ask: SpmcStructRingWriter<PriceChangeTuple>;
    }
  >;
} {
  const entries: PriceChangeRingsState["entries"] = [];
  const writers = new Map<
    string,
    {
      bid: SpmcStructRingWriter<PriceChangeTuple>;
      ask: SpmcStructRingWriter<PriceChangeTuple>;
    }
  >();

  for (const clobTokenId of clobTokenIds) {
    const bidRb = SpmcStructRingBuffer.create<PriceChangeTuple>({
      capacity: options.capacity,
      fields: [{ type: "i32" }, { type: "i64" }, { type: "i64" }, { type: "i64" }],
    });
    const askRb = SpmcStructRingBuffer.create<PriceChangeTuple>({
      capacity: options.capacity,
      fields: [{ type: "i32" }, { type: "i64" }, { type: "i64" }, { type: "i64" }],
    });

    entries.push({
      clobTokenId,
      bid: bidRb.state,
      ask: askRb.state,
    });

    writers.set(clobTokenId, {
      bid: bidRb.createWriter(),
      ask: askRb.createWriter(),
    });
  }

  return {
    state: { version: 1, entries },
    writers,
  };
}

export function attachPriceChangeRings(
  state: PriceChangeRingsState,
  options?: SpmcReaderOptions
): {
  readers: Map<
    string,
    {
      bid: SpmcStructRingReader<PriceChangeTuple>;
      ask: SpmcStructRingReader<PriceChangeTuple>;
    }
  >;
} {
  if (state.version !== 1) {
    throw new Error(`Unsupported 'PriceChangeRingsState' version: ${state.version}`);
  }

  const readers = new Map<
    string,
    {
      bid: SpmcStructRingReader<PriceChangeTuple>;
      ask: SpmcStructRingReader<PriceChangeTuple>;
    }
  >();

  for (const entry of state.entries) {
    const bid = SpmcStructRingBuffer.attach<PriceChangeTuple>(entry.bid).createReader(options);
    const ask = SpmcStructRingBuffer.attach<PriceChangeTuple>(entry.ask).createReader(options);
    readers.set(entry.clobTokenId, { bid, ask });
  }

  return { readers };
}
