export const MAGIC = 0x53535452; // 'SSTR' - Shared STruct Ring
export const VERSION = 1;

export type SpmcFieldType = "i32" | "f64" | "i64" | "u64";

export type SpmcFieldDescriptor = {
  type: SpmcFieldType;
};

export type SpmcStructRingBufferState = {
  sab: SharedArrayBuffer;
};

export type SpmcStructRingBufferCreateOptions = {
  /** Must be a power of two. */
  capacity: number;
  /** Field order defines tuple order. */
  fields: readonly SpmcFieldDescriptor[];
};

export type SpmcReaderOptions = {
  from?: "oldest" | "latest";
};

export type SpmcStructReadResult<T extends readonly (number | bigint)[]> = {
  seq: bigint;
  tuple: T;
  dropped: boolean;
};
