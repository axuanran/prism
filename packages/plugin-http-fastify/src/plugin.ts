import { randomUUID } from "node:crypto";
import { PrismError, diagnostic } from "@prismengine/contracts-data";
import type { CallContext, Diagnostic, Principal } from "@prismengine/contracts-data";
import { definePlugin } from "@prismengine/kernel";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  HttpAuthorizationDecision,
  HttpPluginOptions,
  HttpPrincipalRequest,
} from "./configuration.js";
import {
  HttpCapabilityToken,
  HttpDiagnosticCode,
  HttpRouteExtensionPoint,
  publicDiagnostics,
} from "./http.js";
import type { HttpCapability, HttpRequest, HttpResponse, HttpRoute } from "./http.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const ANONYMOUS_PRINCIPAL: Principal = { id: "anonymous", roles: [] };
const CORRELATION_HEADER = "x-correlation-id";
const CHANGE_REASON_HEADER = "x-change-reason";
const APPROVAL_HEADER = "x-approval-id";
const AS_OF_HEADER = "x-as-of";

interface DiagnosticsBody {
  readonly correlationId: string;
  readonly diagnostics: readonly Diagnostic[];
}

export function createHttpPlugin(options: HttpPluginOptions) {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  let server: FastifyInstance | undefined;
  let boundAddress: string | null = null;
  let acceptingRoutes = true;

  return definePlugin({
    id: "http.fastify",
    version: "0.1.20",
    engineRange: "^0.1.20",
    description: "Explicit Fastify HTTP transport for Prism Engine routes.",
    provides: [HttpCapabilityToken],

    register(context) {
      const capability: HttpCapability = {
        address: () => boundAddress,
        register: (route) => {
          if (!acceptingRoutes) {
            throw PrismError.of(
              HttpDiagnosticCode.ROUTE_REGISTRATION_CLOSED,
              "HTTP routes must be registered before the HTTP plugin starts.",
              { method: route.method, path: route.path },
            );
          }
          context.extensions.contribute(HttpRouteExtensionPoint, route);
        },
      };

      context.provide(HttpCapabilityToken, capability);
      context.extensions.contribute(HttpRouteExtensionPoint, healthRoute);
      if (options.productionReadiness !== undefined) {
        context.extensions.contribute(
          HttpRouteExtensionPoint,
          readinessRoute(options.productionReadiness),
        );
      }
      context.extensions.contribute(HttpRouteExtensionPoint, {
        method: "GET",
        path: "/api/engine/inspection",
        access: { kind: "permission", permission: "inspection.read" },
        summary: "Inspect the running Prism Engine graph.",
        handler: async () => ({ status: 200, body: options.inspection() }),
      });
    },

    async start(context) {
      acceptingRoutes = false;
      await assertProductionReadiness(options);
      const instance = Fastify({ logger: false });
      server = instance;
      configureErrors(instance, (error, correlationId) => {
        context.logger.error("HTTP route handler failed.", {
          correlationId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });

      for (const route of context.extensions.values(HttpRouteExtensionPoint)) {
        registerFastifyRoute(instance, route, options);
      }

      try {
        boundAddress = await instance.listen({ port, host });
      } catch (error) {
        server = undefined;
        boundAddress = null;
        await instance.close();
        throw error;
      }
    },

    async stop() {
      const instance = server;
      server = undefined;
      boundAddress = null;
      // Reopen registration: the engine rebuilds its registries on restart and
      // every plugin registers again. Leaving this closed would make the
      // second boot reject routes that the first boot accepted.
      acceptingRoutes = true;
      if (instance !== undefined) await instance.close();
    },
  });
}

const REQUIRED_PRODUCTION_CHECKS = [
  "artifact-store.production",
  "secret-provider.production",
  "audit-journal.valid",
  "audit-worm-export",
  "deployment.single-tenant",
  "control-plane.single-writer",
  "database.pitr",
  "rpo-rto.approved",
  "backup-restore.verified",
  "worker-container-isolation",
  "worker-node.dedicated",
  "otel-exporter",
  "sbom-signature.verified",
  "plugin-compatibility.verified",
  "migration-preflight.verified",
] as const;

async function assertProductionReadiness(options: HttpPluginOptions): Promise<void> {
  if (options.deploymentMode !== "production") return;
  const builtInChecks = [
    { id: "trusted-principal-provider", passed: options.principalProvider !== undefined },
    { id: "development-principal-disabled", passed: options.devPrincipal === undefined },
    { id: "opentelemetry-configured", passed: options.telemetry !== undefined },
    {
      id: "authorization-policy-configured",
      passed: options.authorizationPolicy !== undefined,
    },
    {
      id: "deployment-readiness-probes",
      passed: options.productionReadiness !== undefined,
    },
  ];
  const external =
    options.productionReadiness === undefined
      ? { ready: false, checks: [] }
      : await options.productionReadiness();
  const externalById = new Map(external.checks.map((check) => [check.id, check]));
  const requiredExternalChecks = REQUIRED_PRODUCTION_CHECKS.map((id) => {
    const check = externalById.get(id);
    return {
      id,
      passed: check?.passed === true && Boolean(check.evidence?.trim()),
    };
  });
  const failed = [
    ...new Set(
      [...builtInChecks, ...requiredExternalChecks, ...external.checks]
        .filter((check) => !check.passed)
        .map((check) => check.id),
    ),
  ];
  if (!external.ready || failed.length > 0) {
    throw PrismError.of(
      "PRODUCTION_READINESS_FAILED",
      "HTTP production mode cannot start until every readiness check passes.",
      { failedChecks: failed },
    );
  }
}

const healthRoute: HttpRoute = {
  method: "GET",
  path: "/health",
  access: { kind: "public" },
  summary: "Report HTTP transport health.",
  handler: async () => ({ status: 200, body: { status: "ok" } }),
};
function readinessRoute(
  readiness: NonNullable<HttpPluginOptions["productionReadiness"]>,
): HttpRoute {
  return {
    method: "GET",
    path: "/ready",
    access: { kind: "public" },
    summary: "Run live production readiness probes.",
    handler: async () => {
      try {
        const result = await readiness();
        const failedChecks = result.checks
          .filter((check) => !check.passed)
          .map((check) => check.id);
        return {
          status: result.ready && failedChecks.length === 0 ? 200 : 503,
          body: {
            status: result.ready && failedChecks.length === 0 ? "ready" : "not-ready",
            failedChecks,
          },
        };
      } catch {
        return {
          status: 503,
          body: { status: "not-ready", failedChecks: ["readiness-probe-failed"] },
        };
      }
    },
  };
}

function registerFastifyRoute(
  server: FastifyInstance,
  route: HttpRoute,
  options: HttpPluginOptions,
): void {
  server.route({
    method: route.method,
    url: route.path,
    handler: async (request, reply) => {
      const controller = new AbortController();
      const abortRequest = () => controller.abort();
      const abortResponse = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      request.raw.once("aborted", abortRequest);
      reply.raw.once("close", abortResponse);
      if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableFinished)) {
        controller.abort();
      }

      try {
        const httpRequest = await toHttpRequest(request, options, controller.signal);
        const observation = options.telemetry?.start({
          method: route.method,
          route: route.path,
          correlationId: httpRequest.call.correlationId,
          headers: httpRequest.headers,
        });
        try {
          const authorization = await authorize(route, httpRequest, options);
          let response: HttpResponse;
          try {
            response = await route.handler(httpRequest);
          } catch (error) {
            try {
              await authorization?.onFailure?.(error);
            } catch {
              throw PrismError.of(
                "AUTHORIZATION_COMPLETION_FAILED",
                "Mutation failed and its approval outcome could not be recorded.",
              );
            }
            throw error;
          }
          await authorization?.onSuccess?.();
          observation?.end(response.status);
          if (controller.signal.aborted) return reply;
          if (response.headers !== undefined) reply.headers(response.headers);
          reply.header(CORRELATION_HEADER, httpRequest.call.correlationId);
          return reply.code(response.status).send(response.body);
        } catch (error) {
          observation?.fail(
            error instanceof PrismError ? statusForDiagnostics(error.diagnostics) : 500,
            error,
          );
          throw error;
        }
      } finally {
        request.raw.off("aborted", abortRequest);
        reply.raw.off("close", abortResponse);
      }
    },
  });
}

function configureErrors(
  server: FastifyInstance,
  report: (error: unknown, correlationId: string) => void,
): void {
  server.setErrorHandler((error, request, reply) => {
    const correlationId = safeRequestCorrelationId(request);
    reply.header(CORRELATION_HEADER, correlationId);
    if (error instanceof PrismError) {
      const body: DiagnosticsBody = {
        correlationId,
        diagnostics: publicDiagnostics(error.diagnostics),
      };
      return reply.code(statusForDiagnostics(error.diagnostics)).send(body);
    }

    report(error, correlationId);
    const body: DiagnosticsBody = {
      correlationId,
      diagnostics: [
        diagnostic(HttpDiagnosticCode.HANDLER_FAILED, "HTTP route handler failed."),
      ],
    };
    return reply.code(500).send(body);
  });

  server.setNotFoundHandler((request, reply) => {
    let correlationId: string;
    try {
      correlationId = requestCorrelationId(request);
    } catch (error) {
      correlationId = safeRequestCorrelationId(request);
      reply.header(CORRELATION_HEADER, correlationId);
      if (error instanceof PrismError) {
        const body: DiagnosticsBody = {
          correlationId,
          diagnostics: publicDiagnostics(error.diagnostics),
        };
        return reply.code(statusForDiagnostics(error.diagnostics)).send(body);
      }
      throw error;
    }
    reply.header(CORRELATION_HEADER, correlationId);
    const body: DiagnosticsBody = {
      correlationId,
      diagnostics: [
        diagnostic(
          HttpDiagnosticCode.ROUTE_NOT_FOUND,
          `No HTTP route is registered for ${request.method} ${request.url}.`,
          { details: { method: request.method, path: request.url } },
        ),
      ],
    };
    return reply.code(404).send(body);
  });
}

async function toHttpRequest(
  request: FastifyRequest,
  options: HttpPluginOptions,
  signal: AbortSignal,
): Promise<HttpRequest> {
  const correlationId = requestCorrelationId(request);
  const validAt = requestValidAt(request);
  const reason = changeReason(request.headers[CHANGE_REASON_HEADER]);
  const approval = approvalId(request.headers[APPROVAL_HEADER]);
  const identityRequest: HttpPrincipalRequest = {
    method: request.method,
    path: request.url,
    headers: request.headers,
  };
  const resolved =
    options.principalProvider === undefined
      ? (options.devPrincipal ?? ANONYMOUS_PRINCIPAL)
      : ((await options.principalProvider(identityRequest)) ?? ANONYMOUS_PRINCIPAL);
  const principal = normalizePrincipal(resolved);
  const call: CallContext = {
    principal,
    correlationId,
    asOf: { validAt },
    ...(reason === undefined ? {} : { changeReason: reason }),
    ...(approval === undefined ? {} : { approvalId: approval }),
    signal,
  };

  return {
    params: request.params,
    query: request.query,
    body: request.body,
    headers: request.headers,
    call,
  };
}

const PRINCIPAL_ID_MAX_LENGTH = 128;
const PRINCIPAL_DISPLAY_NAME_MAX_LENGTH = 256;
const PRINCIPAL_ROLE_MAX_COUNT = 64;
const PRINCIPAL_ROLE_MAX_LENGTH = 128;
const PRINCIPAL_PERMISSION_MAX_COUNT = 256;
const PRINCIPAL_PERMISSION_MAX_LENGTH = 256;
const PRINCIPAL_CONTROL = /[\u0000-\u001f\u007f]/u;

function normalizePrincipal(value: unknown): Principal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPrincipal();
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (!principalString(candidate.id, PRINCIPAL_ID_MAX_LENGTH)) {
    throw invalidPrincipal();
  }
  if (
    candidate.displayName !== undefined &&
    !principalString(candidate.displayName, PRINCIPAL_DISPLAY_NAME_MAX_LENGTH)
  ) {
    throw invalidPrincipal();
  }
  const roles = principalStringArray(
    candidate.roles,
    PRINCIPAL_ROLE_MAX_COUNT,
    PRINCIPAL_ROLE_MAX_LENGTH,
  );
  const permissions =
    candidate.permissions === undefined
      ? undefined
      : principalStringArray(
          candidate.permissions,
          PRINCIPAL_PERMISSION_MAX_COUNT,
          PRINCIPAL_PERMISSION_MAX_LENGTH,
        );
  return Object.freeze({
    id: candidate.id,
    ...(candidate.displayName === undefined ? {} : { displayName: candidate.displayName }),
    roles: Object.freeze(roles),
    ...(permissions === undefined ? {} : { permissions: Object.freeze(permissions) }),
  });
}

function principalStringArray(
  value: unknown,
  maximumCount: number,
  maximumLength: number,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumCount ||
    !value.every((item) => principalString(item, maximumLength))
  ) {
    throw invalidPrincipal();
  }
  return [...new Set(value)];
}

function principalString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !PRINCIPAL_CONTROL.test(value)
  );
}

function invalidPrincipal(): PrismError {
  return PrismError.of(
    "AUTHENTICATION_PROVIDER_INVALID",
    "Trusted principal provider returned an invalid identity.",
  );
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const AS_OF_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/u;

function requestCorrelationId(request: FastifyRequest): string {
  const supplied = firstHeader(request.headers[CORRELATION_HEADER]);
  if (supplied === undefined) return generatedCorrelationId(request);
  if (!CORRELATION_ID_PATTERN.test(supplied)) {
    throw PrismError.of("HTTP_REQUEST_INVALID", "Correlation ID is invalid.");
  }
  return supplied;
}

function safeRequestCorrelationId(request: FastifyRequest): string {
  try {
    return requestCorrelationId(request);
  } catch {
    return generatedCorrelationId(request);
  }
}

function generatedCorrelationId(request: FastifyRequest): string {
  return CORRELATION_ID_PATTERN.test(request.id) ? request.id : randomUUID();
}

function requestValidAt(request: FastifyRequest): string {
  const supplied = firstHeader(request.headers[AS_OF_HEADER]);
  if (supplied === undefined) return new Date().toISOString();
  const match = AS_OF_PATTERN.exec(supplied);
  if (match === null || !validCalendarDate(match) || !validTime(match)) {
    throw PrismError.of(
      "HTTP_REQUEST_INVALID",
      "As-of must be an ISO-8601 calendar date or RFC3339 datetime.",
    );
  }
  return supplied;
}

function validCalendarDate(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
  );
}

function validTime(match: RegExpExecArray): boolean {
  if (match[4] === undefined) return true;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7];
  if (hour > 23 || minute > 59 || second > 59 || offset === undefined) return false;
  if (offset === "Z") return true;
  const offsetHour = Number(offset.slice(1, 3));
  const offsetMinute = Number(offset.slice(4, 6));
  return offsetHour <= 23 && offsetMinute <= 59;
}

function changeReason(value: string | readonly string[] | undefined): string | undefined {
  const reason = firstHeader(value)?.trim();
  if (!reason) return undefined;
  if (reason.length > 500) {
    throw PrismError.of(
      "HTTP_REQUEST_INVALID",
      "Change reason must not exceed 500 characters.",
    );
  }
  return reason;
}

function approvalId(value: string | readonly string[] | undefined): string | undefined {
  const approval = firstHeader(value)?.trim();
  if (!approval) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(approval)) {
    throw PrismError.of("HTTP_REQUEST_INVALID", "Approval ID is invalid.");
  }
  return approval;
}

async function authorize(
  route: HttpRoute,
  request: HttpRequest,
  options: HttpPluginOptions,
): Promise<HttpAuthorizationDecision | undefined> {
  if (route.access.kind === "public") return undefined;
  const context = request.call;
  if (context.principal.id === ANONYMOUS_PRINCIPAL.id) {
    throw PrismError.of(
      "AUTHENTICATION_REQUIRED",
      "The route requires an authenticated principal.",
      { method: route.method, path: route.path },
    );
  }
  const permitted =
    context.principal.roles.includes("system") ||
    context.principal.permissions?.includes("*") === true ||
    context.principal.permissions?.includes(route.access.permission) === true;
  if (!permitted) {
    throw PrismError.of(
      "AUTHORIZATION_REQUIRED",
      "The principal does not have the route permission.",
      {
        method: route.method,
        path: route.path,
        permission: route.access.permission,
        principalId: context.principal.id,
      },
    );
  }
  if (
    options.deploymentMode === "production" &&
    route.changeReason === "required" &&
    context.changeReason === undefined
  ) {
    throw PrismError.of(
      "CHANGE_REASON_REQUIRED",
      "The production mutation requires an operator change reason.",
      { method: route.method, path: route.path },
    );
  }
  const policyResult =
    options.authorizationPolicy === undefined
      ? true
      : await options.authorizationPolicy({
          principal: context.principal,
          permission: route.access.permission,
          method: route.method,
          path: route.path,
          params: request.params,
          body: request.body,
          headers: request.headers,
          correlationId: context.correlationId,
          ...(context.changeReason === undefined
            ? {}
            : { changeReason: context.changeReason }),
          requiresChangeReason: route.changeReason === "required",
        });
  const decision: HttpAuthorizationDecision =
    typeof policyResult === "boolean" ? { allowed: policyResult } : policyResult;
  if (!decision.allowed) {
    throw PrismError.of(
      "AUTHORIZATION_REQUIRED",
      "The deployment authorization policy denied the operation.",
      {
        method: route.method,
        path: route.path,
        permission: route.access.permission,
        principalId: context.principal.id,
      },
    );
  }
  return decision;
}

function statusForDiagnostics(diagnostics: readonly Diagnostic[]): number {
  const codes = diagnostics.map((item) => item.code);
  if (codes.includes("AUTHENTICATION_REQUIRED")) return 401;
  if (codes.some((code) => code.endsWith("_REQUIRED"))) return 403;
  if (
    codes.some(
      (code) => code.endsWith("_CONFLICT") || code === "ATOMIC_WRITE_PRECONDITION_FAILED",
    )
  ) {
    return 409;
  }
  if (codes.some((code) => code.endsWith("_REQUEST_INVALID"))) return 400;
  if (
    codes.some(
      (code) =>
        code === "RESOURCE_NOT_FOUND" ||
        code === "RESOURCE_REVISION_NOT_FOUND" ||
        code === "APPROVAL_NOT_FOUND" ||
        code === HttpDiagnosticCode.ROUTE_NOT_FOUND,
    )
  ) {
    return 404;
  }
  if (codes.includes("AUTHENTICATION_PROVIDER_UNAVAILABLE")) return 503;
  if (
    codes.some(
      (code) =>
        code.includes("VALIDATION") ||
        code.endsWith("_INVALID") ||
        code.startsWith("VISUAL_PIPELINE_"),
    )
  ) {
    return 422;
  }
  if (codes.some((code) => code.startsWith("APPROVAL_"))) return 403;
  return 400;
}
