import type { CallContext, Diagnostic } from "@prismengine/contracts-data";
import { defineCapability, defineExtensionPoint } from "@prismengine/kernel";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface HttpRequest {
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly call: CallContext;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  /** Extra response headers, e.g. content-type or cache-control. */
  readonly headers?: Readonly<Record<string, string>>;
}
export type HttpRouteAccess =
  | { readonly kind: "public" }
  | { readonly kind: "permission"; readonly permission: string };

export interface HttpRoute {
  readonly method: HttpMethod;
  readonly path: string;
  /**
   * Required on every route. Missing metadata is rejected during registration
   * so a new endpoint can never become public by omission.
   */
  readonly access: HttpRouteAccess;
  /** Critical production mutations can require an operator-supplied reason. */
  readonly changeReason?: "required" | "optional";
  readonly summary?: string;
  readonly handler: (request: HttpRequest) => Promise<HttpResponse>;
}

export const HttpRouteExtensionPoint = defineExtensionPoint<HttpRoute>({
  id: "http.routes",
  version: "1.0.0",
});

export interface HttpCapability {
  address(): string | null;
  register(route: HttpRoute): void;
}

export const HttpCapabilityToken = defineCapability<HttpCapability>({
  id: "http",
  version: "1.0.0",
});

export const HttpDiagnosticCode = {
  HANDLER_FAILED: "HTTP_HANDLER_FAILED",
  ROUTE_NOT_FOUND: "HTTP_ROUTE_NOT_FOUND",
  ROUTE_REGISTRATION_CLOSED: "HTTP_ROUTE_REGISTRATION_CLOSED",
} as const;

export type HttpDiagnosticCode =
  (typeof HttpDiagnosticCode)[keyof typeof HttpDiagnosticCode];

const SENSITIVE_DIAGNOSTIC_KEY =
  /authorization|cookie|token|secret|password|credential|body|configuration|input|value|cause|error|stack|exception/iu;
const TRUNCATED = "[TRUNCATED]";
const MAX_PUBLIC_DIAGNOSTICS = 25;
const MAX_DIAGNOSTIC_CODE = 128;
const MAX_DIAGNOSTIC_MESSAGE = 512;
const MAX_DIAGNOSTIC_PATH = 256;
const MAX_DIAGNOSTIC_NODE_ID = 128;
const MAX_DETAIL_KEY = 128;
const MAX_DETAIL_STRING = 512;
const MAX_DETAIL_ARRAY = 25;
const MAX_DETAIL_OBJECT = 50;

export function publicDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  const truncated = diagnostics.length > MAX_PUBLIC_DIAGNOSTICS;
  const visible = diagnostics.slice(
    0,
    truncated ? MAX_PUBLIC_DIAGNOSTICS - 1 : MAX_PUBLIC_DIAGNOSTICS,
  );
  const projected: Diagnostic[] = visible.map((item) => ({
    code: boundedString(item.code, MAX_DIAGNOSTIC_CODE),
    severity: item.severity,
    message: boundedString(item.message, MAX_DIAGNOSTIC_MESSAGE),
    ...(item.nodeId === undefined
      ? {}
      : { nodeId: boundedString(item.nodeId, MAX_DIAGNOSTIC_NODE_ID) }),
    ...(item.path === undefined
      ? {}
      : { path: boundedString(item.path, MAX_DIAGNOSTIC_PATH) }),
    ...(item.details === undefined
      ? {}
      : { details: sanitizeDiagnosticDetails(item.details) }),
  }));
  if (truncated) {
    projected.push({
      code: "HTTP_DIAGNOSTICS_TRUNCATED",
      severity: "warning",
      message: "Additional diagnostics were omitted.",
    });
  }
  return projected;
}

function sanitizeDiagnosticDetails(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return sanitizeDiagnosticObject(value, 0);
}

function diagnosticDetailValue(value: unknown, depth: number): unknown {
  if (depth >= 3) return "[DEPTH_LIMIT]";
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return boundedString(value, MAX_DETAIL_STRING);
  if (Array.isArray(value)) {
    const truncated = value.length > MAX_DETAIL_ARRAY;
    const visible = value
      .slice(0, truncated ? MAX_DETAIL_ARRAY - 1 : MAX_DETAIL_ARRAY)
      .map((item) => diagnosticDetailValue(item, depth + 1));
    if (truncated) visible.push(TRUNCATED);
    return visible;
  }
  if (typeof value === "object") {
    return sanitizeDiagnosticObject(value as Readonly<Record<string, unknown>>, depth);
  }
  return `[${typeof value}]`;
}

function sanitizeDiagnosticObject(
  value: Readonly<Record<string, unknown>>,
  depth: number,
): Readonly<Record<string, unknown>> {
  const entries = Object.entries(value);
  const truncated = entries.length > MAX_DETAIL_OBJECT;
  const visible = entries.slice(0, truncated ? MAX_DETAIL_OBJECT - 1 : MAX_DETAIL_OBJECT);
  const projected: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const [key, item] of visible) {
    const publicKey = boundedString(key, MAX_DETAIL_KEY);
    if (seen.has(publicKey)) continue;
    seen.add(publicKey);
    projected.push([
      publicKey,
      SENSITIVE_DIAGNOSTIC_KEY.test(key)
        ? "[REDACTED]"
        : diagnosticDetailValue(item, depth + 1),
    ]);
  }
  if (truncated) projected.push([TRUNCATED, true]);
  return Object.fromEntries(projected);
}

function boundedString(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const prefixLength = maximum - TRUNCATED.length;
  let prefix = value.slice(0, prefixLength);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}${TRUNCATED}`;
}
