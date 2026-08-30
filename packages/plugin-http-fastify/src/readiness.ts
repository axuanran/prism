import type {
  ProductionReadinessCheck,
  ProductionReadinessResult,
} from "./configuration.js";

export interface ProductionReadinessProbe {
  readonly id: string;
  run(): Promise<ProductionReadinessCheck>;
}

/** Combines live deployment probes while preserving a stable failed check id. */
export function composeProductionReadiness(
  probes: readonly ProductionReadinessProbe[],
): () => Promise<ProductionReadinessResult> {
  const ids = new Set<string>();
  for (const probe of probes) {
    if (!probe.id.trim() || ids.has(probe.id)) {
      throw new Error(
        `Production readiness probe id is invalid or duplicated: ${probe.id}`,
      );
    }
    ids.add(probe.id);
  }
  return async () => {
    const checks = await Promise.all(
      probes.map(async (probe) => {
        try {
          const check = await probe.run();
          return check.id === probe.id
            ? check
            : {
                id: probe.id,
                passed: false,
                evidence: `probe-returned-unexpected-id:${check.id}`,
              };
        } catch (error) {
          return {
            id: probe.id,
            passed: false,
            evidence: `probe-error:${error instanceof Error ? error.name : typeof error}`,
          };
        }
      }),
    );
    return {
      ready: checks.every((check) => check.passed),
      checks,
    };
  };
}
