import { createHash } from "node:crypto";
import {
  canonicalArtifactFiles,
  hashArtifact,
  normalizeArtifactPath,
  type CanonicalArtifactFile,
} from "@prismengine/contracts-artifact";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();

function legacyHash(contentType: string, files: readonly CanonicalArtifactFile[]): string {
  const hash = createHash("sha256");
  hash.update(contentType);
  hash.update("\u0000");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\u0000");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

describe("Artifact identity", () => {
  it("length-frames file boundaries that collided under the v1 delimiter stream", () => {
    const oneFile = canonicalArtifactFiles({
      contentType: "application/test",
      files: [
        {
          path: "a",
          content: Uint8Array.from([
            "x".charCodeAt(0),
            "b".charCodeAt(0),
            0,
            "y".charCodeAt(0),
          ]),
        },
      ],
    });
    const twoFiles = canonicalArtifactFiles({
      contentType: "application/test",
      files: [
        { path: "a", content: encoder.encode("x") },
        { path: "b", content: encoder.encode("y") },
      ],
    });

    expect(legacyHash("application/test", oneFile)).toBe(
      legacyHash("application/test", twoFiles),
    );
    expect(hashArtifact("application/test", oneFile)).not.toBe(
      hashArtifact("application/test", twoFiles),
    );
  });

  it("keeps canonical identity stable across input file ordering", () => {
    const forward = canonicalArtifactFiles({
      contentType: "application/test",
      files: [
        { path: "a.txt", content: encoder.encode("A") },
        { path: "b.txt", content: encoder.encode("B") },
      ],
    });
    const reverse = canonicalArtifactFiles({
      contentType: "application/test",
      files: [
        { path: "b.txt", content: encoder.encode("B") },
        { path: "a.txt", content: encoder.encode("A") },
      ],
    });

    expect(reverse.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
    expect(hashArtifact("application/test", reverse)).toBe(
      hashArtifact("application/test", forward),
    );
    expect(hashArtifact("application/test", forward)).toBe(
      "51fd5da4a62bc08145b69febbb7c3f0c6dc454ed36dce07b6b8e3475c6e7cfc5",
    );
  });

  it("rejects path segments that alias on filesystem providers", () => {
    for (const path of ["a//b.txt", "a/./b.txt", "a/../b.txt", "a/"]) {
      expect(() => normalizeArtifactPath(path)).toThrow("ARTIFACT_PATH_INVALID");
    }
  });

  it("rejects Windows-reserved segments while preserving portable names", () => {
    const invalid = [
      "a\u0001.txt",
      "a\u007f.txt",
      "a<b.txt",
      "a>b.txt",
      "a:b.txt",
      'a"b.txt',
      "a|b.txt",
      "a?b.txt",
      "a*b.txt",
      "trailing.",
      "trailing ",
      "CON",
      "con.txt",
      "PRN.log",
      "AUX",
      "NUL.data",
      "COM1",
      "com9.txt",
      "LPT1",
      "lpt9.bin",
    ];
    for (const path of invalid) {
      expect(() => normalizeArtifactPath(path)).toThrow("ARTIFACT_PATH_INVALID");
    }
    for (const path of [
      ".env",
      "console.txt",
      "com10.txt",
      "lpt0.bin",
      "directory/name with space.txt",
    ]) {
      expect(normalizeArtifactPath(path)).toBe(path);
    }
  });

  it("rejects case-fold collisions while preserving exact-duplicate diagnostics", () => {
    expect(() =>
      canonicalArtifactFiles({
        contentType: "application/test",
        files: [
          { path: "A.txt", content: encoder.encode("A") },
          { path: "a.txt", content: encoder.encode("a") },
        ],
      }),
    ).toThrow("ARTIFACT_PATH_COLLISION");
    expect(() =>
      canonicalArtifactFiles({
        contentType: "application/test",
        files: [
          { path: "same.txt", content: encoder.encode("A") },
          { path: "same.txt", content: encoder.encode("B") },
        ],
      }),
    ).toThrow("ARTIFACT_PATH_DUPLICATE");
  });
});
