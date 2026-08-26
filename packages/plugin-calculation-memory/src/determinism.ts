import { createHash } from "node:crypto";
import { Decimal, decimalToJson } from "@prism/contracts-data";

function normalize(value: unknown): unknown {
  if (Decimal.isDecimal(value)) return { $decimal: decimalToJson(value) };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, normalize(record[key])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function canonicalValue(value: unknown): string {
  if (Decimal.isDecimal(value)) return `decimal:${decimalToJson(value)}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  return `${typeof value}:${stableStringify(value)}`;
}
