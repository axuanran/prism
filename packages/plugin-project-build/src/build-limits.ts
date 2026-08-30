import type { BuildWorkerResponse, BuildWorkerSuccess } from "./protocol.js";

export const BUILD_OUTPUT_MAX_FILES = 256;
export const BUILD_OUTPUT_MAX_FILE_BYTES = 16 * 1_024 * 1_024;
export const BUILD_OUTPUT_MAX_TOTAL_BYTES = 64 * 1_024 * 1_024;
export const BUILD_OUTPUT_MAX_MATERIALS = 128;
export const BUILD_OUTPUT_MAX_ACTION_IDS = 256;
export const BUILD_OUTPUT_MAX_LOGS = 1_000;
export const BUILD_OUTPUT_MAX_LOG_LENGTH = 2_048;
export const BUILD_OUTPUT_MAX_FAILURE_LENGTH = 4_096;
const BUILD_OUTPUT_MAX_PATH_LENGTH = 1_024;
const BUILD_OUTPUT_MAX_CONTENT_TYPE_LENGTH = 256;
export const BUILD_OUTPUT_MAX_ACTION_ID_LENGTH = 256;
const TRUNCATED = "[TRUNCATED]";
const TOO_LARGE =
  "PROJECT_BUILD_OUTPUT_TOO_LARGE: Build Worker output exceeds protocol limits.";

export interface BuildOutputBudget {
  files: number;
  bytes: number;
}

export function createBuildOutputBudget(): BuildOutputBudget {
  return { files: 0, bytes: 0 };
}

export function consumeBuildOutputFile(budget: BuildOutputBudget, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw outputTooLarge();
  budget.files += 1;
  budget.bytes += size;
  if (
    budget.files > BUILD_OUTPUT_MAX_FILES ||
    size > BUILD_OUTPUT_MAX_FILE_BYTES ||
    budget.bytes > BUILD_OUTPUT_MAX_TOTAL_BYTES
  ) {
    throw outputTooLarge();
  }
}

export function assertBuildOutputCount(count: number, maximum: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw outputTooLarge();
  }
}

export function assertBuildActionIds(actionIds: readonly string[]): void {
  assertBuildOutputCount(actionIds.length, BUILD_OUTPUT_MAX_ACTION_IDS);
  if (actionIds.some((id) => id.length > BUILD_OUTPUT_MAX_ACTION_ID_LENGTH)) {
    throw outputTooLarge();
  }
}

export function appendBuildLog(logs: string[], value: unknown): void {
  if (logs.length >= BUILD_OUTPUT_MAX_LOGS) return;
  if (logs.length === BUILD_OUTPUT_MAX_LOGS - 1) {
    logs.push(`Additional Build logs omitted. ${TRUNCATED}`);
    return;
  }
  logs.push(boundedString(safeString(value), BUILD_OUTPUT_MAX_LOG_LENGTH));
}

export function boundBuildWorkerResponse(
  response: BuildWorkerResponse,
): BuildWorkerResponse {
  const logs = sanitizeBuildLogs(response.logs);
  if (response.type === "failure") {
    return {
      type: "failure",
      message: boundedString(response.message, BUILD_OUTPUT_MAX_FAILURE_LENGTH),
      logs,
    };
  }

  try {
    assertBuildOutputCount(response.materials.length, BUILD_OUTPUT_MAX_MATERIALS);
    assertBuildActionIds(response.actionIds);
    const budget = createBuildOutputBudget();
    for (const artifact of buildArtifacts(response)) {
      if (
        artifact.contentType.length > BUILD_OUTPUT_MAX_CONTENT_TYPE_LENGTH ||
        artifact.files.length > BUILD_OUTPUT_MAX_FILES
      ) {
        throw outputTooLarge();
      }
      for (const file of artifact.files) {
        if (file.path.length > BUILD_OUTPUT_MAX_PATH_LENGTH) throw outputTooLarge();
        consumeBuildOutputFile(budget, file.content.byteLength);
      }
    }
    return { ...response, logs };
  } catch {
    return { type: "failure", message: TOO_LARGE, logs };
  }
}

function buildArtifacts(response: BuildWorkerSuccess) {
  return [
    response.clientArtifact,
    response.serverArtifact,
    response.testReportArtifact,
    ...response.materials.map((item) => item.artifact),
  ];
}

function sanitizeBuildLogs(logs: readonly string[]): readonly string[] {
  const bounded: string[] = [];
  for (const log of logs) appendBuildLog(bounded, log);
  return bounded;
}

function outputTooLarge(): Error {
  return new Error(TOO_LARGE);
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[UNPRINTABLE]";
  }
}

function boundedString(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const prefixLength = maximum - TRUNCATED.length;
  let prefix = value.slice(0, prefixLength);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}${TRUNCATED}`;
}
