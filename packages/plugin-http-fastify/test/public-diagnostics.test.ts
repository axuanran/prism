import type { Diagnostic } from "@prismengine/contracts-data";
import { publicDiagnostics } from "@prismengine/plugin-http-fastify";
import { describe, expect, it } from "vitest";

describe("public HTTP diagnostics", () => {
  it("redacts provider failures without mutating internal diagnostics", () => {
    const internal: Diagnostic = {
      code: "DATABASE_REQUEST_INVALID",
      severity: "error",
      message: "Request failed.",
      details: {
        cause: "postgres://admin:private-password@db.internal/prism",
        error: "private provider error",
        stackTrace: "private stack",
        exception: "private exception",
        nested: { credential: "private credential", safe: "visible" },
      },
    };

    const [projected] = publicDiagnostics([internal]);
    expect(projected).toMatchObject({
      details: {
        cause: "[REDACTED]",
        error: "[REDACTED]",
        stackTrace: "[REDACTED]",
        exception: "[REDACTED]",
        nested: { credential: "[REDACTED]", safe: "visible" },
      },
    });
    expect(internal.details?.cause).toContain("private-password");
    expect(JSON.stringify(projected)).not.toContain("private");
  });

  it("bounds diagnostic count and every public string surface deterministically", () => {
    const longKey = `key-${"k".repeat(200)}`;
    const diagnostics: Diagnostic[] = Array.from({ length: 30 }, (_, index) => ({
      code: index === 0 ? `CODE_${"c".repeat(200)}` : `CODE_${index}`,
      severity: "error",
      message: index === 0 ? "m".repeat(1_000) : `message-${index}`,
      nodeId: index === 0 ? "n".repeat(300) : undefined,
      path: index === 0 ? `/${"p".repeat(500)}` : undefined,
      details:
        index === 0
          ? {
              [longKey]: "s".repeat(1_000),
              items: Array.from({ length: 30 }, (_, value) => value),
              object: Object.fromEntries(
                Array.from({ length: 60 }, (_, value) => [`field-${value}`, value]),
              ),
            }
          : undefined,
    }));

    const projected = publicDiagnostics(diagnostics);
    expect(projected).toHaveLength(25);
    expect(projected.at(-1)).toEqual({
      code: "HTTP_DIAGNOSTICS_TRUNCATED",
      severity: "warning",
      message: "Additional diagnostics were omitted.",
    });
    const first = projected[0]!;
    expect(first.code.length).toBeLessThanOrEqual(128);
    expect(first.message.length).toBeLessThanOrEqual(512);
    expect(first.nodeId?.length).toBeLessThanOrEqual(128);
    expect(first.path?.length).toBeLessThanOrEqual(256);
    expect(first.code.endsWith("[TRUNCATED]")).toBe(true);
    expect(first.message.endsWith("[TRUNCATED]")).toBe(true);
    const details = first.details as Record<string, unknown>;
    const projectedLongKey = Object.keys(details).find((key) => key.startsWith("key-"));
    expect(projectedLongKey?.length).toBeLessThanOrEqual(128);
    expect(projectedLongKey?.endsWith("[TRUNCATED]")).toBe(true);
    expect((details[projectedLongKey!] as string).length).toBeLessThanOrEqual(512);
    expect(details.items).toHaveLength(25);
    expect((details.items as unknown[]).at(-1)).toBe("[TRUNCATED]");
    expect(Object.keys(details.object as object)).toHaveLength(50);
    expect((details.object as Record<string, unknown>)["[TRUNCATED]"]).toBe(true);
  });
});
