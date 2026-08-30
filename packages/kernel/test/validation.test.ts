import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { validateAgainstSchema, validateResourceSpec } from "@prismengine/kernel";
import type { ResourceTypeDefinition, ValidationContext } from "@prismengine/kernel";

const context: ValidationContext = {
  resolveResource: async () => null,
};

const schema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    points: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const definition: ResourceTypeDefinition = {
  kind: "test.metric",
  title: "测试指标",
  config: {
    schema,
    validate: (spec) => {
      const value = spec as { name: string };
      return value.name === "reserved"
        ? {
            valid: false,
            diagnostics: [
              {
                code: "NAME_RESERVED",
                severity: "error",
                message: "该名称已被保留。",
                path: "/name",
              },
            ],
          }
        : { valid: true, diagnostics: [] };
    },
  },
  exposure: { configuration: true },
};

describe("resource validation", () => {
  it("reports the offending path for a shape violation", () => {
    const diagnostics = validateAgainstSchema(schema, { name: "", points: 1 });

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.code).toBe("RESOURCE_SCHEMA_VIOLATION");
    expect(diagnostics.some((d) => d.path === "/name")).toBe(true);
  });

  it("rejects unknown properties so a typo is not silently stored", () => {
    const diagnostics = validateAgainstSchema(schema, {
      name: "ok",
      points: 1,
      pointz: 2,
    });

    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("skips semantic validation when the shape is already wrong", async () => {
    const result = await validateResourceSpec(definition, { name: "reserved" }, context);

    expect(result.valid).toBe(false);
    // `points` is missing, so the reserved-name rule must not even run.
    expect(result.diagnostics.every((d) => d.code === "RESOURCE_SCHEMA_VIOLATION")).toBe(
      true,
    );
  });

  it("runs semantic validation once the shape is valid", async () => {
    const result = await validateResourceSpec(
      definition,
      { name: "reserved", points: 3 },
      context,
    );

    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("NAME_RESERVED");
  });

  it("accepts a spec that satisfies both layers", async () => {
    const result = await validateResourceSpec(
      definition,
      { name: "门诊工作量", points: 10 },
      context,
    );

    expect(result).toEqual({ valid: true, diagnostics: [] });
  });
});

describe("schema formats", () => {
  // Regression: TypeBox treats an UNREGISTERED format as a failure rather
  // than ignoring it, so before formats were registered centrally every
  // schema using `format: "date"` rejected all input with "Unknown format".
  const dated = Type.Object({
    effectiveFrom: Type.String({ format: "date" }),
    createdAt: Type.Optional(Type.String({ format: "date-time" })),
  });

  it("accepts a valid ISO date", () => {
    expect(validateAgainstSchema(dated, { effectiveFrom: "2026-03-31" })).toEqual([]);
  });

  it("accepts a valid ISO date-time", () => {
    expect(
      validateAgainstSchema(dated, {
        effectiveFrom: "2026-03-31",
        createdAt: "2026-03-31T08:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("still rejects a malformed date", () => {
    const diagnostics = validateAgainstSchema(dated, { effectiveFrom: "31/03/2026" });

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.path).toBe("/effectiveFrom");
  });

  it("rejects an impossible calendar date", () => {
    expect(
      validateAgainstSchema(dated, { effectiveFrom: "2026-02-30" }).length,
    ).toBeGreaterThan(0);
  });
});
