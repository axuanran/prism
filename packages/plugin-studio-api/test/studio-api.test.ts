import { createEngine } from "@prismengine/kernel";
import { calculationPlugin } from "@prismengine/plugin-calculation-memory";
import { HttpCapabilityToken, createHttpPlugin } from "@prismengine/plugin-http-fastify";
import { organizationPlugin } from "@prismengine/plugin-organization-basic";
import { storageMemoryPlugin } from "@prismengine/plugin-storage-memory";
import { studioApiPlugin } from "@prismengine/plugin-studio-api";
import { describe, expect, it } from "vitest";

describe("Generic Studio HTTP API", () => {
  it("serves Resource, Organization, and Calculation contracts end to end", async () => {
    let engine = createEngine({ plugins: [] });
    const http = createHttpPlugin({
      port: 0,
      inspection: () => engine.inspect(),
      devPrincipal: { id: "studio-test", roles: ["system"], permissions: ["*"] },
    });
    engine = createEngine({
      plugins: [
        storageMemoryPlugin,
        calculationPlugin,
        organizationPlugin,
        studioApiPlugin,
        http,
      ],
    });
    await engine.start();
    try {
      const address = engine.capability(HttpCapabilityToken).address();
      if (address === null) throw new Error("HTTP server did not bind");
      const types = await json(await fetch(`${address}/api/resource-types`));
      expect(types).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "calculation.pipeline" })]),
      );

      const spec = { id: "empty", inputs: [], nodes: [], edges: [], outputs: [] };
      const draftResponse = await fetch(`${address}/api/resources/calculation.pipeline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "empty", name: "Empty", spec }),
      });
      expect(draftResponse.status).toBe(201);
      const draft = await jsonRecord(draftResponse);
      expect(draft).toMatchObject({ id: "empty", revision: 1, status: "draft" });
      const publishResponse = await fetch(
        `${address}/api/resources/calculation.pipeline/empty/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: 1 }),
        },
      );
      expect(publishResponse.status).toBe(201);
      expect(await json(publishResponse)).toMatchObject({ status: "published" });

      const person = await post(address, "/api/organization/people", {
        employeeNumber: "P-001",
        displayName: "Domain-neutral Person",
      });
      const unit = await post(address, "/api/organization/units", {
        code: "UNIT-1",
        name: "Unit 1",
        from: "2020-01-01",
      });
      if (!("id" in person) || typeof person.id !== "string") {
        throw new Error("Person response is malformed");
      }
      if (!("id" in unit) || typeof unit.id !== "string") {
        throw new Error("Unit response is malformed");
      }
      const assignment = await post(address, "/api/organization/assignments", {
        personId: person.id,
        organizationUnitId: unit.id,
        kind: "primary",
        from: "2020-01-01",
      });
      expect(assignment).toMatchObject({
        personId: person.id,
        organizationUnitId: unit.id,
      });
      expect(await json(await fetch(`${address}/api/organization/people`))).toHaveLength(1);

      const operations = await json(await fetch(`${address}/api/calculation/operations`));
      if (!Array.isArray(operations)) throw new Error("Operations response is malformed");
      expect(operations.length).toBeGreaterThan(0);
      const validation = await post(address, "/api/calculation/pipelines/validate", {
        spec,
      });
      expect(validation).toMatchObject({ valid: true, diagnostics: [] });
      const execution = await post(address, "/api/calculation/pipelines/execute", { spec });
      expect(execution).toMatchObject({
        status: "success",
        outputs: {},
        planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      await engine.stop();
    }
  });
});

async function post(
  address: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${address}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return jsonRecord(response);
}

async function json(response: Response): Promise<unknown> {
  return response.json();
}

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("HTTP response is not an object");
  }
  return Object.fromEntries(Object.entries(value));
}
