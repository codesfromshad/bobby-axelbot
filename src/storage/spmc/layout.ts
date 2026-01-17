import type { SpmcFieldDescriptor, SpmcFieldType } from "./protocol";

export function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got ${value})`);
  }
}

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function alignTo(value: number, alignment: number): number {
  const rem = value % alignment;
  return rem === 0 ? value : value + (alignment - rem);
}

export function typeToCode(type: SpmcFieldType): number {
  switch (type) {
    case "i32":
      return 1;
    case "f64":
      return 2;
    case "i64":
      return 3;
    case "u64":
      return 4;
  }
}

export function codeToType(code: number): SpmcFieldType {
  switch (code) {
    case 1:
      return "i32";
    case 2:
      return "f64";
    case 3:
      return "i64";
    case 4:
      return "u64";
    default:
      throw new Error(`Unknown field type code: ${code}`);
  }
}

export function typeAlignment(type: SpmcFieldType): number {
  switch (type) {
    case "i32":
      return 4;
    case "f64":
    case "i64":
    case "u64":
      return 8;
  }
}

export function bytesPerElement(type: SpmcFieldType): number {
  switch (type) {
    case "i32":
      return Int32Array.BYTES_PER_ELEMENT;
    case "f64":
      return Float64Array.BYTES_PER_ELEMENT;
    case "i64":
      return BigInt64Array.BYTES_PER_ELEMENT;
    case "u64":
      return BigUint64Array.BYTES_PER_ELEMENT;
  }
}

export function computeLayout(
  capacity: number,
  fields: readonly SpmcFieldDescriptor[]
): {
  headerBytes: number;
  writeSeqOffset: number;
  stampsOffset: number;
  fieldOffsets: number[];
  totalBytes: number;
} {
  assertPositiveInt("capacity", capacity);
  if (!isPowerOfTwo(capacity)) {
    throw new Error(
      `capacity should be a power of two for HFT-friendly performance (got ${capacity})`
    );
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("fields must be a non-empty array");
  }

  const fieldCount = fields.length;

  // Header layout (Int32 words):
  // [0]=MAGIC [1]=VERSION [2]=capacity [3]=fieldCount [4..]=field type codes
  const headerI32Length = 4 + fieldCount;
  const headerBytes = headerI32Length * Int32Array.BYTES_PER_ELEMENT;

  const writeSeqOffset = alignTo(headerBytes, 8);
  const writeSeqBytes = BigInt64Array.BYTES_PER_ELEMENT;

  const stampsOffset = alignTo(writeSeqOffset + writeSeqBytes, 8);
  const stampsBytes = capacity * BigInt64Array.BYTES_PER_ELEMENT;

  let cursor = alignTo(stampsOffset + stampsBytes, 8);

  const fieldOffsets: number[] = new Array(fieldCount);
  for (let i = 0; i < fieldCount; i++) {
    const type = fields[i]!.type;
    cursor = alignTo(cursor, typeAlignment(type));
    fieldOffsets[i] = cursor;
    cursor += capacity * bytesPerElement(type);
  }

  return {
    headerBytes,
    writeSeqOffset,
    stampsOffset,
    fieldOffsets,
    totalBytes: cursor,
  };
}