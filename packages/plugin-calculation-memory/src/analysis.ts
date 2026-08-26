import {
  CalculationDiagnosticCode,
  PlanAnalysisExtensionPoint,
  TypeAnalysisExtensionPoint,
  type AnalysisExtensionIdentity,
  type AnalysisResult,
  type AnalyzerRequirement,
  type PlanAnalysisExtension,
  type PlanConstraint,
  type PlanNodeAnalysisValue,
  type SemanticPlanNode,
  type TypeAnalysisExtension,
  type TypeAnalysisService,
} from "@prism/contracts-calculation";
import {
  assertJsonValue,
  canonicalSemanticAnnotations,
  diagnostic,
  type Diagnostic,
  type ValueType,
} from "@prism/contracts-data";
import type { ExtensionRegistry } from "@prism/kernel";

interface AnalyzerRegistry {
  readonly type: readonly TypeAnalysisExtension[];
  readonly plan: readonly PlanAnalysisExtension[];
  readonly identities: ReadonlyMap<string, AnalysisExtensionIdentity>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface AnalysisSession {
  readonly registry: AnalyzerRegistry;
  readonly typeService: TypeAnalysisService;
  readonly used: ReadonlySet<string>;
  require(requirements: readonly AnalyzerRequirement[]): readonly Diagnostic[];
  analyzePlanNode(
    node: SemanticPlanNode,
    upstream: ReadonlyMap<string, SemanticPlanNode>,
  ): {
    readonly node: SemanticPlanNode;
    readonly diagnostics: readonly Diagnostic[];
  };
}

export function createAnalysisSession(extensions: ExtensionRegistry): AnalysisSession {
  const registry = collectAnalyzers(extensions);
  const used = new Set<string>();

  const typeService: TypeAnalysisService = {
    inferUnary: (request) => composeTypeAnalysis(
      registry.type,
      (extension) => extension.inferUnary?.(request),
      used,
      "unary expression",
    ),
    inferBinary: (request) => composeTypeAnalysis(
      registry.type,
      (extension) => extension.inferBinary?.(request),
      used,
      "binary expression",
    ),
    inferFunction: (request) => composeTypeAnalysis(
      registry.type,
      (extension) => extension.inferFunction?.(request),
      used,
      `function "${request.name}"`,
    ),
  };

  return {
    registry,
    typeService,
    used,
    require(requirements) {
      return requiredAnalyzerDiagnostics(requirements, registry, used);
    },
    analyzePlanNode(node, upstream) {
      const candidates = registry.plan.map((extension) => ({
        extension,
        result: extension.analyzeNode({ node, upstream }),
      }));
      const invalid = candidates.filter((candidate) => candidate.result.kind === "invalid");
      if (invalid.length > 0) {
        for (const candidate of invalid) used.add(candidate.extension.id);
        return {
          node,
          diagnostics: invalid.flatMap((candidate) =>
            candidate.result.kind === "invalid" ? candidate.result.diagnostics : [],
          ),
        };
      }
      const handled = candidates.filter((candidate): candidate is {
        readonly extension: PlanAnalysisExtension;
        readonly result: Extract<AnalysisResult<PlanNodeAnalysisValue>, { readonly kind: "handled" }>;
      } => candidate.result.kind === "handled");
      if (handled.length > 1) {
        return {
          node,
          diagnostics: [analysisConflict(
            "plan node",
            handled.map((candidate) => candidate.extension.id),
            node.origin.sourceNodeId,
          )],
        };
      }
      const selected = handled[0];
      if (selected === undefined) return { node, diagnostics: [] };
      used.add(selected.extension.id);
      const normalizedConstraints = normalizeConstraints(
        selected.result.value.constraints ?? [],
        node.origin.sourceNodeId,
      );
      return {
        node: {
          ...node,
          analysis: canonicalSemanticAnnotations([
            ...(node.analysis ?? []),
            ...selected.result.value.annotations,
          ]),
          ...(normalizedConstraints.constraints.length === 0
            ? {}
            : {
                constraints: [
                  ...(node.constraints ?? []),
                  ...normalizedConstraints.constraints,
                ],
              }),
        },
        diagnostics: [
          ...selected.result.diagnostics,
          ...normalizedConstraints.diagnostics,
        ],
      };
    },
  };
}

function collectAnalyzers(extensions: ExtensionRegistry): AnalyzerRegistry {
  const type = extensions.values(TypeAnalysisExtensionPoint)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const plan = extensions.values(PlanAnalysisExtensionPoint)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const diagnostics: Diagnostic[] = [];
  const identities = new Map<string, AnalysisExtensionIdentity>();

  for (const [kind, analyzers, point] of [
    ["type", type, TypeAnalysisExtensionPoint],
    ["plan", plan, PlanAnalysisExtensionPoint],
  ] as const) {
    for (const analyzer of analyzers) {
      const existing = identities.get(analyzer.id);
      if (existing !== undefined) {
        diagnostics.push(diagnostic(
          CalculationDiagnosticCode.ANALYZER_ID_DUPLICATE,
          `Analyzer id "${analyzer.id}" is contributed more than once.`,
          { details: { analyzerId: analyzer.id, kind } },
        ));
        continue;
      }
      identities.set(analyzer.id, {
        extensionPoint: point.id,
        contractVersion: point.version,
        semanticVersion: analyzer.semanticVersion,
      });
    }
  }

  return { type, plan, identities, diagnostics };
}

function composeTypeAnalysis(
  analyzers: readonly TypeAnalysisExtension[],
  invoke: (extension: TypeAnalysisExtension) => AnalysisResult<ValueType> | undefined,
  used: Set<string>,
  subject: string,
): AnalysisResult<ValueType> {
  const candidates = analyzers.map((extension) => ({
    extension,
    result: invoke(extension) ?? { kind: "not-applicable" as const },
  }));
  const invalid = candidates.filter((candidate) => candidate.result.kind === "invalid");
  if (invalid.length > 0) {
    for (const candidate of invalid) used.add(candidate.extension.id);
    return {
      kind: "invalid",
      diagnostics: invalid.flatMap((candidate) =>
        candidate.result.kind === "invalid" ? candidate.result.diagnostics : [],
      ),
    };
  }
  const handled = candidates.filter((candidate): candidate is {
    readonly extension: TypeAnalysisExtension;
    readonly result: Extract<AnalysisResult<ValueType>, { readonly kind: "handled" }>;
  } => candidate.result.kind === "handled");
  if (handled.length > 1) {
    return {
      kind: "invalid",
      diagnostics: [analysisConflict(subject, handled.map((candidate) => candidate.extension.id))],
    };
  }
  const selected = handled[0];
  if (selected === undefined) return { kind: "not-applicable" };
  used.add(selected.extension.id);
  return selected.result;
}

function requiredAnalyzerDiagnostics(
  requirements: readonly AnalyzerRequirement[],
  registry: AnalyzerRegistry,
  used: Set<string>,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const requirement of [...requirements].sort((left, right) => left.id.localeCompare(right.id))) {
    if (seen.has(requirement.id)) {
      diagnostics.push(diagnostic(
        CalculationDiagnosticCode.ANALYZER_ID_DUPLICATE,
        `Required analyzer "${requirement.id}" is declared more than once.`,
        { details: { analyzerId: requirement.id } },
      ));
      continue;
    }
    seen.add(requirement.id);
    const identity = registry.identities.get(requirement.id);
    const expectedPoint = requirement.kind === "type"
      ? TypeAnalysisExtensionPoint
      : PlanAnalysisExtensionPoint;
    if (
      identity === undefined ||
      identity.extensionPoint !== expectedPoint.id ||
      identity.contractVersion !== requirement.contractVersion
    ) {
      diagnostics.push(diagnostic(
        CalculationDiagnosticCode.REQUIRED_ANALYZER_MISSING,
        `Required ${requirement.kind} analyzer "${requirement.id}" is not installed for contract ${requirement.contractVersion}.`,
        {
          details: {
            analyzerId: requirement.id,
            kind: requirement.kind,
            contractVersion: requirement.contractVersion,
          },
        },
      ));
    } else {
      // Required analyzers enter plan identity even when this particular plan
      // has no applicable node: their presence was an authored safety rule.
      used.add(requirement.id);
    }
  }
  return diagnostics;
}

function analysisConflict(
  subject: string,
  analyzerIds: readonly string[],
  nodeId?: string,
): Diagnostic {
  return diagnostic(
    CalculationDiagnosticCode.ANALYSIS_EXTENSION_CONFLICT,
    `Multiple analyzers handled the same ${subject}: ${analyzerIds.join(", ")}.`,
    {
      ...(nodeId === undefined ? {} : { nodeId }),
      details: { analyzerIds: [...analyzerIds].sort() },
    },
  );
}

function normalizeConstraints(
  constraints: readonly PlanConstraint[],
  nodeId: string,
): {
  readonly constraints: readonly PlanConstraint[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const sorted = [...constraints].sort((left, right) =>
    left.contract.localeCompare(right.contract),
  );
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const constraint = sorted[index];
    if (constraint === undefined) continue;
    const duplicate = index > 0 && sorted[index - 1]?.contract === constraint.contract;
    if (
      duplicate ||
      constraint.contract.trim() === "" ||
      constraint.contractVersion.trim() === ""
    ) {
      diagnostics.push(diagnostic(
        CalculationDiagnosticCode.ANALYSIS_CONSTRAINT_INVALID,
        `Invalid or duplicate analysis constraint "${constraint.contract}".`,
        { nodeId, details: { contract: constraint.contract } },
      ));
      continue;
    }
    try {
      assertJsonValue(
        constraint.spec,
        `/nodes/${nodeId}/constraints/${constraint.contract}/spec`,
      );
    } catch {
      diagnostics.push(diagnostic(
        CalculationDiagnosticCode.ANALYSIS_CONSTRAINT_INVALID,
        `Analysis constraint "${constraint.contract}" must contain JsonValue.`,
        { nodeId, details: { contract: constraint.contract } },
      ));
    }
  }
  return {
    constraints: diagnostics.length === 0 ? sorted : [],
    diagnostics,
  };
}
export function analysisIdentities(
  session: AnalysisSession,
): Readonly<Record<string, AnalysisExtensionIdentity>> {
  return Object.fromEntries(
    [...session.used]
      .sort()
      .flatMap((id) => {

        const identity = session.registry.identities.get(id);
        return identity === undefined ? [] : [[id, identity] as const];
      }),
  );
}
