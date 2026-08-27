import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  GrainCapabilityToken,
  PRISM_PLATFORM_VERSION,
  QuantityCapabilityToken,
  createEngine,
  definePlugin,
  prismPlatform,
} from "@prismengine/platform";

const consumer = definePlugin({
  id: "platform-analysis-consumer",
  version: "0.1.0",
  requires: {
    quantity: QuantityCapabilityToken,
    grain: GrainCapabilityToken,
  },
  start(context) {
    // Platform defaults provide them, but the consumer still declares the
    // dependency edges explicitly and receives typed capabilities.
    context.dependencies.quantity.normalize({ numerator: [], denominator: [] });
    context.dependencies.grain.normalize({ dimensions: [], uniqueBy: [] });
  },
});

describe("Prism platform distribution", () => {
  it("composes memory storage, calculation, Quantity and Grain by default", async () => {
    const plugins = prismPlatform({ additionalPlugins: [consumer] });
    expect(plugins.map((plugin) => plugin.id)).toEqual([
      "storage.memory",
      "calculation.memory",
      "type.quantity",
      "dataset.grain",
      "platform-analysis-consumer",
    ]);

    const engine = createEngine({ plugins });
    await expect(engine.start()).resolves.toBeUndefined();
    expect(engine.inspect().capabilities.map((capability) => capability.id)).toEqual(
      expect.arrayContaining(["storage", "calculation", "type.quantity", "dataset.grain"]),
    );
    await engine.stop();
  });

  it("does not hide missing dependency edges when defaults are disabled", async () => {
    const engine = createEngine({
      plugins: prismPlatform({
        quantity: false,
        grain: false,
        additionalPlugins: [consumer],
      }),
    });
    await expect(engine.start()).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CAPABILITY_MISSING" }),
      ]),
    });
  });

  it("pins compatible public package versions instead of workspace ranges", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      readonly version: string;
      readonly dependencies: Readonly<Record<string, string>>;
    };

    expect(manifest.version).toBe(PRISM_PLATFORM_VERSION);
    expect(Object.keys(manifest.dependencies).length).toBeGreaterThan(0);
    expect(
      Object.values(manifest.dependencies).every(
        (version) => version === `workspace:${manifest.version}`,
      ),
    ).toBe(true);
  });
});
