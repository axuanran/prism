import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions";
import { PrismError, type CallContext } from "@prismengine/contracts-data";
import {
  createOpenTelemetryHttpTelemetry,
  type HttpTelemetry,
} from "@prismengine/plugin-http-fastify";

export interface PrismOpenTelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly deploymentEnvironment: string;
  readonly deploymentId: string;
  readonly traceEndpoint: string;
  readonly metricEndpoint: string;
  readonly collectorHealthUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly metricExportIntervalMs?: number;
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export class PrismOpenTelemetry {
  readonly httpTelemetry: HttpTelemetry;
  private readonly sdk: NodeSDK;
  private readonly fetcher: typeof globalThis.fetch;
  private started = false;

  constructor(private readonly options: PrismOpenTelemetryOptions) {
    for (const [name, value] of Object.entries({
      serviceName: options.serviceName,
      serviceVersion: options.serviceVersion,
      deploymentEnvironment: options.deploymentEnvironment,
      deploymentId: options.deploymentId,
    })) {
      if (!value.trim()) {
        throw PrismError.of(
          "OTEL_CONFIGURATION_INVALID",
          `OpenTelemetry ${name} is required.`,
        );
      }
    }
    for (const [name, value] of Object.entries({
      traceEndpoint: options.traceEndpoint,
      metricEndpoint: options.metricEndpoint,
      collectorHealthUrl: options.collectorHealthUrl,
    })) {
      const url = new URL(value);
      if (url.protocol !== "https:" && options.allowInsecureHttp !== true) {
        throw PrismError.of("OTEL_TLS_REQUIRED", `OpenTelemetry ${name} must use HTTPS.`);
      }
    }
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.deploymentEnvironment,
      "prism.deployment.id": options.deploymentId,
    });
    const traceExporter = new OTLPTraceExporter({
      url: options.traceEndpoint,
      headers: { ...options.headers },
    });
    const metricExporter = new OTLPMetricExporter({
      url: options.metricEndpoint,
      headers: { ...options.headers },
    });
    this.sdk = new NodeSDK({
      resource,
      traceExporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: options.metricExportIntervalMs ?? 30_000,
      }),
    });
    this.httpTelemetry = createOpenTelemetryHttpTelemetry(`${options.serviceName}/http`);
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  start(): void {
    if (this.started) return;
    this.sdk.start();
    this.started = true;
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.sdk.shutdown();
  }

  async productionReadiness(context: CallContext) {
    if (!this.started) {
      return {
        id: "otel-exporter" as const,
        passed: false,
        evidence: JSON.stringify({ exporter: "otlp-http", started: false }),
      };
    }
    try {
      const timeout = AbortSignal.timeout(5_000);
      const signal =
        context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
      const response = await this.fetcher(this.options.collectorHealthUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
      const trace = new URL(this.options.traceEndpoint);
      const metric = new URL(this.options.metricEndpoint);
      return {
        id: "otel-exporter" as const,
        passed: response.ok,
        evidence: JSON.stringify({
          exporter: "otlp-http",
          started: true,
          collectorHealth: response.status,
          traceOrigin: trace.origin,
          metricOrigin: metric.origin,
          serviceName: this.options.serviceName,
          serviceVersion: this.options.serviceVersion,
          deploymentEnvironment: this.options.deploymentEnvironment,
        }),
      };
    } catch (error) {
      return {
        id: "otel-exporter" as const,
        passed: false,
        evidence: JSON.stringify({
          exporter: "otlp-http",
          started: true,
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      };
    }
  }
}
