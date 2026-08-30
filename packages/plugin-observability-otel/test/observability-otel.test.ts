import { systemCallContext } from "@prismengine/contracts-data";
import { PrismOpenTelemetry } from "@prismengine/plugin-observability-otel";
import { describe, expect, it } from "vitest";

const context = systemCallContext({ correlationId: "otel-test" });

describe("Prism OpenTelemetry", () => {
  it("fails closed before startup and returns safe live collector evidence", async () => {
    const telemetry = new PrismOpenTelemetry({
      serviceName: "prism-test",
      serviceVersion: "0.1.20",
      deploymentEnvironment: "test",
      deploymentId: "deployment-test",
      traceEndpoint: "http://collector.test/v1/traces",
      metricEndpoint: "http://collector.test/v1/metrics",
      collectorHealthUrl: "http://collector.test/health",
      headers: { authorization: "secret-header" },
      allowInsecureHttp: true,
      fetch: async () => Response.json({ status: "ok" }),
    });
    await expect(telemetry.productionReadiness(context)).resolves.toMatchObject({
      id: "otel-exporter",
      passed: false,
      evidence: expect.stringContaining('"started":false'),
    });
    telemetry.start();
    const readiness = await telemetry.productionReadiness(context);
    expect(readiness).toMatchObject({
      id: "otel-exporter",
      passed: true,
      evidence: expect.stringContaining('"collectorHealth":200'),
    });
    expect(readiness.evidence).not.toContain("secret-header");
    await telemetry.shutdown();
  });

  it("requires TLS unless a test/development host opts out", () => {
    expect(
      () =>
        new PrismOpenTelemetry({
          serviceName: "prism",
          serviceVersion: "0.1.20",
          deploymentEnvironment: "production",
          deploymentId: "deployment",
          traceEndpoint: "http://collector/v1/traces",
          metricEndpoint: "https://collector/v1/metrics",
          collectorHealthUrl: "https://collector/health",
        }),
    ).toThrow("OTEL_TLS_REQUIRED");
  });
});
