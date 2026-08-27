import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemCallContext } from "@prismengine/contracts-data";
import { LocalArtifactStore } from "@prismengine/plugin-artifact-store-local";

const context = systemCallContext({ correlationId: "artifact-store-test" });

describe("local Artifact Store", () => {
  it("writes immutably, reads, stats, and verifies SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "prism-artifact-store-"));
    try {
      const store = new LocalArtifactStore(root);
      const input = {
        contentType: "application/test",
        files: [
          { path: "b.txt", content: new TextEncoder().encode("B") },
          { path: "a.txt", content: new TextEncoder().encode("A") },
        ],
      };
      const first = await store.putImmutable(context, input);
      const second = await store.putImmutable(context, { ...input, files: [...input.files].reverse() });
      expect(second).toEqual(first);
      expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await store.exists(context, first)).toBe(true);
      expect(new TextDecoder().decode(await store.read(context, first, "a.txt"))).toBe("A");
      expect(await store.stat(context, first)).toMatchObject({
        fileCount: 2,
        files: [{ path: "a.txt", size: 1 }, { path: "b.txt", size: 1 }],
      });
      expect(await store.verify(context, first)).toBe(true);
      await writeFile(join(root, "sha256", first.hash.slice(0, 2), first.hash, "a.txt"), "tampered");
      expect(await store.verify(context, first)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
