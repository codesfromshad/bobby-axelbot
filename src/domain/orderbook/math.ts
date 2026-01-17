function pow10BigInt(exp: number): bigint {
  let out = 1n;
  for (let i = 0; i < exp; i++) out *= 10n;
  return out;
}

export function sizeNumberToScaledBigInt(size: number, scale: number): bigint {
  if (!Number.isFinite(size)) return 0n;
  const factor = Number(pow10BigInt(scale));
  return BigInt(Math.round(size * factor));
}

export function priceToIndex(price: number, tickSize: number): number {
  return Math.round(price / tickSize);
}
