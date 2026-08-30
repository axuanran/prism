import { describe, expect, it } from "vitest";
import { defineCapability, definePlugin } from "@prismengine/kernel";
import type { CapabilityToken } from "@prismengine/kernel";

/**
 * Compile-time architecture properties (P2-P4).
 *
 * These assertions are enforced by `pnpm typecheck`, which includes this file.
 * A `@ts-expect-error` that stops erroring fails the build - that is the point:
 * the guarantee is the type system, not a convention in a document.
 */

interface Alpha {
  alpha(): string;
}

interface Beta {
  beta(): number;
}

const AlphaCapability = defineCapability<Alpha>({ id: "test.alpha", version: "1.0.0" });
const BetaCapability = defineCapability<Beta>({ id: "test.beta", version: "1.0.0" });
const GammaCapability = defineCapability<Alpha>({ id: "test.gamma", version: "1.0.0" });

describe("capability typing", () => {
  it("P3: a token of one service type is not assignable to another", () => {
    const alphaSlot: CapabilityToken<Alpha> = AlphaCapability;

    // @ts-expect-error different service type must not bind
    const wrong: CapabilityToken<Alpha> = BetaCapability;

    // Same service type, different id: structurally fine, and that is correct.
    const sameShape: CapabilityToken<Alpha> = GammaCapability;

    expect(alphaSlot.id).toBe("test.alpha");
    expect(sameShape.id).toBe("test.gamma");
    expect(wrong.id).toBe("test.beta");
  });

  it("P2/P4: dependencies are typed from `requires`, optional ones widen", () => {
    let observed: { alpha: string; beta: number | undefined } | undefined;

    const plugin = definePlugin({
      id: "test.consumer",
      version: "0.1.0",
      engineRange: "^0.1.20",
      requires: {
        alpha: AlphaCapability,
        beta: { token: BetaCapability, optional: true },
      },
      register(ctx) {
        // P2: required dependency is the concrete service type.
        const alpha: Alpha = ctx.dependencies.alpha;

        // P4: optional dependency is `Beta | undefined` and must be narrowed.
        // @ts-expect-error optional dependency is possibly undefined
        const unchecked: Beta = ctx.dependencies.beta;

        // @ts-expect-error undeclared dependency does not exist on the object
        const missing = ctx.dependencies.gamma;

        observed = { alpha: alpha.alpha(), beta: ctx.dependencies.beta?.beta() };
        void unchecked;
        void missing;
      },
    });

    expect(plugin.id).toBe("test.consumer");
    expect(observed).toBeUndefined();
  });

  it("rejects providing a capability whose service type does not match", () => {
    definePlugin({
      id: "test.provider",
      version: "0.1.0",
      engineRange: "^0.1.20",
      provides: [AlphaCapability],
      register(ctx) {
        ctx.provide(AlphaCapability, { alpha: () => "ok" });

        // @ts-expect-error implementation does not satisfy the token's contract
        ctx.provide(AlphaCapability, { beta: () => 1 });
      },
    });

    expect(true).toBe(true);
  });
});
