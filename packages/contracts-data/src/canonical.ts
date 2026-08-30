import { createHash } from "node:crypto";
import { assertJsonValue, type JsonValue } from "./json.js";

export function canonicalJson(value: unknown): JsonValue {
  assertJsonValue(value, "/");
  return canonical(value as JsonValue);
}

export function canonicalJsonText(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

export function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonText(value), "utf8").digest("hex");
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}
