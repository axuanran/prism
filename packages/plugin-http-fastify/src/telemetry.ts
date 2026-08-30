import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

export interface HttpTelemetryRequest {
  readonly method: string;
  readonly route: string;
  readonly correlationId: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export interface HttpTelemetryObservation {
  end(status: number): void;
  fail(status: number, error: unknown): void;
}

export interface HttpTelemetry {
  start(request: HttpTelemetryRequest): HttpTelemetryObservation;
}

const headerGetter = {
  keys(carrier: HttpTelemetryRequest["headers"]): string[] {
    return Object.keys(carrier);
  },
  get(
    carrier: HttpTelemetryRequest["headers"],
    key: string,
  ): string | string[] | undefined {
    const value = carrier[key.toLowerCase()];
    return typeof value === "string"
      ? value
      : value === undefined
        ? undefined
        : Array.from(value);
  },
};

export function createOpenTelemetryHttpTelemetry(
  instrumentationName = "@prismengine/plugin-http-fastify",
): HttpTelemetry {
  const tracer = trace.getTracer(instrumentationName);
  const meter = metrics.getMeter(instrumentationName);
  const duration = meter.createHistogram("prism.http.server.duration", { unit: "ms" });
  const requests = meter.createCounter("prism.http.server.requests");

  return {
    start(request) {
      const parent = propagation.extract(context.active(), request.headers, headerGetter);
      const attributes: Attributes = {
        "http.request.method": request.method,
        "http.route": request.route,
        "prism.correlation_id": request.correlationId,
      };
      const span = tracer.startSpan(
        `${request.method} ${request.route}`,
        { kind: SpanKind.SERVER, attributes },
        parent,
      );
      const started = performance.now();
      let ended = false;
      const finish = (status: number, error?: unknown): void => {
        if (ended) return;
        ended = true;
        const resultAttributes: Attributes = {
          ...attributes,
          "http.response.status_code": status,
        };
        requests.add(1, resultAttributes);
        duration.record(performance.now() - started, resultAttributes);
        span.setAttribute("http.response.status_code", status);
        if (error === undefined) {
          span.setStatus({
            code: status >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR });
          recordSafeError(span, error);
        }
        span.end();
      };
      return {
        end: (status) => finish(status),
        fail: (status, error) => finish(status, error),
      };
    },
  };
}

function recordSafeError(span: Span, error: unknown): void {
  span.recordException({
    name: error instanceof Error ? error.name : "Error",
    message: "Request failed",
  });
}
