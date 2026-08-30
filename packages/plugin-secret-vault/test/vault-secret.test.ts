import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemCallContext } from "@prismengine/contracts-data";
import {
  SECRET_FIELD_MAX_LENGTH,
  SECRET_KEY_MAX_LENGTH,
  SECRET_VERSION_MAX_LENGTH,
  type SecretRef,
} from "@prismengine/contracts-secret";
import {
  VAULT_AUTH_MOUNT_MAX_LENGTH,
  VAULT_JWT_PATH_MAX_LENGTH,
  VAULT_KUBERNETES_JWT_MAX_BYTES,
  VAULT_NAMESPACE_MAX_LENGTH,
  VAULT_ROLE_MAX_LENGTH,
  VAULT_TOKEN_MAX_BYTES,
  VaultSecretCapability,
} from "@prismengine/plugin-secret-vault";
import { describe, expect, it } from "vitest";

const context = systemCallContext({ correlationId: "vault-secret-test" });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("Vault KV v2 Secret provider", () => {
  it("resolves one selected field and verifies Vault health without leaking the token", async () => {
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/v1/sys/health")) {
        return Response.json({ initialized: true, sealed: false });
      }
      if (url.endsWith("/v1/auth/token/lookup-self")) {
        return Response.json({ data: { id: "token" } });
      }
      if (url.includes("/v1/secret/data/database%20prod?version=7")) {
        return Response.json({
          data: {
            data: { password: "vault-password", username: "prism" },
            metadata: { version: 7 },
          },
        });
      }
      return Response.json({}, { status: 404 });
    };
    const secrets = new VaultSecretCapability({
      address: "https://vault.example",
      authentication: {
        kind: "token",
        resolveToken: () => "host-owned-token",
      },
      fetch: fetcher,
    });

    await expect(
      secrets.resolve(context, {
        provider: "vault",
        key: "database prod",
        field: "password",
        version: "7",
      }),
    ).resolves.toEqual({ value: "vault-password", version: "7" });
    const readRequest = requests.find((request) =>
      request.url.includes("/v1/secret/data/"),
    );
    expect(new Headers(readRequest?.init?.headers).get("x-vault-token")).toBe(
      "host-owned-token",
    );
    await expect(secrets.productionReadiness(context)).resolves.toMatchObject({
      id: "secret-provider.production",
      passed: true,
      evidence: expect.not.stringContaining("host-owned-token"),
    });
  });

  it("shares one Kubernetes login across concurrent cold resolves", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prism-vault-test-"));
    const jwtPath = join(directory, "service-account.jwt");
    await writeFile(jwtPath, "kubernetes-jwt\n", "utf8");
    const loginStarted = deferred<void>();
    const releaseLogin = deferred<void>();
    let loginCount = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/kubernetes/login")) {
        loginCount += 1;
        loginStarted.resolve(undefined);
        await releaseLogin.promise;
        expect(init?.body).toBe(
          JSON.stringify({
            role: "prism-runtime",
            jwt: "kubernetes-jwt",
          }),
        );
        return Response.json({
          auth: { client_token: "leased-token", lease_duration: 300 },
        });
      }
      expect(new Headers(init?.headers).get("x-vault-token")).toBe("leased-token");
      return Response.json({
        data: { data: { value: "resolved" }, metadata: { version: 3 } },
      });
    };
    const secrets = new VaultSecretCapability({
      address: "https://vault.example",
      authentication: {
        kind: "kubernetes",
        role: "prism-runtime",
        jwtPath,
      },
      fetch: fetcher,
    });
    try {
      const resolutions = Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          secrets.resolve(context, { provider: "vault", key: `secret-${index}` }),
        ),
      );
      await loginStarted.promise;
      releaseLogin.resolve(undefined);
      await expect(resolutions).resolves.toHaveLength(8);
      await secrets.resolve(context, { provider: "vault", key: "cached" });
      expect(loginCount).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-authenticates once when Vault revokes a cached Kubernetes token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prism-vault-revoked-"));
    const jwtPath = join(directory, "service-account.jwt");
    await writeFile(jwtPath, "kubernetes-jwt\n", "utf8");
    let loginCount = 0;
    const readTokens: string[] = [];
    const secrets = new VaultSecretCapability({
      address: "https://vault.example",
      authentication: {
        kind: "kubernetes",
        role: "prism-runtime",
        jwtPath,
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/kubernetes/login")) {
          loginCount += 1;
          return Response.json({
            auth: {
              client_token: `leased-token-${loginCount}`,
              lease_duration: 300,
            },
          });
        }
        const token = new Headers(init?.headers).get("x-vault-token") ?? "";
        readTokens.push(token);
        if (token === "leased-token-1") return Response.json({}, { status: 403 });
        return Response.json({
          data: { data: { value: "recovered" }, metadata: { version: 4 } },
        });
      },
    });
    try {
      await expect(
        secrets.resolve(context, { provider: "vault", key: "revoked" }),
      ).resolves.toEqual({ value: "recovered", version: "4" });
      expect(loginCount).toBe(2);
      expect(readTokens).toEqual(["leased-token-1", "leased-token-2"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("clears a failed single-flight login so a later resolve can retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prism-vault-login-retry-"));
    const jwtPath = join(directory, "service-account.jwt");
    await writeFile(jwtPath, "kubernetes-jwt\n", "utf8");
    let loginCount = 0;
    const secrets = new VaultSecretCapability({
      address: "https://vault.example",
      authentication: {
        kind: "kubernetes",
        role: "prism-runtime",
        jwtPath,
      },
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/auth/kubernetes/login")) {
          loginCount += 1;
          if (loginCount === 1) return Response.json({}, { status: 503 });
          return Response.json({
            auth: { client_token: "recovered-token", lease_duration: 300 },
          });
        }
        return Response.json({
          data: { data: { value: "resolved" }, metadata: { version: 5 } },
        });
      },
    });
    try {
      const first = await Promise.allSettled(
        Array.from({ length: 4 }, (_, index) =>
          secrets.resolve(context, { provider: "vault", key: `failed-${index}` }),
        ),
      );
      expect(first.every((result) => result.status === "rejected")).toBe(true);
      expect(loginCount).toBe(1);
      await expect(
        secrets.resolve(context, { provider: "vault", key: "retry" }),
      ).resolves.toEqual({ value: "resolved", version: "5" });
      expect(loginCount).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeouts and maps read/login timeouts to Secret diagnostics", async () => {
    const base = {
      address: "https://vault.example",
      authentication: { kind: "token" as const, resolveToken: () => "token" },
    };
    expect(() => new VaultSecretCapability({ ...base, requestTimeoutMs: 0 })).toThrow(
      "VAULT_CONFIGURATION_INVALID",
    );
    expect(
      () => new VaultSecretCapability({ ...base, requestTimeoutMs: Infinity }),
    ).toThrow("VAULT_CONFIGURATION_INVALID");
    expect(() => new VaultSecretCapability({ ...base, maxResponseBytes: 0 })).toThrow(
      "VAULT_CONFIGURATION_INVALID",
    );
    expect(() => new VaultSecretCapability({ ...base, maxResponseBytes: 1.5 })).toThrow(
      "VAULT_CONFIGURATION_INVALID",
    );

    const hangingFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const timedOutRead = new VaultSecretCapability({
      ...base,
      requestTimeoutMs: 5,
      fetch: hangingFetch,
    });
    await expect(
      timedOutRead.resolve(context, { provider: "vault", key: "timeout" }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "SECRET_UNAVAILABLE" }],
    });

    const directory = await mkdtemp(join(tmpdir(), "prism-vault-timeout-"));
    const jwtPath = join(directory, "service-account.jwt");
    await writeFile(jwtPath, "kubernetes-jwt\n", "utf8");
    try {
      const timedOutLogin = new VaultSecretCapability({
        address: "https://vault.example",
        authentication: {
          kind: "kubernetes",
          role: "prism-runtime",
          jwtPath,
        },
        requestTimeoutMs: 5,
        fetch: hangingFetch,
      });
      await expect(
        timedOutLogin.resolve(context, { provider: "vault", key: "timeout" }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: "VAULT_AUTHENTICATION_FAILED" }],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds Vault authentication inputs before headers or network access", async () => {
    const invalidConfigurations = [
      {
        authentication: {
          kind: "kubernetes" as const,
          role: "r".repeat(VAULT_ROLE_MAX_LENGTH + 1),
        },
      },
      {
        authentication: {
          kind: "kubernetes" as const,
          role: "role",
          mount: "m".repeat(VAULT_AUTH_MOUNT_MAX_LENGTH + 1),
        },
      },
      {
        authentication: { kind: "token" as const, resolveToken: () => "token" },
        namespace: "n".repeat(VAULT_NAMESPACE_MAX_LENGTH + 1),
      },
      {
        authentication: {
          kind: "kubernetes" as const,
          role: "role",
          jwtPath: "p".repeat(VAULT_JWT_PATH_MAX_LENGTH + 1),
        },
      },
    ];
    for (const invalid of invalidConfigurations) {
      expect(
        () =>
          new VaultSecretCapability({
            address: "https://vault.example",
            ...invalid,
          }),
      ).toThrow("VAULT_CONFIGURATION_INVALID");
    }

    let hostFetches = 0;
    const oversizedHostToken = new VaultSecretCapability({
      address: "https://vault.example",
      authentication: {
        kind: "token",
        resolveToken: () => `private-${"t".repeat(VAULT_TOKEN_MAX_BYTES)}`,
      },
      fetch: async () => {
        hostFetches += 1;
        return Response.json({});
      },
    });
    const hostFailure = await oversizedHostToken
      .resolve(context, { provider: "vault", key: "host-token" })
      .catch((error: unknown) => error);
    expect(hostFailure).toMatchObject({
      diagnostics: [{ code: "VAULT_AUTHENTICATION_FAILED" }],
    });
    expect(JSON.stringify(hostFailure)).not.toContain("private-");
    expect(hostFetches).toBe(0);

    const directory = await mkdtemp(join(tmpdir(), "prism-vault-auth-bounds-"));
    const oversizedPath = join(directory, "oversized.jwt");
    const boundaryPath = join(directory, "boundary.jwt");
    await writeFile(oversizedPath, "j".repeat(VAULT_KUBERNETES_JWT_MAX_BYTES + 1), "utf8");
    await writeFile(boundaryPath, "j".repeat(VAULT_KUBERNETES_JWT_MAX_BYTES), "utf8");
    try {
      let oversizedFetches = 0;
      const oversizedJwt = new VaultSecretCapability({
        address: "https://vault.example",
        authentication: {
          kind: "kubernetes",
          role: "role",
          jwtPath: oversizedPath,
        },
        fetch: async () => {
          oversizedFetches += 1;
          return Response.json({});
        },
      });
      await expect(
        oversizedJwt.resolve(context, { provider: "vault", key: "oversized" }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: "VAULT_AUTHENTICATION_FAILED" }],
      });
      expect(oversizedFetches).toBe(0);

      let boundaryFetches = 0;
      const boundaryToken = "t".repeat(VAULT_TOKEN_MAX_BYTES);
      const boundaryJwt = new VaultSecretCapability({
        address: "https://vault.example",
        authentication: {
          kind: "kubernetes",
          role: "r".repeat(VAULT_ROLE_MAX_LENGTH),
          mount: "m".repeat(VAULT_AUTH_MOUNT_MAX_LENGTH),
          jwtPath: boundaryPath,
        },
        namespace: "n".repeat(VAULT_NAMESPACE_MAX_LENGTH),
        fetch: async (input, init) => {
          boundaryFetches += 1;
          if (
            String(input).endsWith(
              `/v1/auth/${"m".repeat(VAULT_AUTH_MOUNT_MAX_LENGTH)}/login`,
            )
          ) {
            return Response.json({
              auth: { client_token: boundaryToken, lease_duration: 300 },
            });
          }
          expect(new Headers(init?.headers).get("x-vault-token")).toBe(boundaryToken);
          return Response.json({
            data: { data: { value: "resolved" }, metadata: { version: 1 } },
          });
        },
      });
      await expect(
        boundaryJwt.resolve(context, { provider: "vault", key: "boundary" }),
      ).resolves.toEqual({ value: "resolved", version: "1" });
      expect(boundaryFetches).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed refs before token resolution or Vault fetch", async () => {
    expect(
      () =>
        new VaultSecretCapability({
          address: "https://vault.example",
          providerId: "invalid provider",
          authentication: { kind: "token", resolveToken: () => "token" },
        }),
    ).toThrow("SECRET_REF_INVALID");

    let tokenCalls = 0;
    let fetchCalls = 0;
    const secrets = new VaultSecretCapability({
      address: "https://vault.example",
      authentication: {
        kind: "token",
        resolveToken: () => {
          tokenCalls += 1;
          return "private-vault-token";
        },
      },
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({
          data: { data: { value: "resolved" }, metadata: { version: 1 } },
        });
      },
    });
    const invalid: SecretRef[] = [
      { provider: "invalid provider", key: "valid" },
      { provider: "vault", key: "k".repeat(SECRET_KEY_MAX_LENGTH + 1) },
      { provider: "vault", key: "invalid\u0001key" },
      {
        provider: "vault",
        key: "valid",
        version: "v".repeat(SECRET_VERSION_MAX_LENGTH + 1),
      },
      {
        provider: "vault",
        key: "valid",
        field: "f".repeat(SECRET_FIELD_MAX_LENGTH + 1),
      },
      { provider: "vault", key: 12 as unknown as string },
    ];
    for (const ref of invalid) {
      const failure = await secrets.resolve(context, ref).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        diagnostics: [{ code: "SECRET_REF_INVALID" }],
      });
      expect(JSON.stringify(failure)).not.toContain("private-vault-token");
    }
    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    await expect(
      secrets.resolve(context, { provider: "vault", key: "valid" }),
    ).resolves.toEqual({ value: "resolved", version: "1" });
    expect(tokenCalls).toBe(1);
    expect(fetchCalls).toBe(1);
  });

  it("bounds and structures Vault JSON response decoding", async () => {
    const base = {
      address: "https://vault.example",
      authentication: { kind: "token" as const, resolveToken: () => "token" },
    };
    let bodyAccessCount = 0;
    const declaredOversize = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "9" }),
      get body() {
        bodyAccessCount += 1;
        throw new Error("oversized body must not be accessed");
      },
    } as unknown as Response;
    const declared = new VaultSecretCapability({
      ...base,
      maxResponseBytes: 8,
      fetch: async () => declaredOversize,
    });
    await expect(
      declared.resolve(context, { provider: "vault", key: "declared-oversize" }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "VAULT_RESPONSE_INVALID" }],
    });
    expect(bodyAccessCount).toBe(0);

    let cancelCount = 0;
    const overflowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private-overflow-body"));
      },
      cancel() {
        cancelCount += 1;
      },
    });
    const chunked = new VaultSecretCapability({
      ...base,
      maxResponseBytes: 8,
      fetch: async () => new Response(overflowBody),
    });
    const overflowFailure = await chunked
      .resolve(context, { provider: "vault", key: "chunked-overflow" })
      .catch((error: unknown) => error);
    expect(overflowFailure).toMatchObject({
      diagnostics: [{ code: "VAULT_RESPONSE_INVALID" }],
    });
    expect(JSON.stringify(overflowFailure)).not.toContain("private-overflow-body");
    expect(cancelCount).toBe(1);

    const malformed = new VaultSecretCapability({
      ...base,
      fetch: async () => new Response("private-malformed{"),
    });
    const malformedFailure = await malformed
      .resolve(context, { provider: "vault", key: "malformed" })
      .catch((error: unknown) => error);
    expect(malformedFailure).toMatchObject({
      diagnostics: [{ code: "VAULT_RESPONSE_INVALID" }],
    });
    expect(JSON.stringify(malformedFailure)).not.toContain("private-malformed");

    const truncated = new VaultSecretCapability({
      ...base,
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": "5" },
        }),
    });
    await expect(
      truncated.resolve(context, { provider: "vault", key: "truncated" }),
    ).rejects.toMatchObject({
      diagnostics: [{ code: "VAULT_RESPONSE_INVALID" }],
    });
  });

  it("rejects insecure Vault endpoints and unavailable fields", async () => {
    expect(
      () =>
        new VaultSecretCapability({
          address: "http://vault.example",
          authentication: { kind: "token", resolveToken: () => "token" },
        }),
    ).toThrow("VAULT_TLS_REQUIRED");

    const secrets = new VaultSecretCapability({
      address: "https://vault.example",
      authentication: { kind: "token", resolveToken: () => "token" },
      fetch: async () =>
        Response.json({
          data: { data: { numeric: 12 }, metadata: { version: 1 } },
        }),
    });
    await expect(
      secrets.resolve(context, {
        provider: "vault",
        key: "database",
        field: "numeric",
      }),
    ).rejects.toThrow("SECRET_FIELD_UNAVAILABLE");
  });
});
