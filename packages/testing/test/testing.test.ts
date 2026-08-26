import {
  D,
  collectRows,
  decimalToJson,
  PrismError,
} from "@prismengine/contracts-data";
import { definePlugin } from "@prismengine/kernel";
import {
  diagnosticCodesFrom,
  withEngine,
} from "../src/engine.js";
import {
  decimalColumn,
  testCallContext,
  testDataset,
} from "../src/fixtures.js";
import { describe, expect, it } from "vitest";

describe("engine test harness", () => {
  it("stops the engine when the test body throws", async () => {
    const events: string[] = [];
    const plugin = definePlugin({
      id: "testing.lifecycle",
      version: "0.1.0",
      start: () => void events.push("start"),
      stop: () => void events.push("stop"),
    });
    const failure = new Error("body failed");

    await expect(withEngine([plugin], () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(events).toEqual(["start", "stop"]);
  });

  it("collects codes from a thrown PrismError", async () => {
    await expect(diagnosticCodesFrom(() => {
      throw PrismError.of("TEST_FAILURE", "Expected test failure.");
    })).resolves.toEqual(["TEST_FAILURE"]);
  });
});

describe("deterministic fixtures", () => {
  it("creates the same call context on every call", () => {
    const first = testCallContext();
    const second = testCallContext();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      principal: {
        id: "test-principal",
        displayName: "Test Principal",
        roles: ["test"],
      },
      asOf: { validAt: "2025-01-15" },
      correlationId: "prism-test",
    });
  });

  it("round-trips rows through a dataset fixture", async () => {
    const dataset = testDataset(
      "payments",
      [
        { name: "person", type: { kind: "string" } },
        decimalColumn("amount", { precision: 28, scale: 2 }),
      ],
      [
        { person: "张三", amount: new D("12.34") },
        { person: "李四", amount: new D("56.78") },
      ],
    );

    const rows = await collectRows(dataset, testCallContext());

    expect(dataset.schema.columns[1]?.type).toEqual({
      kind: "decimal",
      precision: 28,
      scale: 2,
    });
    expect(rows.map((row) => ({
      person: row.person,
      amount: decimalToJson(row.amount as InstanceType<typeof D>),
    }))).toEqual([
      { person: "张三", amount: "12.34" },
      { person: "李四", amount: "56.78" },
    ]);
  });
});
