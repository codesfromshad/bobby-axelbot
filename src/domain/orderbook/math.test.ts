import { describe, expect, test } from "@jest/globals";
import { priceToIndex, sizeNumberToScaledBigInt } from "./math";

describe("sizeNumberToScaledBigInt", () => {
  test("returns 0n for non-finite values", () => {
    expect(sizeNumberToScaledBigInt(Number.NaN, 6)).toBe(0n);
    expect(sizeNumberToScaledBigInt(Number.POSITIVE_INFINITY, 6)).toBe(0n);
    expect(sizeNumberToScaledBigInt(Number.NEGATIVE_INFINITY, 6)).toBe(0n);
  });

  test("scale 0 rounds to integer bigint", () => {
    expect(sizeNumberToScaledBigInt(1.2, 0)).toBe(1n);
    expect(sizeNumberToScaledBigInt(1.5, 0)).toBe(2n);
    expect(sizeNumberToScaledBigInt(-1.5, 0)).toBe(-1n);
  });

  test("scale 6 multiplies and rounds", () => {
    expect(sizeNumberToScaledBigInt(1, 6)).toBe(1_000_000n);
    expect(sizeNumberToScaledBigInt(0.000001, 6)).toBe(1n);
    expect(sizeNumberToScaledBigInt(0.0000014, 6)).toBe(1n);
    expect(sizeNumberToScaledBigInt(0.0000015, 6)).toBe(2n);
  });

  test("handles negative sizes", () => {
    expect(sizeNumberToScaledBigInt(-2.25, 2)).toBe(-225n);
  });
});

describe("priceToIndex", () => {
  test("maps price to nearest tick index", () => {
    expect(priceToIndex(100, 0.5)).toBe(200);
    expect(priceToIndex(100.24, 0.5)).toBe(200);
    expect(priceToIndex(100.25, 0.5)).toBe(201);
  });

  test("rounding works for small tick sizes", () => {
    expect(priceToIndex(1.234, 0.01)).toBe(123);
    expect(priceToIndex(1.235, 0.01)).toBe(124);
  });
});
