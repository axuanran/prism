import { pathToFileURL } from "node:url";
import type { JsonValue } from "@prismengine/contracts-data";
import { createEngine, type AnyPluginDefinition, type Engine } from "@prismengine/kernel";
import { prismPlatform } from "@prismengine/platform";
import type {
  DeclaredCodeMaterialManifest,
  ProjectAction,
  ProjectCodeMaterial,
  ProjectPrincipal,
  ProjectReleaseRef,
  ProjectRuntimeProfileIdentity,
} from "@prismengine/contracts-project";
import {
  appendRuntimeLog,
  sanitizeRuntimeError,
  type RuntimeProtocolLog,
  validateRuntimeOutput,
} from "./runtime-limits.js";

interface InitMessage {
  readonly type: "init";
  readonly artifactPath: string;
  readonly projectId: string;
  readonly release: ProjectReleaseRef;
  readonly runtimeAbiVersion: string;
  readonly serverArtifactHash: string;
  readonly runtimeProfile: ProjectRuntimeProfileIdentity;
  readonly materials: readonly {
    readonly manifest: DeclaredCodeMaterialManifest;
    readonly artifactPath: string;
  }[];
  readonly profileModule?: string;
}

interface InvokeMessage {
  readonly type: "invoke";
  readonly requestId: string;
  readonly actionId: string;
  readonly input: JsonValue;
  readonly principal: ProjectPrincipal;
}

interface MaterialMessage {
  readonly type: "execute-material";
  readonly requestId: string;
  readonly materialId: string;
  readonly materialVersion: string;
  readonly input: JsonValue;
  readonly configuration: JsonValue;
}

interface CancelMessage {
  readonly type: "cancel";
  readonly requestId: string;
}
interface DisposeMessage {
  readonly type: "dispose";
}
type RuntimeMessage =
  InitMessage | InvokeMessage | MaterialMessage | CancelMessage | DisposeMessage;

let actions: Readonly<Record<string, ProjectAction>> = {};
const materials = new Map<string, ProjectCodeMaterial>();
const controllers = new Map<string, AbortController>();
let projectId = "";
let runtimeEngine: Engine | undefined;
let release: ProjectReleaseRef | undefined;
let initialized = false;

process.on("message", (message: RuntimeMessage) => {
  void handle(message);
});

async function handle(message: RuntimeMessage): Promise<void> {
  if (message.type === "dispose") {
    await runtimeEngine?.stop();
    process.disconnect();
    process.exit(0);
  }
  if (message.type === "cancel") {
    controllers.get(message.requestId)?.abort();
    return;
  }
  if (message.type === "init") {
    try {
      let additionalPlugins: readonly AnyPluginDefinition[] = [];
      if (message.profileModule !== undefined) {
        const profile = (await import(pathToFileURL(message.profileModule).href)) as {
          readonly runtimeProfileIdentity?: ProjectRuntimeProfileIdentity;
          readonly createRuntimePlugins?: () => readonly AnyPluginDefinition[];
        };
        if (
          profile.runtimeProfileIdentity?.profileFingerprint !==
          message.runtimeProfile.profileFingerprint
        ) {
          throw new Error(
            "PROJECT_RUNTIME_PROFILE_MISMATCH: Runtime Profile module identity does not match release.",
          );
        }
        additionalPlugins = profile.createRuntimePlugins?.() ?? [];
      }
      runtimeEngine = createEngine({ plugins: prismPlatform({ additionalPlugins }) });
      await runtimeEngine.start();
      const loaded = await import(pathToFileURL(message.artifactPath).href);
      const candidate: unknown = loaded.actions;
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new Error("Server Artifact must export an Action Registry named actions.");
      }
      actions = candidate as Readonly<Record<string, ProjectAction>>;
      if (Object.values(actions).some((action) => typeof action !== "function")) {
        throw new Error("Every Action Registry value must be a function.");
      }
      for (const item of message.materials) {
        const module = await import(pathToFileURL(item.artifactPath).href);
        const execute: unknown = module[item.manifest.exportName];
        if (typeof execute !== "function") {
          throw new Error(
            `Material ${item.manifest.id}@${item.manifest.version} export is missing.`,
          );
        }
        materials.set(
          `${item.manifest.id}@${item.manifest.version}`,
          execute as ProjectCodeMaterial,
        );
      }
      projectId = message.projectId;
      release = message.release;
      initialized = true;
      process.send?.({
        type: "ready",
        projectId,
        releaseRevision: release.revision,
        releaseFingerprint: release.fingerprint,
        runtimeAbiVersion: message.runtimeAbiVersion,
        serverArtifactHash: message.serverArtifactHash,
        runtimeProfile: message.runtimeProfile,
        runtimeProfileFingerprint: message.runtimeProfile.profileFingerprint,
        actions: Object.keys(actions).sort(),
        materialIdentities: [...materials.keys()].sort(),
      });
    } catch (error) {
      await runtimeEngine?.stop();
      runtimeEngine = undefined;
      process.send?.({
        type: "ready-failed",
        error: sanitizeRuntimeError(error instanceof Error ? error.message : error),
      });
    }
    return;
  }
  if (!initialized || release === undefined || runtimeEngine === undefined) {
    process.send?.({
      type: "action-failure",
      requestId: message.requestId,
      code: "PROJECT_RUNTIME_DISCONNECTED",
      error: "Runtime Worker is not initialized.",
      logs: [],
    });
    return;
  }
  const logs: RuntimeProtocolLog[] = [];
  const logger = {
    info(value: unknown) {
      appendRuntimeLog(logs, "info", value);
    },
    warn(value: unknown) {
      appendRuntimeLog(logs, "warn", value);
    },
    error(value: unknown) {
      appendRuntimeLog(logs, "error", value);
    },
  };
  const engine = runtimeEngine;
  const controller = new AbortController();
  controllers.set(message.requestId, controller);
  try {
    if (message.type === "execute-material") {
      const material = materials.get(`${message.materialId}@${message.materialVersion}`);
      if (material === undefined) {
        throw new Error(
          `Material ${message.materialId}@${message.materialVersion} is not loaded.`,
        );
      }
      const output = await material(message.input, message.configuration, {
        engine,
        signal: controller.signal,
        logger,
      });
      sendRuntimeOutput(message.requestId, output, logs);
      return;
    }
    const action = actions[message.actionId];
    if (action === undefined) {
      process.send?.({
        type: "action-failure",
        requestId: message.requestId,
        code: "PROJECT_ACTION_NOT_FOUND",
        error: sanitizeRuntimeError(`Action ${message.actionId} is not exported.`),
        logs,
      });
      return;
    }
    const output = await action(message.input, {
      projectId,
      release,
      principal: message.principal,
      engine,
      signal: controller.signal,
      logger,
      materials: {
        async execute(id, version, input, configuration = null) {
          const material = materials.get(`${id}@${version}`);
          if (material === undefined)
            throw new Error(`Material ${id}@${version} is not loaded.`);
          return material(input, configuration, {
            engine,
            signal: controller.signal,
            logger,
          });
        },
      },
    });
    sendRuntimeOutput(message.requestId, output, logs);
  } catch (error) {
    process.send?.({
      type: "action-failure",
      requestId: message.requestId,
      code: controller.signal.aborted
        ? "PROJECT_ACTION_CANCELLED"
        : "PROJECT_ACTION_FAILED",
      error: sanitizeRuntimeError(
        error instanceof Error ? (error.stack ?? error.message) : error,
      ),
      logs,
    });
  } finally {
    controllers.delete(message.requestId);
  }
}

function sendRuntimeOutput(
  requestId: string,
  output: unknown,
  logs: readonly RuntimeProtocolLog[],
): void {
  const validation = validateRuntimeOutput(output);
  process.send?.(
    validation.valid
      ? {
          type: "action-success",
          requestId,
          output: validation.output,
          logs,
        }
      : {
          type: "action-failure",
          requestId,
          code: validation.code,
          error: validation.error,
          logs,
        },
  );
}
