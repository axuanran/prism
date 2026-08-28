import type {
  DeclaredCodeMaterialManifest,
  ProjectSourceFile,
} from "@prismengine/contracts-project";

export interface BuildWorkerRequest {
  readonly type: "build";
  readonly buildId: string;
  readonly projectId: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly files: readonly ProjectSourceFile[];
  readonly materials: readonly DeclaredCodeMaterialManifest[];
  readonly builderVersion: string;
  readonly sdkTypes: string;
  readonly sdkTypesFingerprint: string;
}

export interface BuildArtifactPayload {
  readonly contentType: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: Uint8Array;
  }[];
}

export interface BuiltMaterialPayload {
  readonly manifest: DeclaredCodeMaterialManifest;
  readonly artifact: BuildArtifactPayload;
}

export interface BuildWorkerSuccess {
  readonly type: "success";
  readonly clientArtifact: BuildArtifactPayload;
  readonly serverArtifact: BuildArtifactPayload;
  readonly testReportArtifact: BuildArtifactPayload;
  readonly testSummary: {
    readonly passed: boolean;
    readonly total: number;
    readonly failed: number;
  };
  readonly packageJsonHash: string;
  readonly dependencyLockHash: string;
  readonly pnpmVersion: string;
  readonly materials: readonly BuiltMaterialPayload[];
  readonly logs: readonly string[];
  readonly actionIds: readonly string[];
}

export interface BuildWorkerFailure {
  readonly type: "failure";
  readonly message: string;
  readonly logs: readonly string[];
}

export type BuildWorkerResponse = BuildWorkerSuccess | BuildWorkerFailure;
