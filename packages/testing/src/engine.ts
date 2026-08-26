import { PrismError } from "@prismengine/contracts-data";
import {
  createEngine,
  type AnyPluginDefinition,
  type Engine,
  type EngineOptions,
} from "@prismengine/kernel";

export type TestEngineOptions = Omit<EngineOptions, "plugins">;

export interface TestEngine {
  readonly engine: Engine;
  dispose(): Promise<void>;
}

/** Boots the supplied plugin graph and returns an explicit lifecycle handle. */
export async function createTestEngine(
  plugins: readonly AnyPluginDefinition[],
  options: TestEngineOptions = {},
): Promise<TestEngine> {
  const engine = createEngine({ ...options, plugins });
  await engine.start();
  return {
    engine,
    dispose: () => engine.stop(),
  };
}

/** Runs a body against a started engine and always stops it afterward. */
export async function withEngine<TResult>(
  plugins: readonly AnyPluginDefinition[],
  body: (engine: Engine) => TResult | Promise<TResult>,
): Promise<TResult> {
  const harness = await createTestEngine(plugins);
  try {
    return await body(harness.engine);
  } finally {
    await harness.dispose();
  }
}

/** Returns diagnostic codes only when the operation rejects with PrismError. */
export async function diagnosticCodesFrom(
  operation: () => unknown | Promise<unknown>,
): Promise<readonly string[]> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof PrismError)) throw error;
    return error.diagnostics.map((item) => item.code);
  }
  throw new Error("Expected operation to throw a PrismError.");
}
