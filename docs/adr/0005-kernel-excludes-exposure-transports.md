# ADR 0005: The kernel excludes HTTP, Studio, and AI exposure

**Status:** Accepted and implemented; adapter limitations documented below

## Context

Runtime capability access, configuration editing, pipeline authoring, HTTP transport, frontend rendering, and AI/tool exposure have different security and compatibility boundaries. Automatic projection would couple the kernel to adapters and make runtime reachability imply public reachability (`packages/kernel/src/exposure.ts`, `packages/kernel/src/extension.ts`).

## Decision

Exposure declarations default private: each declared surface requires explicit `true`; no wildcard, inheritance, or implication. AI, CLI, event, and admin have no kernel behavior in V0.1 (`packages/kernel/src/exposure.ts`). HTTP only serves contributed routes and never scans capabilities (`packages/plugin-http-fastify/src/plugin.ts`).

This is a metadata vocabulary, not a universal policy engine. V0.1 enforces exactly `configuration` for resource-type discovery/draft creation and `pipeline` for operation descriptors. Capability tokens carry no exposure. `runtime`, `api`, `frontend`, `ai`, `cli`, `event`, and `admin` are inert; HTTP routing is independent of `api` and depends only on explicit route contribution (`packages/kernel/src/capability.ts`, `packages/plugin-calculation-memory/src/runtime.ts`, `packages/plugin-http-fastify/src/plugin.ts`).

## Consequences

- Transport/UI/backend adapters evolve without importing semantics into the kernel.
- A callable capability is unreachable over HTTP until a route is contributed.
- Business configuration can receive presentation without Vue dependencies.
- Each adapter must enforce the exposure metadata it projects; no universal exposure-policy engine exists (`packages/kernel/src/registries.ts`).

## Cost to reverse

Built-in HTTP/Studio/AI projection would expand kernel types/dependencies, create automatic public surfaces, and require authorization/serialization conventions centrally. Re-extracting later would break routes, descriptors, presentation, and host composition (`packages/kernel/src/extension.ts`, `packages/plugin-http-fastify/src/plugin.ts`).
