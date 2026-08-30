import { assertJsonValue, type JsonValue } from "@prismengine/contracts-data";

export const RUNTIME_RESULT_MAX_JSON_BYTES = 1_048_576;
export const RUNTIME_LOG_MAX_COUNT = 100;
export const RUNTIME_LOG_MAX_MESSAGE_LENGTH = 1_024;
export const RUNTIME_ERROR_MAX_LENGTH = 4_096;
const RUNTIME_CODE_MAX_LENGTH = 128;
const TRUNCATED = "[TRUNCATED]";

export interface RuntimeProtocolLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export type RuntimeOutputValidation =
  | { readonly valid: true; readonly output: JsonValue }
  | {
      readonly valid: false;
      readonly code: "PROJECT_ACTION_OUTPUT_INVALID" | "PROJECT_ACTION_OUTPUT_TOO_LARGE";
      readonly error: string;
    };

export function validateRuntimeOutput(value: unknown): RuntimeOutputValidation {
  try {
    assertJsonValue(value, "/result");
  } catch {
    return {
      valid: false,
      code: "PROJECT_ACTION_OUTPUT_INVALID",
      error: "Project Action output is not a valid JSON value.",
    };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return {
      valid: false,
      code: "PROJECT_ACTION_OUTPUT_INVALID",
      error: "Project Action output is not a valid JSON value.",
    };
  }
  if (Buffer.byteLength(serialized, "utf8") > RUNTIME_RESULT_MAX_JSON_BYTES) {
    return {
      valid: false,
      code: "PROJECT_ACTION_OUTPUT_TOO_LARGE",
      error: `Project Action output exceeds ${RUNTIME_RESULT_MAX_JSON_BYTES} JSON bytes.`,
    };
  }
  return { valid: true, output: value };
}

export function appendRuntimeLog(
  logs: RuntimeProtocolLog[],
  level: RuntimeProtocolLog["level"],
  value: unknown,
): void {
  if (logs.length >= RUNTIME_LOG_MAX_COUNT) return;
  if (logs.length === RUNTIME_LOG_MAX_COUNT - 1) {
    logs.push({ level: "warn", message: `Additional logs omitted. ${TRUNCATED}` });
    return;
  }
  logs.push({
    level,
    message: boundedRuntimeString(safeString(value), RUNTIME_LOG_MAX_MESSAGE_LENGTH),
  });
}

export function sanitizeRuntimeLogs(value: unknown): readonly RuntimeProtocolLog[] {
  const logs: RuntimeProtocolLog[] = [];
  if (!Array.isArray(value)) return logs;
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const level =
      "level" in item &&
      (item.level === "info" || item.level === "warn" || item.level === "error")
        ? item.level
        : "error";
    appendRuntimeLog(logs, level, "message" in item ? item.message : "Invalid log entry.");
  }
  return logs;
}

export function sanitizeRuntimeError(value: unknown): string {
  return boundedRuntimeString(
    typeof value === "string" ? value : "Project Action failed.",
    RUNTIME_ERROR_MAX_LENGTH,
  );
}

export function sanitizeRuntimeCode(value: unknown): string | undefined {
  return typeof value === "string"
    ? boundedRuntimeString(value, RUNTIME_CODE_MAX_LENGTH)
    : undefined;
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[UNPRINTABLE]";
  }
}

function boundedRuntimeString(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const prefixLength = maximum - TRUNCATED.length;
  let prefix = value.slice(0, prefixLength);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}${TRUNCATED}`;
}
