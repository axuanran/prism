import * as arrow from "apache-arrow";
import { describe, expect, it, vi } from "vitest";
import {
  ArrowDiagnosticCode,
  D,
  defineSemanticAnnotationContract,
  semanticAnnotation,
  PrismError,
  collectRows,
  countRows,
  datasetFromRows,
  fromArrowSchema,
  systemCallContext,
  tableType,
  toArrowSchema,
  type Dataset,
  type Row,
  type TableType,
} from "@prismengine/contracts-data";

function capturedPrismError(run: () => unknown): PrismError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PrismError);
    return error as PrismError;
  }
  throw new Error("Expected a structured PrismError.");
}

const ALL_ANNOTATIONS = {
  currency: "CNY",
  unit: "points",
  grain: "person-month",
  key: false,
  semantic: "prism.test",
} as const;

const TEST_ANNOTATION = defineSemanticAnnotationContract<{
  readonly label: string;
}>({
  id: "test.semantic",
  version: "1.0.0",
});

describe("Arrow schema mapping", () => {
  it("round-trips every representable ValueKind and all annotations", () => {
    const schema: TableType = {
      kind: "table",
      nullable: false,
      annotations: { grain: "batch" },
      semanticAnnotations: [
        semanticAnnotation(TEST_ANNOTATION, { label: "table" }),
      ],
      columns: [
        { name: "nothing", type: { kind: "null", nullable: true, annotations: ALL_ANNOTATIONS } },
        {
          name: "enabled",
          type: { kind: "boolean", nullable: false, annotations: ALL_ANNOTATIONS },
        },
        { name: "sequence", type: { kind: "int", annotations: ALL_ANNOTATIONS } },
        {
          name: "amount",
          type: {
            kind: "decimal",
            precision: 28,
            scale: 2,
            annotations: ALL_ANNOTATIONS,
            semanticAnnotations: [
              semanticAnnotation(TEST_ANNOTATION, { label: "amount" }),
            ],
          },
        },
        { name: "label", type: { kind: "string", annotations: ALL_ANNOTATIONS } },
        { name: "day", type: { kind: "date", annotations: ALL_ANNOTATIONS } },
        { name: "instant", type: { kind: "datetime", annotations: ALL_ANNOTATIONS } },
      ],
    };

    const physical = toArrowSchema(schema);
    expect(fromArrowSchema(physical)).toEqual(schema);
    expect(physical.fields[2]?.type).toBeInstanceOf(arrow.Int64);
    expect(physical.fields[3]?.type).toMatchObject({ precision: 28, scale: 2, bitWidth: 128 });
    expect(physical.fields[5]?.type).toBeInstanceOf(arrow.DateDay);
    expect(physical.fields[6]?.type).toMatchObject({
      unit: arrow.TimeUnit.MILLISECOND,
      timezone: "UTC",
    });
  });

  it.each([
    {
      kind: "object" as const,
      fields: [{ name: "nested", type: { kind: "string" as const } }],
    },
    {
      kind: "table" as const,
      columns: [{ name: "nested", type: { kind: "string" as const } }],
    },
  ])("rejects a $kind column with a diagnostic", (unsupportedType) => {
    const error = capturedPrismError(() => toArrowSchema(tableType([
      { name: "unsupported", type: unsupportedType },
    ])));

    expect(error.diagnostics).toEqual([
      expect.objectContaining({
        code: ArrowDiagnosticCode.TYPE_NOT_REPRESENTABLE,
        path: "/columns/0/type",
      }),
    ]);
  });
});

describe("Arrow decimal batches", () => {
  const decimalSchema = tableType([
    { name: "amount", type: { kind: "decimal", precision: 28, scale: 2 } },
  ]);

  it("preserves decimal(28,2) values through rows, Decimal128, and rows bit-exact", async () => {
    const input = [
      new D("12345678901234567890123456.78"),
      new D("0.01"),
      new D("-999999999999999999999999.99"),
    ];
    const dataset = datasetFromRows(
      "money",
      decimalSchema,
      input.map((amount) => ({ amount })),
    );
    const context = systemCallContext();
    const iterator = dataset.stream(context)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done === true) throw new Error("Expected one Arrow batch.");

    const vector = first.value.getColumn("amount");
    expect(vector?.type).toMatchObject({ precision: 28, scale: 2, bitWidth: 128 });
    const physical = vector?.get(0);
    expect(physical).toBeInstanceOf(Uint32Array);
    expect(
      arrow.util.bigNumToString(arrow.util.BN.decimal(physical as Uint32Array)),
    ).toBe("1234567890123456789012345678");

    const output = await collectRows(dataset, context);
    expect(output.map((row) => row.amount instanceof D ? row.amount.toFixed(2) : null)).toEqual([
      "12345678901234567890123456.78",
      "0.01",
      "-999999999999999999999999.99",
    ]);
  });

  it("reports rescaling that would lose digits instead of truncating", () => {
    const error = capturedPrismError(() => datasetFromRows(
      "lossy",
      decimalSchema,
      [{ amount: new D("1.001") }],
    ));

    expect(error.diagnostics).toEqual([
      expect.objectContaining({
        code: ArrowDiagnosticCode.DECIMAL_RESCALE_LOSS,
        path: "/rows/0/amount",
      }),
    ]);
  });
});

describe("columnar dataset behavior", () => {
  const schema = tableType([{ name: "value", type: { kind: "int" } }]);
  const rows: readonly Row[] = [{ value: 1 }, { value: 2 }, { value: 3 }];

  it("countRows uses batch row counts without materializing columns", async () => {
    const context = systemCallContext();
    const source = datasetFromRows("source", schema, rows);
    const iterator = source.stream(context)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done === true) throw new Error("Expected one Arrow batch.");
    const getColumn = vi.spyOn(first.value, "getColumn").mockImplementation(() => {
      throw new Error("row materialization must not occur");
    });
    const countOnly: Dataset = {
      name: "count-only",
      schema,
      async *stream() {
        yield first.value;
      },
    };

    await expect(countRows(countOnly, context)).resolves.toBe(3);
    expect(getColumn).not.toHaveBeenCalled();
  });

  it("stops streaming between Arrow batches when cancelled", async () => {
    const controller = new AbortController();
    const context = systemCallContext({ signal: controller.signal });
    const dataset = datasetFromRows("cancel", schema, rows, 1);
    const iterator = dataset.stream(context)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
  });
});
