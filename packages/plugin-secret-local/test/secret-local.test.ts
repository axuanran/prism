import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SECRET_FIELD_MAX_LENGTH,
  SECRET_KEY_MAX_LENGTH,
  SECRET_VERSION_MAX_LENGTH,
  SecretCapabilityToken,
  type SecretRef,
} from "@prismengine/contracts-secret";
import { systemCallContext } from "@prismengine/contracts-data";
import { createEngine } from "@prismengine/kernel";
import {
  LOCAL_SECRET_DEFAULT_MAX_BYTES,
  LOCAL_SECRET_ENVIRONMENT_NAME_MAX_LENGTH,
  LOCAL_SECRET_FILE_PATH_MAX_LENGTH,
  localSecretPlugin,
} from "@prismengine/plugin-secret-local";
import { describe, expect, it } from "vitest";

const context = systemCallContext({ correlationId: "secret-local-test" });

describe("Local Secret provider", () => {
  it("resolves only allowlisted environment and file refs without exposing values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prism-secret-test-"));
    const path = join(directory, "database-password");
    const environmentKey = `PRISM_TEST_SECRET_${Date.now()}`;
    process.env[environmentKey] = "environment-value";
    await writeFile(path, "file-value\n", "utf8");
    const engine = createEngine({
      plugins: [
        localSecretPlugin({
          environment: { database: environmentKey },
          files: { signing: path },
        }),
      ],
    });
    try {
      await engine.start();
      const secrets = engine.capability(SecretCapabilityToken);
      expect(secrets.profile()).toEqual({
        providerId: "local",
        durability: "development",
        external: false,
      });
      await expect(
        secrets.resolve(context, {
          provider: "local",
          key: "database",
        }),
      ).resolves.toEqual({ value: "environment-value" });
      await expect(
        secrets.resolve(context, {
          provider: "local",
          key: "signing",
          version: "rotation-2",
        }),
      ).resolves.toEqual({ value: "file-value", version: "rotation-2" });
      let error: unknown;
      try {
        await secrets.resolve(context, { provider: "local", key: "missing" });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).not.toContain("environment-value");
      expect(String(error)).not.toContain("file-value");
    } finally {
      delete process.env[environmentKey];
      await engine.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed refs and configuration before provider access", async () => {
    expect(() => localSecretPlugin({ providerId: "invalid provider" })).toThrow(
      "SECRET_REF_INVALID",
    );
    expect(() =>
      localSecretPlugin({
        environment: { [`k${"\u0001"}`]: "PRIVATE_ENV" },
      }),
    ).toThrow("SECRET_REF_INVALID");
    expect(() => localSecretPlugin({ maxFileBytes: 0 })).toThrow(
      "SECRET_CONFIGURATION_INVALID",
    );

    const environmentKey = `PRISM_TEST_SECRET_INVALID_${Date.now()}`;
    process.env[environmentKey] = "private-environment-value";
    const engine = createEngine({
      plugins: [
        localSecretPlugin({
          environment: { valid: environmentKey },
        }),
      ],
    });
    try {
      await engine.start();
      const secrets = engine.capability(SecretCapabilityToken);
      const invalid: SecretRef[] = [
        { provider: "invalid provider", key: "valid" },
        { provider: "local", key: "k".repeat(SECRET_KEY_MAX_LENGTH + 1) },
        { provider: "local", key: "invalid\u0001key" },
        {
          provider: "local",
          key: "valid",
          version: "v".repeat(SECRET_VERSION_MAX_LENGTH + 1),
        },
        {
          provider: "local",
          key: "valid",
          field: "f".repeat(SECRET_FIELD_MAX_LENGTH + 1),
        },
        { provider: "local", key: 12 as unknown as string },
      ];
      for (const ref of invalid) {
        const failure = await secrets
          .resolve(context, ref)
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({
          diagnostics: [{ code: "SECRET_REF_INVALID" }],
        });
        expect(JSON.stringify(failure)).not.toContain("private-environment-value");
      }
      await expect(
        secrets.resolve(context, { provider: "local", key: "valid" }),
      ).resolves.toEqual({ value: "private-environment-value" });
    } finally {
      delete process.env[environmentKey];
      await engine.stop();
    }
  });

  it("bounds environment and file values with strict allowlist configuration", async () => {
    expect(() => localSecretPlugin({ environment: { secret: "INVALID-NAME" } })).toThrow(
      "SECRET_CONFIGURATION_INVALID",
    );
    expect(() =>
      localSecretPlugin({
        environment: {
          secret: `A${"A".repeat(LOCAL_SECRET_ENVIRONMENT_NAME_MAX_LENGTH)}`,
        },
      }),
    ).toThrow("SECRET_CONFIGURATION_INVALID");
    expect(() => localSecretPlugin({ files: { secret: "relative.secret" } })).toThrow(
      "SECRET_CONFIGURATION_INVALID",
    );
    expect(() =>
      localSecretPlugin({
        files: {
          secret: `${join(tmpdir(), "p".repeat(LOCAL_SECRET_FILE_PATH_MAX_LENGTH))}`,
        },
      }),
    ).toThrow("SECRET_CONFIGURATION_INVALID");
    expect(() => localSecretPlugin({ maxValueBytes: 0 })).toThrow(
      "SECRET_CONFIGURATION_INVALID",
    );

    const directory = await mkdtemp(join(tmpdir(), "prism-secret-bounds-"));
    const oversizedPath = join(directory, "oversized");
    const boundaryPath = join(directory, "boundary");
    const invalidUtf8Path = join(directory, "invalid-utf8");
    const oversizedEnvironment = `PRISM_TEST_SECRET_OVERSIZED_${Date.now()}`;
    const boundaryEnvironment = `PRISM_TEST_SECRET_BOUNDARY_${Date.now()}`;
    process.env[oversizedEnvironment] = `private-${"e".repeat(
      LOCAL_SECRET_DEFAULT_MAX_BYTES,
    )}`;
    process.env[boundaryEnvironment] = "e".repeat(LOCAL_SECRET_DEFAULT_MAX_BYTES);
    await writeFile(oversizedPath, "f".repeat(LOCAL_SECRET_DEFAULT_MAX_BYTES + 1));
    await writeFile(boundaryPath, "f".repeat(LOCAL_SECRET_DEFAULT_MAX_BYTES));
    await writeFile(invalidUtf8Path, Uint8Array.from([0xff, 0xfe]));
    const engine = createEngine({
      plugins: [
        localSecretPlugin({
          environment: {
            oversizedEnvironment,
            boundaryEnvironment,
          },
          files: {
            oversizedFile: oversizedPath,
            boundaryFile: boundaryPath,
            invalidUtf8: invalidUtf8Path,
          },
        }),
      ],
    });
    try {
      await engine.start();
      const secrets = engine.capability(SecretCapabilityToken);
      const environmentFailure = await secrets
        .resolve(context, { provider: "local", key: "oversizedEnvironment" })
        .catch((error: unknown) => error);
      expect(environmentFailure).toMatchObject({
        diagnostics: [{ code: "SECRET_VALUE_INVALID" }],
      });
      expect(JSON.stringify(environmentFailure)).not.toContain("private-");
      await expect(
        secrets.resolve(context, { provider: "local", key: "oversizedFile" }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: "SECRET_FILE_INVALID" }],
      });
      await expect(
        secrets.resolve(context, { provider: "local", key: "invalidUtf8" }),
      ).rejects.toMatchObject({
        diagnostics: [{ code: "SECRET_FILE_INVALID" }],
      });
      const boundaryEnvironmentValue = await secrets.resolve(context, {
        provider: "local",
        key: "boundaryEnvironment",
      });
      expect(Buffer.byteLength(boundaryEnvironmentValue.value, "utf8")).toBe(
        LOCAL_SECRET_DEFAULT_MAX_BYTES,
      );
      const boundaryFileValue = await secrets.resolve(context, {
        provider: "local",
        key: "boundaryFile",
      });
      expect(Buffer.byteLength(boundaryFileValue.value, "utf8")).toBe(
        LOCAL_SECRET_DEFAULT_MAX_BYTES,
      );
    } finally {
      delete process.env[oversizedEnvironment];
      delete process.env[boundaryEnvironment];
      await engine.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
