import { describe, expect, it } from "vitest";
import {
  MaterialExtensionPoint,
  MaterialRegistryCapabilityToken,
  validateProjectReleaseManifest,
  type MaterialManifest,
} from "@prismengine/contracts-project";
import { createEngine, definePlugin } from "@prismengine/kernel";
import { materialRegistryPlugin } from "@prismengine/plugin-material-registry";

const codeMaterial: MaterialManifest = {
  id: "statistics.percentile",
  version: "1.0.0",
  kind: "operator",
  authoringMode: "CODE",
  displayName: "百分位",
  category: "统计",
  runtimeTarget: "pipeline",
  configurationSchema: { type: "object" },
};

const visualMaterial: MaterialManifest = {
  id: "performance.point-formula",
  version: "1.0.0",
  kind: "formula",
  authoringMode: "VISUAL",
  displayName: "积分公式",
  category: "绩效",
  runtimeTarget: "pipeline",
};

function contributor(id: string, manifests: readonly MaterialManifest[]) {
  return definePlugin({
    id,
    version: "0.1.0",
    register(context) {
      for (const manifest of manifests) {
        context.extensions.contribute(MaterialExtensionPoint, manifest);
      }
    },
  });
}

describe("unified project material registry", () => {
  it("lets visual and code authoring share one registry and release", async () => {
    let discovered: readonly MaterialManifest[] = [];
    const consumer = definePlugin({
      id: "material-consumer",
      version: "0.1.0",
      requires: { materials: MaterialRegistryCapabilityToken },
      start(context) {
        discovered = context.dependencies.materials.list();
      },
    });
    const engine = createEngine({
      plugins: [
        materialRegistryPlugin,
        contributor("visual-materials", [visualMaterial]),
        contributor("code-materials", [codeMaterial]),
        consumer,
      ],
    });
    await engine.start();
    expect(discovered.map((item) => [item.id, item.authoringMode])).toEqual([
      ["performance.point-formula", "VISUAL"],
      ["statistics.percentile", "CODE"],
    ]);
    const hash = "a".repeat(64);
    expect(validateProjectReleaseManifest({
      projectId: "hospital-performance",
      materials: [
        {
          materialId: visualMaterial.id,
          materialVersion: visualMaterial.version,
          source: {
            authoringMode: "VISUAL",
            resource: {
              kind: "performance.formula",
              id: "workload-point",
              revision: 2,
              fingerprint: hash,
            },
          },
        },
        {
          materialId: codeMaterial.id,
          materialVersion: codeMaterial.version,
          source: {
            authoringMode: "CODE",
            module: {
              projectId: "hospital-performance",
              sourceRevision: 3,
              sourceFingerprint: hash,
              artifactHash: "b".repeat(64),
              dependencyLockHash: "c".repeat(64),
            },
          },
        },
      ],
    }).valid).toBe(true);
    await engine.stop();
  });

  it("rejects duplicate material identities", async () => {
    const engine = createEngine({
      plugins: [
        materialRegistryPlugin,
        contributor("first-material", [codeMaterial]),
        contributor("second-material", [codeMaterial]),
      ],
    });
    await engine.start();
    expect(() => engine.capability(MaterialRegistryCapabilityToken).list()).toThrow(
      "MATERIAL_IDENTITY_DUPLICATE",
    );
    await engine.stop();
  });
});
