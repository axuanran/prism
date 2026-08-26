import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tests run against `src`, not `dist`, so a red test never means "you forgot
 * to build".
 */
const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@prismengine/contracts-data": pkg("contracts-data"),
      "@prismengine/contracts-storage": pkg("contracts-storage"),
      "@prismengine/contracts-calculation": pkg("contracts-calculation"),
      "@prismengine/contracts-organization": pkg("contracts-organization"),
      "@prismengine/kernel": pkg("kernel"),
      "@prismengine/testing": pkg("testing"),
      "@prismengine/plugin-storage-postgres": pkg("plugin-storage-postgres"),
      "@prismengine/plugin-storage-memory": pkg("plugin-storage-memory"),
      "@prismengine/plugin-type-quantity": pkg("plugin-type-quantity"),
      "@prismengine/plugin-dataset-grain": pkg("plugin-dataset-grain"),
      "@prismengine/plugin-sdk": pkg("plugin-sdk"),
      "@prismengine/platform": pkg("platform"),
      "@prismengine/plugin-http-fastify": pkg("plugin-http-fastify"),
      "@prismengine/plugin-organization-basic": pkg("plugin-organization-basic"),
      "@prismengine/plugin-calculation-memory": pkg("plugin-calculation-memory"),
    },
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
      "test/**/*.test.ts",
    ],
    environment: "node",
  },
});
