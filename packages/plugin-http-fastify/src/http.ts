import type { CallContext } from "@prismengine/contracts-data";
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

export interface HttpRoute {
  readonly method: HttpMethod;
  readonly path: string;
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
