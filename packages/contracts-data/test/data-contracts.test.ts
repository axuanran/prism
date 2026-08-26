import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUNDING,
  DataDiagnosticCode,
  D,
  MONEY_TYPE,
  RATIO_TYPE,
  decimalType,
  canonicalSemanticAnnotations,
  defineSemanticAnnotationContract,
  findSemanticAnnotation,
  formatValueType,
  isValidDecimalType,
  collectRows,
  countRows,
  datasetFromRows,
  decimalToJson,
  isSameRunPin,
  PrismError,
  semanticAnnotation,
  roundDecimal,
  systemCallContext,
  tableType,
} from "@prism/contracts-data";
import type { RunPin } from "@prism/contracts-data";

const schema = tableType([
  { name: "personId", type: { kind: "string", annotations: { key: true } } },
  { name: "amount", type: MONEY_TYPE },
]);

describe("decimal semantics", () => {
  it("does not lose cents the way binary floating point does", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(new D("0.1").plus("0.2").equals("0.3")).toBe(true);
  });

  it("rounds half-up at the configured scale", () => {
    expect(decimalToJson(roundDecimal(new D("1.005"), DEFAULT_ROUNDING))).toBe("1.01");
    expect(decimalToJson(roundDecimal(new D("-1.005"), DEFAULT_ROUNDING))).toBe("-1.01");
    expect(
      decimalToJson(roundDecimal(new D("2.675"), { scale: 2, mode: "half-even" })),
    ).toBe("2.68");
  });

  it("serializes without exponent notation", () => {
    expect(decimalToJson(new D("1e-8"))).toBe("0.00000001");
    expect(decimalToJson(new D("12345678901234567890"))).toBe("12345678901234567890");
  });
});

describe("decimal column typing", () => {
  // Arrow and DataFusion model decimals as Decimal128(p, s) at the COLUMN
  // level. A scale only known once a row arrives cannot cross that boundary,
  // so the schema must pin both numbers.
  it("accepts a representable precision and scale", () => {
    expect(isValidDecimalType(decimalType(28, 2))).toBe(true);
    expect(isValidDecimalType(decimalType(1, 0))).toBe(true);
    expect(isValidDecimalType(decimalType(38, 38))).toBe(true);
  });

  it("rejects a precision Decimal128 cannot hold", () => {
    expect(isValidDecimalType(decimalType(39, 2))).toBe(false);
    expect(isValidDecimalType(decimalType(0, 0))).toBe(false);
  });

  it("rejects a scale wider than its precision", () => {
    expect(isValidDecimalType(decimalType(4, 5))).toBe(false);
    expect(isValidDecimalType(decimalType(4, -1))).toBe(false);
  });

  it("rejects fractional precision or scale", () => {
    expect(isValidDecimalType(decimalType(10.5, 2))).toBe(false);
    expect(isValidDecimalType(decimalType(10, 1.5))).toBe(false);
  });

  it("formats a decimal type with both numbers, never just one", () => {
    expect(formatValueType(MONEY_TYPE)).toBe("decimal(28,2)");
    expect(formatValueType(RATIO_TYPE)).toBe("decimal(28,6)");
  });
});

describe("semantic annotations", () => {
  const Alpha = defineSemanticAnnotationContract<{ readonly value: string }>({
    id: "test.alpha",
    version: "1.0.0",
  });
  const Beta = defineSemanticAnnotationContract<{ readonly enabled: boolean }>({
    id: "test.beta",
    version: "2.0.0",
  });

  it("canonicalizes by contract for deterministic JSON and hashing", () => {
    const annotations = canonicalSemanticAnnotations([
      semanticAnnotation(Beta, { enabled: true }),
      semanticAnnotation(Alpha, { value: "x" }),
    ]);
    expect(annotations.map((annotation) => annotation.contract)).toEqual([
      "test.alpha",
      "test.beta",
    ]);
    expect(JSON.parse(JSON.stringify(annotations))).toEqual(annotations);
  });

  it("rejects duplicate contracts instead of letting order choose meaning", () => {
    expect(() =>
      canonicalSemanticAnnotations([
        semanticAnnotation(Alpha, { value: "first" }),
        semanticAnnotation(Alpha, { value: "second" }),
      ]),
    ).toThrow(PrismError);
  });

  it("rejects reading an annotation through another contract version", () => {
    const AlphaV2 = defineSemanticAnnotationContract<{ readonly value: string }>({
      id: Alpha.id,
      version: "2.0.0",
    });
    try {
      findSemanticAnnotation(
        [semanticAnnotation(Alpha, { value: "x" })],
        AlphaV2,
      );
      throw new Error("expected version mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(PrismError);
      expect((error as PrismError).diagnostics[0]?.code).toBe(
        DataDiagnosticCode.SEMANTIC_ANNOTATION_VERSION_MISMATCH,
      );
    }
  });
});

describe("dataset contract", () => {
  const rows = Array.from({ length: 2500 }, (_, index) => ({
    personId: `p${index}`,
    amount: new D(index),
  }));

  it("streams in batches instead of one call per row", async () => {
    const context = systemCallContext();
    const dataset = datasetFromRows("workload", schema, rows, 1000);

    const batchSizes: number[] = [];
    for await (const batch of dataset.stream(context)) batchSizes.push(batch.numRows);

    expect(batchSizes).toEqual([1000, 1000, 500]);
    expect(await countRows(dataset, context)).toBe(2500);
  });

  it("is re-iterable: two streams yield identical data", async () => {
    const context = systemCallContext();
    const dataset = datasetFromRows("workload", schema, rows, 512);

    const first = await collectRows(dataset, context);
    const second = await collectRows(dataset, context);

    expect(first).toHaveLength(second.length);
    expect(first[0]).toEqual(second[0]);
    expect(first.at(-1)).toEqual(second.at(-1));
  });

  it("honours cancellation between batches", async () => {
    const controller = new AbortController();
    const context = systemCallContext({ signal: controller.signal });
    const dataset = datasetFromRows("workload", schema, rows, 500);

    const iterator = dataset.stream(context)[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();

    await expect(iterator.next()).rejects.toThrow();
  });
});

describe("run pin", () => {
  const pin: RunPin = {
    definition: { kind: "performance.scheme", id: "scheme-1", revision: 3 },
    definitionFingerprint: "sha256:definition",
    input: {
      ref: { fingerprint: "sha256:aaa", capturedAt: "2026-03-01T00:00:00.000Z" },
      datasets: [{ name: "workload", fingerprint: "sha256:w1", rowCount: 3 }],
      parameters: [{ name: "pointValue", fingerprint: "sha256:p1" }],
    },
    effective: {
      validAt: "2026-03-31",
      knownAs: { fingerprint: "sha256:aaa", capturedAt: "2026-03-01T00:00:00.000Z" },
    },
    versions: {
      engine: "0.1.0",
      operations: { formula: "1.0.0" },
      backend: { id: "memory", version: "0.1.0" },
      components: {},
    },
    planHash: "sha256:plan1",
  };

  it("treats identical pins as replayable", () => {
    expect(isSameRunPin(pin, { ...pin })).toBe(true);
  });

  it("detects a changed definition revision", () => {
    const republished: RunPin = {
      ...pin,
      definition: { ...pin.definition, revision: 4 },
    };
    expect(isSameRunPin(pin, republished)).toBe(false);
  });

  it("detects corrected input data behind the same effective date", () => {
    // The March payout re-run in June: same validAt, different transaction time.
    const corrected: RunPin = {
      ...pin,
      input: {
        ...pin.input,
        ref: { fingerprint: "sha256:bbb", capturedAt: "2026-06-01T00:00:00.000Z" },
      },
    };
    expect(isSameRunPin(pin, corrected)).toBe(false);
  });

  it("treats the same inputs on a different backend as a different run", () => {
    // A backend swap is the one code change the seam exists to allow, and it
    // can change results. A pin that ignored it would claim a reproducibility
    // it cannot deliver.
    const onDataFusion: RunPin = {
      ...pin,
      versions: { ...pin.versions, backend: { id: "datafusion", version: "0.1.0" } },
    };
    expect(isSameRunPin(pin, onDataFusion)).toBe(false);

    const upgraded: RunPin = {
      ...pin,
      versions: { ...pin.versions, backend: { id: "memory", version: "0.2.0" } },
    };
    expect(isSameRunPin(pin, upgraded)).toBe(false);
  });

  it("detects an operator patch behind an identical plan hash", () => {
    const patched: RunPin = {
      ...pin,
      versions: { ...pin.versions, operations: { formula: "1.0.1" } },
    };
    expect(isSameRunPin(pin, patched)).toBe(false);
  });
});
