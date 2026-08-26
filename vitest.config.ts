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
      "@prism/contracts-data": pkg("contracts-data"),
      "@prism/contracts-storage": pkg("contracts-storage"),
      "@prism/contracts-calculation": pkg("contracts-calculation"),
      "@prism/contracts-organization": pkg("contracts-organization"),
      "@prism/kernel": pkg("kernel"),
      "@prism/testing": pkg("testing"),
      "@prism/plugin-storage-postgres": pkg("plugin-storage-postgres"),
      "@prism/plugin-storage-memory": pkg("plugin-storage-memory"),
      "@prism/plugin-type-quantity": pkg("plugin-type-quantity"),
      "@prism/plugin-dataset-grain": pkg("plugin-dataset-grain"),
      "@prism/plugin-sdk": pkg("plugin-sdk"),
      "@prism/platform": pkg("platform"),
      "@prism/plugin-http-fastify": pkg("plugin-http-fastify"),
      "@prism/plugin-organization-basic": pkg("plugin-organization-basic"),
      "@prism/plugin-calculation-memory": pkg("plugin-calculation-memory"),
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
