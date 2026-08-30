import type { WorkerMount } from "@prismengine/contracts-worker";

export interface ProductionHostConfig {
  readonly deploymentId: string;
  readonly deploymentEnvironment: string;
  readonly databaseUrl: string;
  readonly databaseSchema: string;
  readonly http: { readonly host: string; readonly port: number };
  readonly oidc: {
    readonly issuer: string;
    readonly audience: string;
    readonly jwksUri: string;
    readonly rolesClaim: string;
    readonly permissionsClaim: string;
  };
  readonly artifact: {
    readonly bucket: string;
    readonly prefix?: string;
    readonly retentionDays: number;
    readonly region: string;
    readonly endpoint?: string;
    readonly forcePathStyle: boolean;
  };
  readonly auditExport: {
    readonly bucket: string;
    readonly prefix: string;
    readonly retentionDays: number;
    readonly intervalMs: number;
  };
  readonly vault: {
    readonly address: string;
    readonly mount: string;
    readonly namespace?: string;
    readonly authentication:
      | { readonly kind: "token" }
      | {
          readonly kind: "kubernetes";
          readonly role: string;
          readonly jwtPath: string;
          readonly mount: string;
        };
  };
  readonly worker: {
    readonly image: string;
    readonly user: string;
    readonly memoryBytes: number;
    readonly nanoCpus: number;
    readonly pidsLimit: number;
    readonly tmpfsBytes: number;
    readonly staticMounts: readonly WorkerMount[];
    readonly docker: {
      readonly host: string;
      readonly port: number;
      readonly caFile: string;
      readonly certificateFile: string;
      readonly keyFile: string;
    };
  };
  readonly telemetry: {
    readonly serviceName: string;
    readonly traceEndpoint: string;
    readonly metricEndpoint: string;
    readonly collectorHealthUrl: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly metricExportIntervalMs: number;
  };
  readonly evidence: {
    readonly files: readonly string[];
    readonly sha256: readonly string[];
    readonly maxAgeDays: number;
  };
  readonly approvedExternalMigrations: ReadonlySet<string>;
}

export function loadProductionHostConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ProductionHostConfig {
  const databaseUrl = postgresUrl(required(environment, "PRISM_DATABASE_URL"));
  const oidcIssuer = httpsUrl(required(environment, "PRISM_OIDC_ISSUER"), "OIDC issuer");
  const oidcJwks = httpsUrl(required(environment, "PRISM_OIDC_JWKS_URI"), "OIDC JWKS URI");
  const s3Endpoint = optional(environment, "PRISM_S3_ENDPOINT");
  const vaultAddress = httpsUrl(
    required(environment, "PRISM_VAULT_ADDRESS"),
    "Vault address",
  );
  const dockerUrl = new URL(
    httpsUrl(required(environment, "PRISM_DOCKER_REMOTE_URL"), "Docker remote URL"),
  );
  const vaultAuth = optional(environment, "PRISM_VAULT_AUTH") ?? "kubernetes";
  if (vaultAuth !== "token" && vaultAuth !== "kubernetes") {
    throw new Error("PRISM_VAULT_AUTH must be token or kubernetes.");
  }
  if (vaultAuth === "token") required(environment, "PRISM_VAULT_TOKEN");
  const evidenceFiles = csv(required(environment, "PRISM_EXTERNAL_EVIDENCE_FILES"));
  const evidenceHashes = csv(required(environment, "PRISM_EXTERNAL_EVIDENCE_SHA256"));
  if (evidenceFiles.length !== evidenceHashes.length) {
    throw new Error("External evidence files and SHA-256 pins must have equal length.");
  }
  evidenceHashes.forEach((hash) => {
    if (!/^[0-9a-f]{64}$/u.test(hash))
      throw new Error("External evidence SHA-256 is invalid.");
  });
  const workerImage = required(environment, "PRISM_WORKER_IMAGE");
  if (!/@sha256:[0-9a-f]{64}$/u.test(workerImage)) {
    throw new Error("PRISM_WORKER_IMAGE must be pinned by sha256 digest.");
  }
  const workerMounts = json(
    optional(environment, "PRISM_WORKER_STATIC_MOUNTS_JSON") ?? "[]",
  );
  if (!Array.isArray(workerMounts))
    throw new Error("Worker static mounts must be an array.");
  const staticMounts = workerMounts.map((value, index): WorkerMount => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("source" in value) ||
      typeof value.source !== "string" ||
      !("target" in value) ||
      typeof value.target !== "string" ||
      !("readOnly" in value) ||
      typeof value.readOnly !== "boolean"
    ) {
      throw new Error(`Worker static mount ${index} is invalid.`);
    }
    return { source: value.source, target: value.target, readOnly: value.readOnly };
  });
  const headers = stringRecord(
    json(optional(environment, "PRISM_OTEL_HEADERS_JSON") ?? "{}"),
    "OTLP headers",
  );
  const region = required(environment, "PRISM_S3_REGION");
  return {
    deploymentId: required(environment, "PRISM_DEPLOYMENT_ID"),
    deploymentEnvironment: required(environment, "PRISM_DEPLOYMENT_ENVIRONMENT"),
    databaseUrl,
    databaseSchema: optional(environment, "PRISM_DATABASE_SCHEMA") ?? "prism",
    http: {
      host: optional(environment, "PRISM_HTTP_HOST") ?? "0.0.0.0",
      port: integer(environment, "PRISM_HTTP_PORT", 3000, 1, 65_535),
    },
    oidc: {
      issuer: oidcIssuer,
      audience: required(environment, "PRISM_OIDC_AUDIENCE"),
      jwksUri: oidcJwks,
      rolesClaim: optional(environment, "PRISM_OIDC_ROLES_CLAIM") ?? "roles",
      permissionsClaim:
        optional(environment, "PRISM_OIDC_PERMISSIONS_CLAIM") ?? "permissions",
    },
    artifact: {
      bucket: required(environment, "PRISM_ARTIFACT_BUCKET"),
      ...(optional(environment, "PRISM_ARTIFACT_PREFIX")
        ? { prefix: optional(environment, "PRISM_ARTIFACT_PREFIX") }
        : {}),
      retentionDays: integer(environment, "PRISM_ARTIFACT_RETENTION_DAYS", 365, 1, 36_500),
      region,
      ...(s3Endpoint ? { endpoint: httpsUrl(s3Endpoint, "S3 endpoint") } : {}),
      forcePathStyle: boolean(environment, "PRISM_S3_FORCE_PATH_STYLE", false),
    },
    auditExport: {
      bucket: required(environment, "PRISM_AUDIT_BUCKET"),
      prefix: optional(environment, "PRISM_AUDIT_PREFIX") ?? "audit",
      retentionDays: integer(environment, "PRISM_AUDIT_RETENTION_DAYS", 3_650, 1, 36_500),
      intervalMs: integer(
        environment,
        "PRISM_AUDIT_EXPORT_INTERVAL_MS",
        10_000,
        1_000,
        300_000,
      ),
    },
    vault: {
      address: vaultAddress,
      mount: optional(environment, "PRISM_VAULT_KV_MOUNT") ?? "secret",
      ...(optional(environment, "PRISM_VAULT_NAMESPACE")
        ? { namespace: optional(environment, "PRISM_VAULT_NAMESPACE") }
        : {}),
      authentication:
        vaultAuth === "token"
          ? { kind: "token" }
          : {
              kind: "kubernetes",
              role: required(environment, "PRISM_VAULT_KUBERNETES_ROLE"),
              jwtPath:
                optional(environment, "PRISM_VAULT_KUBERNETES_JWT_PATH") ??
                "/var/run/secrets/kubernetes.io/serviceaccount/token",
              mount: optional(environment, "PRISM_VAULT_KUBERNETES_MOUNT") ?? "kubernetes",
            },
    },
    worker: {
      image: workerImage,
      user: optional(environment, "PRISM_WORKER_USER") ?? "10001:10001",
      memoryBytes: integer(
        environment,
        "PRISM_WORKER_MEMORY_BYTES",
        1_073_741_824,
        134_217_728,
        Number.MAX_SAFE_INTEGER,
      ),
      nanoCpus: integer(
        environment,
        "PRISM_WORKER_NANO_CPUS",
        1_000_000_000,
        100_000_000,
        64_000_000_000,
      ),
      pidsLimit: integer(environment, "PRISM_WORKER_PIDS_LIMIT", 128, 16, 4_096),
      tmpfsBytes: integer(
        environment,
        "PRISM_WORKER_TMPFS_BYTES",
        67_108_864,
        16_777_216,
        4_294_967_296,
      ),
      staticMounts,
      docker: {
        host: dockerUrl.hostname,
        port: Number(dockerUrl.port || 2_376),
        caFile: required(environment, "PRISM_DOCKER_CA_FILE"),
        certificateFile: required(environment, "PRISM_DOCKER_CERT_FILE"),
        keyFile: required(environment, "PRISM_DOCKER_KEY_FILE"),
      },
    },
    telemetry: {
      serviceName: optional(environment, "PRISM_OTEL_SERVICE_NAME") ?? "prism-engine",
      traceEndpoint: httpsUrl(
        required(environment, "PRISM_OTEL_TRACE_ENDPOINT"),
        "OTLP trace endpoint",
      ),
      metricEndpoint: httpsUrl(
        required(environment, "PRISM_OTEL_METRIC_ENDPOINT"),
        "OTLP metric endpoint",
      ),
      collectorHealthUrl: httpsUrl(
        required(environment, "PRISM_OTEL_HEALTH_URL"),
        "OTLP health URL",
      ),
      headers,
      metricExportIntervalMs: integer(
        environment,
        "PRISM_OTEL_METRIC_INTERVAL_MS",
        30_000,
        1_000,
        300_000,
      ),
    },
    evidence: {
      files: evidenceFiles,
      sha256: evidenceHashes,
      maxAgeDays: integer(environment, "PRISM_EVIDENCE_MAX_AGE_DAYS", 90, 1, 365),
    },
    approvedExternalMigrations: new Set(
      csv(optional(environment, "PRISM_APPROVED_EXTERNAL_MIGRATIONS") ?? ""),
    ),
  };
}

export function safeConfigurationSummary(config: ProductionHostConfig) {
  return {
    deploymentId: config.deploymentId,
    deploymentEnvironment: config.deploymentEnvironment,
    databaseSchema: config.databaseSchema,
    http: config.http,
    artifactProvider: "artifact.store.s3",
    artifactRegion: config.artifact.region,
    vaultProvider: "secret.vault",
    workerImage: config.worker.image,
    telemetryService: config.telemetry.serviceName,
    evidenceFiles: config.evidence.files.length,
  };
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optional(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

function integer(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optional(environment, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boolean(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
): boolean {
  const value = optional(environment, name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function csv(value: string): readonly string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function httpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  return url.toString().replace(/\/$/u, "");
}

function postgresUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("PRISM_DATABASE_URL must be PostgreSQL.");
  }
  const sslmode = url.searchParams.get("sslmode");
  if (!sslmode || !["require", "verify-ca", "verify-full"].includes(sslmode)) {
    throw new Error("PRISM_DATABASE_URL must require TLS with sslmode.");
  }
  return value;
}

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("JSON environment configuration is invalid.");
  }
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const entries = Object.entries(value);
  if (!entries.every((entry) => typeof entry[1] === "string")) {
    throw new Error(`${label} values must be strings.`);
  }
  return Object.freeze(Object.fromEntries(entries));
}
