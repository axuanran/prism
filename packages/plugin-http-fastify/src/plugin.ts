import { randomUUID } from "node:crypto";
import { PrismError, diagnostic } from "@prismengine/contracts-data";
import type { CallContext, Diagnostic, Principal } from "@prismengine/contracts-data";
import { definePlugin } from "@prismengine/kernel";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HttpPluginOptions } from "./configuration.js";
import {
  HttpCapabilityToken,
  HttpDiagnosticCode,
  HttpRouteExtensionPoint,
} from "./http.js";
import type { HttpCapability, HttpRequest, HttpRoute } from "./http.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const PRINCIPAL_HEADER = "x-principal-id";
const PRINCIPAL_ROLES_HEADER = "x-principal-roles";
const CORRELATION_HEADER = "x-correlation-id";
const AS_OF_HEADER = "x-as-of";

interface DiagnosticsBody {
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
    version: "0.1.8",
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
      context.extensions.contribute(HttpRouteExtensionPoint, {
        method: "GET",
        path: "/api/engine/inspection",
        summary: "Inspect the running Prism Engine graph.",
        handler: async () => ({ status: 200, body: options.inspection() }),
      });
    },

    async start(context) {
      acceptingRoutes = false;
      const instance = Fastify({ logger: false });
      server = instance;
      configureErrors(instance, (error) => {
        context.logger.error("HTTP route handler failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      for (const route of context.extensions.values(HttpRouteExtensionPoint)) {
        registerFastifyRoute(instance, route);
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

const healthRoute: HttpRoute = {
  method: "GET",
  path: "/health",
  summary: "Report HTTP transport health.",
  handler: async () => ({ status: 200, body: { status: "ok" } }),
};

function registerFastifyRoute(server: FastifyInstance, route: HttpRoute): void {
  server.route({
    method: route.method,
    url: route.path,
    handler: async (request, reply) => {
      const response = await route.handler(toHttpRequest(request));
      if (response.headers !== undefined) reply.headers(response.headers);
      return reply.code(response.status).send(response.body);
    },
  });
}

function configureErrors(server: FastifyInstance, report: (error: unknown) => void): void {
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof PrismError) {
      const body: DiagnosticsBody = { diagnostics: error.diagnostics };
      return reply.code(400).send(body);
    }

    report(error);
    const body: DiagnosticsBody = {
      diagnostics: [
        diagnostic(
          HttpDiagnosticCode.HANDLER_FAILED,
          "HTTP route handler failed.",
        ),
      ],
    };
    return reply.code(500).send(body);
  });

  server.setNotFoundHandler((request, reply) => {
    const body: DiagnosticsBody = {
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

function toHttpRequest(request: FastifyRequest): HttpRequest {
  const principal: Principal = {
    id: firstHeader(request.headers[PRINCIPAL_HEADER]) ?? "anonymous",
    roles: parseRoles(firstHeader(request.headers[PRINCIPAL_ROLES_HEADER])),
  };
  const call: CallContext = {
    principal,
    correlationId: firstHeader(request.headers[CORRELATION_HEADER]) ?? randomUUID(),
    asOf: {
      validAt: firstHeader(request.headers[AS_OF_HEADER]) ?? new Date().toISOString(),
    },
  };

  return {
    params: request.params,
    query: request.query,
    body: request.body,
    headers: request.headers,
    call,
  };
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function parseRoles(value: string | undefined): readonly string[] {
  return value === undefined
    ? []
    : value.split(",").map((role) => role.trim()).filter(Boolean);
}
