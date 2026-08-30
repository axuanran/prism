import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Docker from "dockerode";
import { ArtifactStoreCapabilityToken } from "@prismengine/contracts-artifact";
import { systemCallContext } from "@prismengine/contracts-data";
import { ChangeApprovalCapabilityToken } from "@prismengine/contracts-governance";
import { SecretCapabilityToken } from "@prismengine/contracts-secret";
import {
  AuditExportCapabilityToken,
  StorageCapabilityToken,
} from "@prismengine/contracts-storage";
import { WorkerLauncherCapabilityToken } from "@prismengine/contracts-worker";
import { createEngine } from "@prismengine/kernel";
import { prismPlatform } from "@prismengine/platform";
import { s3ArtifactStorePlugin } from "@prismengine/plugin-artifact-store-s3";
import { s3AuditExportPlugin } from "@prismengine/plugin-audit-export-s3";
import { changeApprovalPlugin } from "@prismengine/plugin-governance-approval";
import { codeProjectPlugin } from "@prismengine/plugin-code-project";
import {
  HttpCapabilityToken,
  composeProductionReadiness,
  createHttpPlugin,
  createOidcPrincipalProvider,
  type ProductionReadinessProbe,
} from "@prismengine/plugin-http-fastify";
import { PrismOpenTelemetry } from "@prismengine/plugin-observability-otel";
import { organizationPlugin } from "@prismengine/plugin-organization-basic";
import { projectBuildPlugin } from "@prismengine/plugin-project-build";
import { projectRuntimePlugin } from "@prismengine/plugin-project-runtime";
import { vaultSecretPlugin } from "@prismengine/plugin-secret-vault";
import { studioApiPlugin } from "@prismengine/plugin-studio-api";
import {
  prismWorkerContainerOptions,
  workerContainerPlugin,
} from "@prismengine/plugin-worker-container";
import {
  acquirePostgresHostLease,
  createPostgresMigrationJournal,
  storagePostgresPlugin,
  type PostgresHostLease,
} from "@prismengine/plugin-storage-postgres";
import { startAuditExportLoop } from "./audit-export-loop.js";
import { loadProductionHostConfig, safeConfigurationSummary } from "./configuration.js";
import { loadExternalEvidence, requiredExternalEvidence } from "./evidence.js";
import { productionLogger } from "./logger.js";
import { createSeparationOfDutiesPolicy } from "./policy.js";

async function main(): Promise<void> {
  const config = loadProductionHostConfig(process.env);
  const hostLogger = productionLogger("production.host");
  hostLogger.info(
    "Production Host configuration accepted.",
    safeConfigurationSummary(config),
  );

  const loadRequiredEvidence = async () =>
    requiredExternalEvidence(
      await loadExternalEvidence(
        config.evidence.files,
        config.evidence.sha256,
        config.evidence.maxAgeDays,
      ),
    );
  const requiredEvidence = await loadRequiredEvidence();
  const evidenceById = new Map(requiredEvidence.map((check) => [check.id, check]));
  const [dockerCa, dockerCertificate, dockerKey] = await Promise.all([
    readFile(config.worker.docker.caFile),
    readFile(config.worker.docker.certificateFile),
    readFile(config.worker.docker.keyFile),
  ]);
  const docker = new Docker({
    protocol: "https",
    host: config.worker.docker.host,
    port: config.worker.docker.port,
    ca: dockerCa,
    cert: dockerCertificate,
    key: dockerKey,
  });
  const telemetry = new PrismOpenTelemetry({
    serviceName: config.telemetry.serviceName,
    serviceVersion: "0.1.20",
    deploymentEnvironment: config.deploymentEnvironment,
    deploymentId: config.deploymentId,
    traceEndpoint: config.telemetry.traceEndpoint,
    metricEndpoint: config.telemetry.metricEndpoint,
    collectorHealthUrl: config.telemetry.collectorHealthUrl,
    headers: config.telemetry.headers,
    metricExportIntervalMs: config.telemetry.metricExportIntervalMs,
  });
  telemetry.start();

  const migrationJournal = createPostgresMigrationJournal({
    connectionString: config.databaseUrl,
    schema: config.databaseSchema,
  });
  let authorizationPolicy: ReturnType<typeof createSeparationOfDutiesPolicy> | undefined;
  let hostLease: PostgresHostLease | undefined;
  const readinessContext = () =>
    systemCallContext({
      correlationId: `production-readiness-${randomUUID()}`,
    });
  const probe = (
    id: string,
    run: ProductionReadinessProbe["run"],
  ): ProductionReadinessProbe => ({ id, run });

  const productionReadiness = composeProductionReadiness([
    probe("artifact-store.production", () =>
      engine
        .capability(ArtifactStoreCapabilityToken)
        .productionReadiness(readinessContext()),
    ),
    probe("secret-provider.production", () =>
      engine.capability(SecretCapabilityToken).productionReadiness(readinessContext()),
    ),
    probe("audit-worm-export", () =>
      engine.capability(AuditExportCapabilityToken).productionReadiness(readinessContext()),
    ),
    probe("worker-container-isolation", () =>
      engine
        .capability(WorkerLauncherCapabilityToken)
        .productionReadiness(readinessContext()),
    ),
    probe("otel-exporter", () => telemetry.productionReadiness(readinessContext())),
    probe("database.pitr", async () => {
      const checks = await engine
        .capability(StorageCapabilityToken)
        .productionReadiness(readinessContext());
      return (
        checks.find((check) => check.id === "database.pitr") ?? {
          id: "database.pitr",
          passed: false,
          evidence: "storage-probe-missing",
        }
      );
    }),
    probe("audit-journal.valid", async () => {
      const checks = await engine
        .capability(StorageCapabilityToken)
        .productionReadiness(readinessContext());
      return (
        checks.find((check) => check.id === "audit-journal.valid") ?? {
          id: "audit-journal.valid",
          passed: false,
          evidence: "storage-probe-missing",
        }
      );
    }),
    probe("plugin-compatibility.verified", async () => {
      const diagnostics = engine
        .inspect()
        .diagnostics.filter(
          (item) =>
            item.code === "PLUGIN_ENGINE_COMPATIBILITY_INVALID" ||
            item.code === "PLUGIN_ENGINE_COMPATIBILITY_UNDECLARED",
        );
      return {
        id: "plugin-compatibility.verified",
        passed: diagnostics.length === 0,
        evidence: JSON.stringify({ incompatibleOrUndeclared: diagnostics.length }),
      };
    }),
    probe("migration-preflight.verified", async () => ({
      id: "migration-preflight.verified",
      passed: engine.currentPhase === "registered" || engine.currentPhase === "started",
      evidence: JSON.stringify({ phase: engine.currentPhase }),
    })),
    probe("control-plane.single-writer", async () => ({
      id: "control-plane.single-writer",
      passed: hostLease !== undefined,
      evidence: JSON.stringify({
        provider: "postgres-advisory-lock",
        deploymentId: config.deploymentId,
      }),
    })),
    ...requiredEvidence.map((check) =>
      probe(check.id, async () => {
        const current = await loadRequiredEvidence();
        return (
          current.find((item) => item.id === check.id) ?? {
            id: check.id,
            passed: false,
            evidence: "missing-external-evidence",
          }
        );
      }),
    ),
  ]);

  const oidcProvider = createOidcPrincipalProvider({
    issuer: config.oidc.issuer,
    audience: config.oidc.audience,
    jwksUri: config.oidc.jwksUri,
    rolesClaim: config.oidc.rolesClaim,
    permissionsClaim: config.oidc.permissionsClaim,
  });
  const http = createHttpPlugin({
    host: config.http.host,
    port: config.http.port,
    deploymentMode: "production",
    inspection: () => engine.inspect(),
    principalProvider: async (request) => {
      const principal = await oidcProvider(request);
      if (principal === null) return null;
      return {
        ...principal,
        roles: principal.roles.filter((role) => role !== "system"),
      };
    },
    authorizationPolicy: async (request) => {
      authorizationPolicy ??= createSeparationOfDutiesPolicy(
        engine.capability(StorageCapabilityToken).audit,
        engine.capability(ChangeApprovalCapabilityToken),
      );
      return authorizationPolicy(request);
    },
    telemetry: telemetry.httpTelemetry,
    productionReadiness,
  });
  const vaultAuthentication =
    config.vault.authentication.kind === "token"
      ? {
          kind: "token" as const,
          resolveToken: () => {
            const value = process.env.PRISM_VAULT_TOKEN?.trim();
            if (!value) throw new Error("Vault token is unavailable.");
            return value;
          },
        }
      : config.vault.authentication;
  const engine = createEngine({
    plugins: [
      storagePostgresPlugin({
        connectionString: config.databaseUrl,
        schema: config.databaseSchema,
      }),
      s3ArtifactStorePlugin({
        bucket: config.artifact.bucket,
        prefix: config.artifact.prefix,
        retentionDays: config.artifact.retentionDays,
        region: config.artifact.region,
        endpoint: config.artifact.endpoint,
        forcePathStyle: config.artifact.forcePathStyle,
      }),
      workerContainerPlugin(
        prismWorkerContainerOptions({
          image: config.worker.image,
          user: config.worker.user,
          memoryBytes: config.worker.memoryBytes,
          nanoCpus: config.worker.nanoCpus,
          pidsLimit: config.worker.pidsLimit,
          tmpfsBytes: config.worker.tmpfsBytes,
          staticMounts: config.worker.staticMounts,
          docker,
        }),
      ),
      vaultSecretPlugin({
        address: config.vault.address,
        mount: config.vault.mount,
        namespace: config.vault.namespace,
        authentication: vaultAuthentication,
      }),
      ...prismPlatform({ storage: false }),
      organizationPlugin,
      changeApprovalPlugin(),
      studioApiPlugin,
      codeProjectPlugin,
      projectBuildPlugin(),
      projectRuntimePlugin(),
      s3AuditExportPlugin({
        bucket: config.auditExport.bucket,
        prefix: config.auditExport.prefix,
        retentionDays: config.auditExport.retentionDays,
        region: config.artifact.region,
        endpoint: config.artifact.endpoint,
        forcePathStyle: config.artifact.forcePathStyle,
      }),
      http,
    ],
    migrationJournal,
    logger: productionLogger,
    confirmMigrationBackup: () =>
      evidenceById.get("backup-restore.verified")?.passed === true,
    approveMigrationExternalEffects: (pluginId, migration) =>
      config.approvedExternalMigrations.has(`${pluginId}:${migration.id}`),
    onEventHandlerError: (error) =>
      hostLogger.error("Event handler failed.", {
        errorType: error instanceof Error ? error.name : typeof error,
      }),
  });

  let auditLoop: ReturnType<typeof startAuditExportLoop> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      hostLogger.info("Stopping Production Host.", { reason });
      const steps: readonly [string, () => Promise<void>][] = [
        ["audit-export", async () => auditLoop?.stop()],
        ["engine", () => engine.stop()],
        ["telemetry", () => telemetry.shutdown()],
        ["migration-journal", () => migrationJournal.dispose()],
        ["host-lease", async () => hostLease?.release()],
      ];
      for (const [name, action] of steps) {
        try {
          await action();
        } catch (error) {
          process.exitCode = 1;
          hostLogger.error("Production Host shutdown step failed.", {
            step: name,
            errorType: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      hostLogger.info("Production Host stopped.");
    })();
    return stopping;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop(signal));
  }
  process.on("uncaughtException", (error) => {
    hostLogger.error("Uncaught exception.", { errorType: error.name });
    process.exitCode = 1;
    void stop("uncaughtException");
  });
  process.on("unhandledRejection", (error) => {
    hostLogger.error("Unhandled rejection.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    process.exitCode = 1;
    void stop("unhandledRejection");
  });

  try {
    hostLease = await acquirePostgresHostLease({
      connectionString: config.databaseUrl,
      deploymentId: config.deploymentId,
      schema: config.databaseSchema,
    });
    await engine.start();
    auditLoop = startAuditExportLoop(
      engine.capability(AuditExportCapabilityToken),
      config.auditExport.intervalMs,
      productionLogger("audit.export.loop"),
    );
    const address = engine.capability(HttpCapabilityToken).address();
    hostLogger.info("Production Project Control Plane started.", {
      address,
      deploymentId: config.deploymentId,
      engineVersion: engine.inspect().engineVersion,
    });
  } catch (error) {
    hostLogger.error("Production Host failed to start.", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    process.exitCode = 1;
    await stop("startup-failure");
  }
}

await main().catch((error: unknown) => {
  productionLogger("production.bootstrap").error("Production Host bootstrap failed.", {
    errorType: error instanceof Error ? error.name : typeof error,
  });
  process.exitCode = 1;
});
