import {
  BUILD_OUTPUT_MAX_ACTION_IDS,
  BUILD_OUTPUT_MAX_FAILURE_LENGTH,
  BUILD_OUTPUT_MAX_FILE_BYTES,
  BUILD_OUTPUT_MAX_LOG_LENGTH,
  BUILD_OUTPUT_MAX_LOGS,
  boundBuildWorkerResponse,
  consumeBuildOutputFile,
  createBuildOutputBudget,
} from "../src/build-limits.js";
import type { BuildWorkerResponse } from "../src/protocol.js";
import { describe, expect, it } from "vitest";

const emptyArtifact = { contentType: "application/test", files: [] };

describe("Build Worker protocol limits", () => {
  it("rejects file and collection budgets before payload acceptance", () => {
    const budget = createBuildOutputBudget();
    expect(() => consumeBuildOutputFile(budget, BUILD_OUTPUT_MAX_FILE_BYTES + 1)).toThrow(
      "PROJECT_BUILD_OUTPUT_TOO_LARGE",
    );

    const response: BuildWorkerResponse = {
      type: "success",
      clientArtifact: emptyArtifact,
      serverArtifact: emptyArtifact,
      testReportArtifact: emptyArtifact,
      testSummary: { passed: true, total: 1, failed: 0 },
      packageJsonHash: "a".repeat(64),
      dependencyLockHash: "b".repeat(64),
      pnpmVersion: "1.0.0",
      materials: [],
      logs: [],
      actionIds: Array.from(
        { length: BUILD_OUTPUT_MAX_ACTION_IDS + 1 },
        (_, index) => `action-${index}`,
      ),
    };

    expect(boundBuildWorkerResponse(response)).toMatchObject({
      type: "failure",
      message: expect.stringContaining("PROJECT_BUILD_OUTPUT_TOO_LARGE"),
    });
  });

  it("bounds failure messages and logs deterministically", () => {
    const response = boundBuildWorkerResponse({
      type: "failure",
      message: "failure".repeat(1_000),
      logs: Array.from({ length: BUILD_OUTPUT_MAX_LOGS + 10 }, () => "log".repeat(1_000)),
    });
    if (response.type !== "failure") throw new Error("Expected bounded failure");

    expect(response.message.length).toBeLessThanOrEqual(BUILD_OUTPUT_MAX_FAILURE_LENGTH);
    expect(response.message.endsWith("[TRUNCATED]")).toBe(true);
    expect(response.logs).toHaveLength(BUILD_OUTPUT_MAX_LOGS);
    expect(response.logs.every((log) => log.length <= BUILD_OUTPUT_MAX_LOG_LENGTH)).toBe(
      true,
    );
    expect(response.logs.at(-1)).toContain("[TRUNCATED]");
  });
});
