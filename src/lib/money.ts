import { z } from "zod";

export const NUMERIC_SCALE = 0;

export function takFromNumeric(value: string): bigint {
  return BigInt(value);
}

export function takToNumeric(value: bigint): string {
  return value.toString();
}

export const numericToTak = z.string().transform((value) => BigInt(value));

export const takToNumericSchema = z.bigint().transform((value) => value.toString());

export const positiveTakSchema = z.bigint().positive("amount must be positive");
