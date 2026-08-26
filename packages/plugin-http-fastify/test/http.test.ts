import type { CallContext } from "@prism/contracts-data";
import { PrismError } from "@prism/contracts-data";
import { createEngine, defineCapability, definePlugin } from "@prism/kernel";
import type { Engine, EngineInspection } from "@prism/kernel";
import {
  HttpCapabilityToken,
  HttpDiagnosticCode,
  HttpRouteExtensionPoint,
  createHttpPlugin,
} from "@prism/plugin-http-fastify";
import type { HttpCapability } from "@prism/plugin-http-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface HiddenCapability {
  read(call: CallContext): string;
}

const HiddenCapabilityToken = defineCapability<HiddenCapability>({
  id: "test.hidden",
  version: "1.0.0",
});

const hiddenCapabilityPlugin = definePlugin({
  id: "test-hidden-capability",
  version: "0.1.0",
  provides: [HiddenCapabilityToken],
  register(context) {
    context.provide(HiddenCapabilityToken, {
      read: () => "not exposed",
    });
  },
});

const routeContributorPlugin = definePlugin({
  id: "test-http-routes",
  version: "0.1.0",
  register(context) {
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "POST",
      path: "/api/echo/:id",
      handler: async (request) => ({
        status: 200,
        body: {
          params: request.params,
          query: request.query,
          body: request.body,
          probeHeader: request.headers["x-probe"],
          principalId: request.call.principal.id,
          correlationId: request.call.correlationId,
          validAt: request.call.asOf.validAt,
        },
      }),
    });
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "GET",
      path: "/api/prism-error",
      handler: async () => {
        throw PrismError.of("TEST_REQUEST_INVALID", "The request is invalid.", {
          field: "metricId",
        });
      },
    });
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "GET",
      path: "/api/unknown-error",
      handler: async () => {
        throw new Error("private failure with a private stack");
      },
    });
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "GET",
      path: "/api/response-headers",
      handler: async () => ({
        status: 200,
        headers: {
          "cache-control": "no-store",
          "x-prism-test": "present",
        },
        body: { status: "ok" },
      }),
    });
  },
});

/** Boots a fresh engine on an ephemeral port and returns its bound address. */
async function bootHttpEngine(): Promise<{
  readonly engine: Engine;
  readonly address: string;
  readonly capability: HttpCapability;
}> {
  let httpCapability: HttpCapability | undefined;

  const addressObserver = definePlugin({
    id: "test-http-address-observer",
    version: "0.1.0",
    requires: { http: HttpCapabilityToken },
    start(context) {
      httpCapability = context.dependencies.http;
    },
  });

  // The inspection reader is late-bound: the plugin list is built before the
  // engine exists, and the plugin must never reach into the engine itself.
  const host: { engine?: Engine } = {};
  const engine = createEngine({
    plugins: [
      addressObserver,
      hiddenCapabilityPlugin,
      routeContributorPlugin,
      createHttpPlugin({
        port: 0,
        inspection: () => {
          if (!host.engine) throw new Error("Inspection requested before boot.");
          return host.engine.inspect();
        },
      }),
    ],
  });
  host.engine = engine;

  await engine.start();
  if (!httpCapability) throw new Error("HTTP capability was not injected.");
  return { engine, address: requireAddress(httpCapability), capability: httpCapability };
}

describe("HTTP plugin", () => {
  let engine: Engine;
  let address: string;


  beforeAll(async () => {
    ({ engine, address } = await bootHttpEngine());
  });

  afterAll(async () => {
    await engine.stop();
  });

  it("serves the health endpoint", async () => {
    const response = await fetch(`${address}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves the engine inspection supplied by the host", async () => {
    const response = await fetch(`${address}/api/engine/inspection`);
    expect(response.status).toBe(200);

    const inspection = (await response.json()) as EngineInspection;
    expect(inspection.phase).toBe("started");
    expect(inspection.capabilities).toContainEqual({
      id: "test.hidden",
      version: "1.0.0",
      providedBy: "test-hidden-capability",
    });
  });

  it("builds a call context from headers and passes params, query and body", async () => {
    const response = await fetch(`${address}/api/echo/person-7?period=2026-08`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-as-of": "2026-08-01T00:00:00.000Z",
        "x-correlation-id": "correlation-123",
        "x-principal-id": "person-7",
        "x-probe": "present",
      },
      body: JSON.stringify({ workload: 100 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      params: { id: "person-7" },
      query: { period: "2026-08" },
      body: { workload: 100 },
      probeHeader: "present",
      principalId: "person-7",
      correlationId: "correlation-123",
      validAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("does not expose a capability that contributed no route", async () => {
    const response = await fetch(`${address}/api/capabilities/test.hidden`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      diagnostics: [{ code: HttpDiagnosticCode.ROUTE_NOT_FOUND }],
    });
  });

  it("maps a PrismError to 400 with its diagnostics and no stack", async () => {
    const response = await fetch(`${address}/api/prism-error`);
    expect(response.status).toBe(400);

    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      diagnostics: [
        {
          code: "TEST_REQUEST_INVALID",
          severity: "error",
          message: "The request is invalid.",
          details: { field: "metricId" },
        },
      ],
    });
    expect(body).not.toContain("stack");
  });

  it("hides the internals of an unexpected failure behind a 500", async () => {
    const response = await fetch(`${address}/api/unknown-error`);
    expect(response.status).toBe(500);

    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      diagnostics: [
        {
          code: HttpDiagnosticCode.HANDLER_FAILED,
          severity: "error",
          message: "HTTP route handler failed.",
        },
      ],
    });
    expect(body).not.toContain("stack");
    expect(body).not.toContain("private failure");
  });

  it("forwards handler response headers to the HTTP client", async () => {
    const response = await fetch(`${address}/api/response-headers`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-test")).toBe("present");
  });
});

describe("HTTP plugin lifecycle", () => {
  it("closes the server when the engine stops", async () => {
    const { engine, address, capability } = await bootHttpEngine();

    expect((await fetch(`${address}/health`)).status).toBe(200);

    await engine.stop();

    expect(capability.address()).toBeNull();
    await expect(fetch(`${address}/health`)).rejects.toThrow();
  });

  it("serves contributed routes again after a restart", async () => {
    // Regression: the plugin closed route registration on first start and
    // never reopened it. Once the engine learned to restart - which rebuilds
    // its registries and re-registers every plugin - the second boot rejected
    // the very routes the first boot had accepted.
    const { engine } = await bootHttpEngine();
    await engine.stop();

    await engine.start();
    const inspection = engine.inspect();
    expect(inspection.phase).toBe("started");

    const capability = engine.capability(HttpCapabilityToken);
    const address = requireAddress(capability);

    expect((await fetch(`${address}/health`)).status).toBe(200);

    const echo = await fetch(`${address}/api/echo/after-restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ restarted: true }),
    });
    expect(echo.status).toBe(200);
    expect(await echo.json()).toMatchObject({
      params: { id: "after-restart" },
      body: { restarted: true },
    });

    await engine.stop();
  });
});

function requireAddress(capability: HttpCapability | undefined): string {
  const address = capability?.address();
  if (address === undefined || address === null) {
    throw new Error("HTTP capability did not expose a bound address.");
  }
  return address;
}
