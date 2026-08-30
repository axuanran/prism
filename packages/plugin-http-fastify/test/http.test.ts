import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { CallContext, Principal } from "@prismengine/contracts-data";
import { PrismError } from "@prismengine/contracts-data";
import { createEngine, defineCapability, definePlugin } from "@prismengine/kernel";
import type { Engine, EngineInspection } from "@prismengine/kernel";
import {
  HttpCapabilityToken,
  HttpDiagnosticCode,
  HttpRouteExtensionPoint,
  createHttpPlugin,
  createOidcPrincipalProvider,
  composeProductionReadiness,
} from "@prismengine/plugin-http-fastify";
import type { HttpCapability } from "@prismengine/plugin-http-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface HiddenCapability {
  read(call: CallContext): string;
}

const HiddenCapabilityToken = defineCapability<HiddenCapability>({
  id: "test.hidden",
  version: "1.0.0",
});
function oidcToken(
  privateKey: KeyObject,
  claims: Readonly<Record<string, unknown>>,
  kid = "test-key",
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function oidcRequest(token: string) {
  return {
    method: "POST",
    path: "/api/publish",
    headers: { authorization: `Bearer ${token}` },
  };
}

async function prismErrorCodes(
  operation: () => unknown | Promise<unknown>,
): Promise<readonly string[]> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof PrismError) return error.diagnostics.map((item) => item.code);
    throw error;
  }
  throw new Error("Expected operation to reject with PrismError");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const hiddenCapabilityPlugin = definePlugin({
  id: "test-hidden-capability",
  version: "0.1.0",
  engineRange: "^0.1.20",
  provides: [HiddenCapabilityToken],
  register(context) {
    context.provide(HiddenCapabilityToken, {
      read: () => "not exposed",
    });
  },
});

let echoRouteCalls = 0;
let principalRouteCalls = 0;
let waitRouteStarted: (() => void) | undefined;
let waitRouteAborted: (() => void) | undefined;
let waitRouteAbortCount = 0;
let normalRouteAbortCount = 0;

const routeContributorPlugin = definePlugin({
  id: "test-http-routes",
  version: "0.1.0",
  engineRange: "^0.1.20",
  register(context) {
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "POST",
      path: "/api/echo/:id",
      access: { kind: "permission", permission: "test.echo" },
      handler: async (request) => {
        echoRouteCalls += 1;
        return {
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
        };
      },
    });
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "GET",
      path: "/api/principal",
      access: { kind: "public" },
      handler: async (request) => {
        principalRouteCalls += 1;
        return { status: 200, body: request.call.principal };
      },
    });
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "GET",
      path: "/api/prism-error",
      access: { kind: "public" },
      handler: async () => {
        throw PrismError.of("TEST_REQUEST_INVALID", "The request is invalid.", {
          field: "metricId",
          value: "patient-secret",
          cause: "postgres://admin:private-password@db.internal/prism",
          stack: "private-stack-line",
          note: "x".repeat(1_000),
        });
      },
    });
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "GET",
      path: "/api/unknown-error",
      access: { kind: "public" },
      handler: async () => {
        throw new Error("private failure with a private stack");
      },
    });
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "GET",
      path: "/api/response-headers",
      access: { kind: "public" },
      handler: async (request) => {
        request.call.signal?.addEventListener(
          "abort",
          () => {
            normalRouteAbortCount += 1;
          },
          { once: true },
        );
        return {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "x-prism-test": "present",
            "x-correlation-id": "forged-by-route",
          },
          body: { status: "ok" },
        };
      },
    });
    context.extensions.contribute(HttpRouteExtensionPoint, {
      method: "GET",
      path: "/api/wait-for-abort",
      access: { kind: "public" },
      handler: async (request) => {
        const signal = request.call.signal;
        if (signal === undefined) {
          throw new Error("HTTP CallContext did not include an AbortSignal.");
        }
        waitRouteStarted?.();
        return new Promise((resolve) => {
          const aborted = () => {
            waitRouteAbortCount += 1;
            waitRouteAborted?.();
            resolve({ status: 499, body: { status: "aborted" } });
          };
          if (signal.aborted) aborted();
          else signal.addEventListener("abort", aborted, { once: true });
        });
      },
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
    engineRange: "^0.1.20",
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
        principalProvider: ({ headers }) => {
          if (headers.authorization === "Bearer inspector") {
            return {
              id: "inspector-1",
              roles: ["INSPECTOR"],
              permissions: ["inspection.read"],
            };
          }
          if (headers.authorization === "Bearer person-7") {
            return {
              id: "person-7",
              roles: ["USER"],
              permissions: ["test.echo"],
            };
          }
          if (headers.authorization === "Bearer duplicate-principal") {
            return {
              id: "principal-1",
              displayName: "Principal One",
              roles: ["READER", "READER"],
              permissions: ["test.echo", "test.echo"],
            };
          }
          if (headers.authorization === "Bearer oversized-principal") {
            return {
              id: `private-${"x".repeat(200)}`,
              roles: [],
            } as Principal;
          }
          if (headers.authorization === "Bearer control-principal") {
            return {
              id: "principal-control",
              roles: ["READER\nprivate"],
            } as Principal;
          }
          if (headers.authorization === "Bearer malformed-principal") {
            return {
              id: "principal-malformed",
              roles: [12],
              permissions: "test.echo",
            } as unknown as Principal;
          }
          if (headers.authorization === "Bearer excessive-permissions") {
            return {
              id: "principal-permissions",
              roles: [],
              permissions: Array.from({ length: 257 }, (_, index) => `p-${index}`),
            };
          }
          return null;
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
    const response = await fetch(`${address}/api/engine/inspection`, {
      headers: { authorization: "Bearer inspector" },
    });
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
        authorization: "Bearer person-7",
        "content-type": "application/json",
        "x-as-of": "2026-08-01T00:00:00.000Z",
        "x-correlation-id": "correlation-123",
        "x-principal-id": "forged-person",
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
    expect(response.headers.get("x-correlation-id")).toBe("correlation-123");
  });

  it("normalizes trusted principals and rejects malformed provider output", async () => {
    const accepted = await fetch(`${address}/api/principal`, {
      headers: { authorization: "Bearer duplicate-principal" },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      id: "principal-1",
      displayName: "Principal One",
      roles: ["READER"],
      permissions: ["test.echo"],
    });

    const callsBefore = principalRouteCalls;
    for (const authorization of [
      "Bearer oversized-principal",
      "Bearer control-principal",
      "Bearer malformed-principal",
      "Bearer excessive-permissions",
    ]) {
      const response = await fetch(`${address}/api/principal`, {
        headers: { authorization },
      });
      expect(response.status).toBe(422);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        correlationId: expect.any(String),
        diagnostics: [
          {
            code: "AUTHENTICATION_PROVIDER_INVALID",
            message: "Trusted principal provider returned an invalid identity.",
          },
        ],
      });
      expect(body.length).toBeLessThan(1_024);
      expect(body).not.toContain("private-");
    }
    expect(principalRouteCalls).toBe(callsBefore);
  });

  it("rejects malformed as-of metadata before route execution", async () => {
    const callsBefore = echoRouteCalls;
    const invalidValues = [
      "2026-02-30",
      "2026-08-01T25:00:00Z",
      "2026-08-01T00:00:00",
      "not-a-date",
    ];

    for (const [index, validAt] of invalidValues.entries()) {
      const response = await fetch(`${address}/api/echo/person-7`, {
        method: "POST",
        headers: {
          authorization: "Bearer person-7",
          "x-as-of": validAt,
          "x-correlation-id": `invalid-as-of-${index}`,
        },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("x-correlation-id")).toBe(`invalid-as-of-${index}`);
      expect(await response.json()).toMatchObject({
        diagnostics: [{ code: "HTTP_REQUEST_INVALID" }],
      });
    }

    expect(echoRouteCalls).toBe(callsBefore);
  });

  it("rejects unsafe correlation IDs and responds with a generated safe ID", async () => {
    const callsBefore = echoRouteCalls;
    const invalidValues = ["unsafe correlation", "A".repeat(129)];

    for (const supplied of invalidValues) {
      const response = await fetch(`${address}/api/echo/person-7`, {
        method: "POST",
        headers: {
          authorization: "Bearer person-7",
          "x-correlation-id": supplied,
        },
      });
      const responseId = response.headers.get("x-correlation-id");
      const body = (await response.json()) as {
        readonly correlationId: string;
        readonly diagnostics: readonly { readonly code: string }[];
      };
      expect(response.status).toBe(400);
      expect(responseId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
      expect(responseId).not.toBe(supplied);
      expect(body.correlationId).toBe(responseId);
      expect(body.diagnostics).toMatchObject([{ code: "HTTP_REQUEST_INVALID" }]);
    }

    expect(echoRouteCalls).toBe(callsBefore);
  });

  it("rejects an unsafe correlation ID on an unregistered route without recursion", async () => {
    const response = await fetch(`${address}/api/not-registered`, {
      headers: { "x-correlation-id": "unsafe correlation" },
    });
    const responseId = response.headers.get("x-correlation-id");

    expect(response.status).toBe(400);
    expect(responseId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    expect(await response.json()).toEqual({
      correlationId: responseId,
      diagnostics: [
        {
          code: "HTTP_REQUEST_INVALID",
          severity: "error",
          message: "Correlation ID is invalid.",
        },
      ],
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
    const parsed = JSON.parse(body) as {
      readonly correlationId: string;
      readonly diagnostics: readonly {
        readonly code: string;
        readonly details: Readonly<Record<string, unknown>>;
      }[];
    };
    expect(parsed).toMatchObject({
      correlationId: expect.any(String),
      diagnostics: [
        {
          code: "TEST_REQUEST_INVALID",
          severity: "error",
          message: "The request is invalid.",
          details: {
            field: "metricId",
            value: "[REDACTED]",
            cause: "[REDACTED]",
            stack: "[REDACTED]",
          },
        },
      ],
    });
    const note = parsed.diagnostics[0]?.details.note;
    expect(typeof note === "string" ? note.length : 0).toBeLessThanOrEqual(512);
    expect(typeof note === "string" && note.endsWith("[TRUNCATED]")).toBe(true);
    expect(body).not.toContain("private-password");
    expect(body).not.toContain("private-stack-line");
    expect(body).not.toContain("patient-secret");
  });

  it("hides the internals of an unexpected failure behind a 500", async () => {
    const response = await fetch(`${address}/api/unknown-error`);
    expect(response.status).toBe(500);

    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      correlationId: expect.any(String),
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

  it("keeps the transport correlation header authoritative on normal completion", async () => {
    const abortsBefore = normalRouteAbortCount;
    const response = await fetch(`${address}/api/response-headers`, {
      headers: { "x-correlation-id": "request-correlation-1" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-prism-test")).toBe("present");
    expect(response.headers.get("x-correlation-id")).toBe("request-correlation-1");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(normalRouteAbortCount).toBe(abortsBefore);
  });

  it("aborts CallContext exactly once when the HTTP client disconnects", async () => {
    const isolated = await bootHttpEngine();
    const started = deferred<void>();
    const aborted = deferred<void>();
    const abortsBefore = waitRouteAbortCount;
    waitRouteStarted = () => started.resolve(undefined);
    waitRouteAborted = () => aborted.resolve(undefined);
    const client = new AbortController();

    try {
      const pending = fetch(`${isolated.address}/api/wait-for-abort`, {
        headers: { connection: "close" },
        signal: client.signal,
      });
      await started.promise;
      client.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await aborted.promise;
      expect(waitRouteAbortCount).toBe(abortsBefore + 1);
    } finally {
      waitRouteStarted = undefined;
      waitRouteAborted = undefined;
      await isolated.engine.stop();
    }
  });

  it("denies authenticated principals without the route permission", async () => {
    const response = await fetch(`${address}/api/echo/forbidden`, {
      method: "POST",
      headers: {
        authorization: "Bearer inspector",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      diagnostics: [{ code: "AUTHORIZATION_REQUIRED" }],
    });
  });

  it("verifies RS256 OIDC claims and maps permissions", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256" };
    const provider = createOidcPrincipalProvider({
      issuer: "https://identity.example",
      audience: "prism",
      jwksUri: "https://identity.example/.well-known/jwks.json",
      now: () => 2_000_000_000_000,
      fetch: async () =>
        new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const token = oidcToken(privateKey, {
      iss: "https://identity.example",
      sub: "operator-7",
      aud: ["prism"],
      exp: 2_000_000_100,
      roles: ["publisher", "system"],
      permissions: ["pipeline.publish"],
      name: "Operator 7",
    });
    const tokenParts = token.split(".");
    const signature = tokenParts[2];
    if (tokenParts.length !== 3 || !signature)
      throw new Error("Generated JWT is malformed");
    const tampered = `${tokenParts[0]}.${tokenParts[1]}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    await expect(
      provider({
        method: "POST",
        path: "/api/publish",
        headers: { authorization: `Bearer ${token}` },
      }),
    ).resolves.toEqual({
      id: "operator-7",
      displayName: "Operator 7",
      roles: ["publisher"],
      permissions: ["pipeline.publish"],
    });
    await expect(
      provider({
        method: "POST",
        path: "/api/publish",
        headers: { authorization: `Bearer ${tampered}` },
      }),
    ).resolves.toBeNull();
  });

  it("accepts new-kid and same-kid OIDC rotations in the same request", async () => {
    const oldPair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const newPair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const replacementPair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const oldJwk = {
      ...oldPair.publicKey.export({ format: "jwk" }),
      kid: "old-key",
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    };
    const newJwk = {
      ...newPair.publicKey.export({ format: "jwk" }),
      kid: "new-key",
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    };
    const replacementJwk = {
      ...replacementPair.publicKey.export({ format: "jwk" }),
      kid: "new-key",
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    };
    let currentTime = 2_000_000_000_000;
    let activeJwk = oldJwk;
    let fetchCount = 0;
    const provider = createOidcPrincipalProvider({
      issuer: "https://identity.example",
      audience: "prism",
      jwksUri: "https://identity.example/.well-known/jwks.json",
      now: () => currentTime,
      fetch: async () => {
        fetchCount += 1;
        return Response.json({ keys: [activeJwk] });
      },
    });
    const claims = {
      iss: "https://identity.example",
      sub: "rotated-operator",
      aud: "prism",
      exp: 2_000_000_100,
    };

    await expect(
      provider(oidcRequest(oidcToken(oldPair.privateKey, claims, "old-key"))),
    ).resolves.toMatchObject({ id: "rotated-operator" });
    activeJwk = newJwk;
    await expect(
      provider(oidcRequest(oidcToken(newPair.privateKey, claims, "new-key"))),
    ).resolves.toMatchObject({ id: "rotated-operator" });
    currentTime += 31_000;
    activeJwk = replacementJwk;
    await expect(
      provider(oidcRequest(oidcToken(replacementPair.privateKey, claims, "new-key"))),
    ).resolves.toMatchObject({ id: "rotated-operator" });
    expect(fetchCount).toBe(3);
  });

  it("shares one JWKS refresh across concurrent rotated-token requests", async () => {
    const oldPair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const newPair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    let activeJwk = {
      ...oldPair.publicKey.export({ format: "jwk" }),
      kid: "old-key",
      alg: "RS256",
      use: "sig",
    };
    let fetchCount = 0;
    const provider = createOidcPrincipalProvider({
      issuer: "https://identity.example",
      audience: "prism",
      jwksUri: "https://identity.example/.well-known/jwks.json",
      now: () => 2_000_000_000_000,
      fetch: async () => {
        fetchCount += 1;
        return Response.json({ keys: [activeJwk] });
      },
    });
    const claims = {
      iss: "https://identity.example",
      sub: "concurrent-operator",
      aud: "prism",
      exp: 2_000_000_100,
    };
    await provider(oidcRequest(oidcToken(oldPair.privateKey, claims, "old-key")));
    activeJwk = {
      ...newPair.publicKey.export({ format: "jwk" }),
      kid: "new-key",
      alg: "RS256",
      use: "sig",
    };
    const token = oidcToken(newPair.privateKey, claims, "new-key");

    const principals = await Promise.all(
      Array.from({ length: 8 }, () => provider(oidcRequest(token))),
    );

    expect(principals.every((principal) => principal?.id === "concurrent-operator")).toBe(
      true,
    );
    expect(fetchCount).toBe(2);
  });

  it("bounds unknown-kid JWKS refreshes with a cooldown", async () => {
    const trustedPair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const unknownPair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const trustedJwk = {
      ...trustedPair.publicKey.export({ format: "jwk" }),
      kid: "trusted-key",
      alg: "RS256",
      use: "sig",
    };
    let currentTime = 2_000_000_000_000;
    let fetchCount = 0;
    const provider = createOidcPrincipalProvider({
      issuer: "https://identity.example",
      audience: "prism",
      jwksUri: "https://identity.example/.well-known/jwks.json",
      now: () => currentTime,
      jwksRefreshCooldownMs: 60_000,
      fetch: async () => {
        fetchCount += 1;
        return Response.json({ keys: [trustedJwk] });
      },
    });
    const claims = {
      iss: "https://identity.example",
      sub: "unknown-operator",
      aud: "prism",
      exp: 2_000_000_100,
    };
    await provider(oidcRequest(oidcToken(trustedPair.privateKey, claims, "trusted-key")));
    await expect(
      provider(oidcRequest(oidcToken(unknownPair.privateKey, claims, "unknown-1"))),
    ).resolves.toBeNull();
    currentTime += 1_000;
    await expect(
      provider(oidcRequest(oidcToken(unknownPair.privateKey, claims, "unknown-2"))),
    ).resolves.toBeNull();

    expect(fetchCount).toBe(2);
  });

  it("ignores JWKs whose signing metadata is incompatible with RS256", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const incompatibleJwk = {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: "incompatible-key",
      alg: "RS512",
      use: "enc",
      key_ops: ["sign"],
    };
    const provider = createOidcPrincipalProvider({
      issuer: "https://identity.example",
      audience: "prism",
      jwksUri: "https://identity.example/.well-known/jwks.json",
      now: () => 2_000_000_000_000,
      fetch: async () => Response.json({ keys: [incompatibleJwk] }),
    });
    const token = oidcToken(
      pair.privateKey,
      {
        iss: "https://identity.example",
        sub: "incompatible-operator",
        aud: "prism",
        exp: 2_000_000_100,
      },
      "incompatible-key",
    );

    await expect(provider(oidcRequest(token))).resolves.toBeNull();
  });

  it("bounds and structures OIDC JWKS response decoding", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const token = oidcToken(pair.privateKey, {
      iss: "https://identity.example",
      sub: "bounded-jwks-operator",
      aud: "prism",
      exp: 2_000_000_100,
    });
    const common = {
      issuer: "https://identity.example",
      audience: "prism",
      jwksUri: "https://identity.example/.well-known/jwks.json",
      now: () => 2_000_000_000_000,
    };

    let bodyAccessCount = 0;
    const declaredOversize = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "9" }),
      get body() {
        bodyAccessCount += 1;
        throw new Error("oversized JWKS body must not be accessed");
      },
    } as unknown as Response;
    const declared = createOidcPrincipalProvider({
      ...common,
      jwksMaxResponseBytes: 8,
      fetch: async () => declaredOversize,
    });
    expect(await prismErrorCodes(() => declared(oidcRequest(token)))).toEqual([
      "AUTHENTICATION_PROVIDER_INVALID",
    ]);
    expect(bodyAccessCount).toBe(0);

    let cancelCount = 0;
    const overflowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private-overflow-jwks"));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const chunked = createOidcPrincipalProvider({
      ...common,
      jwksMaxResponseBytes: 8,
      fetch: async () => new Response(overflowBody),
    });
    const overflowFailure = await Promise.resolve(chunked(oidcRequest(token))).catch(
      (error: unknown) => error,
    );
    expect(overflowFailure).toMatchObject({
      diagnostics: [{ code: "AUTHENTICATION_PROVIDER_INVALID" }],
    });
    expect(JSON.stringify(overflowFailure)).not.toContain("private-overflow-jwks");
    expect(cancelCount).toBe(1);

    const malformed = createOidcPrincipalProvider({
      ...common,
      fetch: async () => new Response("private-malformed-jwks{"),
    });
    const malformedFailure = await Promise.resolve(malformed(oidcRequest(token))).catch(
      (error: unknown) => error,
    );
    expect(malformedFailure).toMatchObject({
      diagnostics: [{ code: "AUTHENTICATION_PROVIDER_INVALID" }],
    });
    expect(JSON.stringify(malformedFailure)).not.toContain("private-malformed-jwks");

    const truncated = createOidcPrincipalProvider({
      ...common,
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": "5" },
        }),
    });
    expect(await prismErrorCodes(() => truncated(oidcRequest(token)))).toEqual([
      "AUTHENTICATION_PROVIDER_INVALID",
    ]);
  });

  it("fails closed with structured diagnostics when JWKS is unavailable or times out", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const token = oidcToken(pair.privateKey, {
      iss: "https://identity.example",
      sub: "unavailable-operator",
      aud: "prism",
      exp: 2_000_000_100,
    });
    const common = {
      issuer: "https://identity.example",
      audience: "prism",
      jwksUri: "https://identity.example/.well-known/jwks.json",
      now: () => 2_000_000_000_000,
    };
    expect(() =>
      createOidcPrincipalProvider({
        ...common,
        jwksFetchTimeoutMs: 0,
      }),
    ).toThrow("AUTHENTICATION_PROVIDER_CONFIGURATION_INVALID");
    expect(() =>
      createOidcPrincipalProvider({
        ...common,
        jwksMaxResponseBytes: 0,
      }),
    ).toThrow("AUTHENTICATION_PROVIDER_CONFIGURATION_INVALID");
    expect(() =>
      createOidcPrincipalProvider({
        ...common,
        jwksMaxResponseBytes: 1.5,
      }),
    ).toThrow("AUTHENTICATION_PROVIDER_CONFIGURATION_INVALID");
    const unavailable = createOidcPrincipalProvider({
      ...common,
      fetch: async () => {
        throw new Error("identity provider unavailable");
      },
    });
    const timedOut = createOidcPrincipalProvider({
      ...common,
      jwksFetchTimeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("identity provider request aborted")),
            { once: true },
          );
        }),
    });

    expect(await prismErrorCodes(() => unavailable(oidcRequest(token)))).toEqual([
      "AUTHENTICATION_PROVIDER_UNAVAILABLE",
    ]);
    expect(await prismErrorCodes(() => timedOut(oidcRequest(token)))).toEqual([
      "AUTHENTICATION_PROVIDER_UNAVAILABLE",
    ]);
  });
});
const productionEvidence = [
  "artifact-store.production",
  "secret-provider.production",
  "audit-journal.valid",
  "audit-worm-export",
  "deployment.single-tenant",
  "control-plane.single-writer",
  "database.pitr",
  "rpo-rto.approved",
  "backup-restore.verified",
  "worker-container-isolation",
  "worker-node.dedicated",
  "otel-exporter",
  "sbom-signature.verified",
  "plugin-compatibility.verified",
  "migration-preflight.verified",
].map((id) => ({ id, passed: true, evidence: `verified:${id}` }));

describe("HTTP production readiness", () => {
  it("fails closed in production until every external control has evidence", async () => {
    let engine = createEngine({ plugins: [] });
    const http = createHttpPlugin({
      port: 0,
      deploymentMode: "production",
      inspection: () => engine.inspect(),
    });
    engine = createEngine({ plugins: [http] });
    await expect(engine.start()).rejects.toThrow("PRODUCTION_READINESS_FAILED");
  });

  it("starts in production only with identity, telemetry, and complete evidence", async () => {
    let engine = createEngine({ plugins: [] });
    const criticalRoute = definePlugin({
      id: "test-critical-route",
      version: "0.1.0",
      engineRange: "^0.1.20",
      register(context) {
        context.extensions.contribute(HttpRouteExtensionPoint, {
          method: "POST",
          path: "/api/critical",
          access: { kind: "permission", permission: "test.critical" },
          changeReason: "required",
          handler: async (request) => ({
            status: 200,
            body: { reason: request.call.changeReason },
          }),
        });
      },
    });
    const http = createHttpPlugin({
      port: 0,
      deploymentMode: "production",
      inspection: () => engine.inspect(),
      principalProvider: () => ({
        id: "host",
        roles: [],
        permissions: ["test.critical"],
      }),
      telemetry: {
        start: () => ({ end() {}, fail() {} }),
      },
      authorizationPolicy: () => true,
      productionReadiness: composeProductionReadiness(
        productionEvidence.map((check) => ({
          id: check.id,
          run: async () => check,
        })),
      ),
    });
    engine = createEngine({ plugins: [criticalRoute, http] });
    await engine.start();
    const address = engine.capability(HttpCapabilityToken).address();
    if (address === null) throw new Error("HTTP server did not bind");
    const readiness = await fetch(`${address}/ready`);
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).toEqual({ status: "ready", failedChecks: [] });
    expect((await fetch(`${address}/api/critical`, { method: "POST" })).status).toBe(403);
    const accepted = await fetch(`${address}/api/critical`, {
      method: "POST",
      headers: { "x-change-reason": "approved deployment change" },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ reason: "approved deployment change" });
    await engine.stop();
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
      headers: {
        authorization: "Bearer person-7",
        "content-type": "application/json",
      },
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
