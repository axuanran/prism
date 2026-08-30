import { Type, type Static } from "@sinclair/typebox";
import type { Principal } from "@prismengine/contracts-data";
import type { ConfigurationContract, EngineInspection } from "@prismengine/kernel";
import type { HttpTelemetry } from "./telemetry.js";

export const HttpConfigurationSchema = Type.Object(
  {
    port: Type.Integer({ minimum: 0, maximum: 65_535, default: 3000 }),
    host: Type.String({ minLength: 1, default: "127.0.0.1" }),
  },
  { additionalProperties: false },
);

export type HttpServerConfiguration = Static<typeof HttpConfigurationSchema>;

export const HttpConfigurationContract: ConfigurationContract<HttpServerConfiguration> = {
  schema: HttpConfigurationSchema,
  defaults: {
    port: 3000,
    host: "127.0.0.1",
  },
};
export interface HttpPrincipalRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export type HttpPrincipalProvider = (
  request: HttpPrincipalRequest,
) => Principal | null | Promise<Principal | null>;
export interface ProductionReadinessCheck {
  readonly id: string;
  readonly passed: boolean;
  readonly evidence?: string;
}

export interface ProductionReadinessResult {
  readonly ready: boolean;
  readonly checks: readonly ProductionReadinessCheck[];
}

export interface HttpAuthorizationRequest {
  readonly principal: Principal;
  readonly permission: string;
  readonly method: string;
  readonly path: string;
  readonly params: unknown;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly correlationId: string;
  readonly changeReason?: string;
  readonly requiresChangeReason: boolean;
}
export interface HttpAuthorizationDecision {
  readonly allowed: boolean;
  readonly onSuccess?: () => void | Promise<void>;
  readonly onFailure?: (error: unknown) => void | Promise<void>;
}

export type HttpAuthorizationResult = boolean | HttpAuthorizationDecision;

export type HttpAuthorizationPolicy = (
  request: HttpAuthorizationRequest,
) => HttpAuthorizationResult | Promise<HttpAuthorizationResult>;

export type HttpPluginOptions = Partial<HttpServerConfiguration> & {
  readonly inspection: () => EngineInspection;
  /**
   * Production identity boundary. The host validates its session/token and
   * returns a trusted principal; browser-supplied role headers are never read.
   */
  readonly principalProvider?: HttpPrincipalProvider;
  /** Explicit local-development identity. Never inferred or enabled by default. */
  readonly devPrincipal?: Principal;
  /** Optional OpenTelemetry bridge configured by the host SDK/exporter. */
  readonly telemetry?: HttpTelemetry;
  readonly deploymentMode?: "development" | "production";
  /**
   * Deployment-owned probes for external controls: production Artifact/Secret
   * stores, WORM audit export, backup restore, container isolation and OTLP.
   */
  readonly productionReadiness?: () => Promise<ProductionReadinessResult>;
  /**
   * Optional resource/change policy after capability permission checks.
   * Production requires it so hosts can enforce separation of duties.
   */
  readonly authorizationPolicy?: HttpAuthorizationPolicy;
};
