import type { Logger } from "@prismengine/kernel";

const sensitive =
  /authorization|cookie|token|secret|password|credential|connection|string|body|configuration|cause|stack/iu;

export function productionLogger(pluginId: string): Logger {
  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): void => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      pluginId,
      message,
      ...(details === undefined ? {} : { details: sanitize(details) }),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (level === "error" || level === "warn") process.stderr.write(line);
    else process.stdout.write(line);
  };
  return {
    debug: (message, details) => write("debug", message, details),
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}

function sanitize(value: unknown, depth = 0, seen = new Set<object>()): unknown {
  if (depth > 5) return "[DEPTH_LIMIT]";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Error) return { name: value.name };
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      result[key] = sensitive.test(key) ? "[REDACTED]" : sanitize(item, depth + 1, seen);
    }
    return result;
  }
  return `[${typeof value}]`;
}
