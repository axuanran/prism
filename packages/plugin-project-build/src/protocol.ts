import type {
  DeclaredCodeMaterialManifest,
  ProjectArtifactDescriptor,
  ProjectSourceFile,
  ProjectTestResult,
} from "@prismengine/contracts-project";

export interface BuildWorkerRequest {
  readonly type: "build";
  readonly buildId: string;
  readonly projectId: string;
  readonly sourceRevision: number;
  readonly sourceFingerprint: string;
  readonly files: readonly ProjectSourceFile[];
  readonly materials: readonly DeclaredCodeMaterialManifest[];
  readonly artifactRoot: string;
  readonly builderVersion: string;
}

export interface BuiltMaterialArtifact {
  readonly manifest: DeclaredCodeMaterialManifest;
  readonly artifact: ProjectArtifactDescriptor;
}

export interface BuildWorkerSuccess {
  readonly type: "success";
  readonly clientArtifact: ProjectArtifactDescriptor;
  readonly serverArtifact: ProjectArtifactDescriptor;
  readonly buildManifestArtifact: ProjectArtifactDescriptor;
  readonly testReportArtifact: ProjectArtifactDescriptor;
  readonly testResult: ProjectTestResult;
  readonly packageJsonHash: string;
  readonly dependencyLockHash: string;
  readonly pnpmVersion: string;
  readonly materials: readonly BuiltMaterialArtifact[];
  readonly logs: readonly string[];
}

export interface BuildWorkerFailure {
  readonly type: "failure";
  readonly message: string;
  readonly logs: readonly string[];
}

export type BuildWorkerResponse = BuildWorkerSuccess | BuildWorkerFailure;
