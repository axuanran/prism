/**
 * Exposure surfaces.
 *
 * A plugin decides, per capability/resource/operation, which surfaces may see
 * it. Surfaces are independent: being callable at runtime never implies an
 * HTTP route, a pipeline node or a studio page.
 *
 * Default is private. Absence of a declaration means "not exposed".
 */

export type Surface =
  | "runtime"
  | "configuration"
  | "pipeline"
  | "api"
  | "frontend"
  /** Reserved extension points; no engine behavior attached in V0.1. */
  | "ai"
  | "cli"
  | "event"
  | "admin";

export const ALL_SURFACES: readonly Surface[] = [
  "runtime",
  "configuration",
  "pipeline",
  "api",
  "frontend",
  "ai",
  "cli",
  "event",
  "admin",
];

/**
 * Declared exposure of a single artifact. Explicit `true` per surface;
 * there is no wildcard and no inheritance.
 */
export type ExposureDeclaration = {
  readonly [S in Surface]?: boolean;
};

export const PRIVATE: ExposureDeclaration = Object.freeze({});

export function isExposed(
  exposure: ExposureDeclaration | undefined,
  surface: Surface,
): boolean {
  return exposure?.[surface] === true;
}

export function exposedSurfaces(
  exposure: ExposureDeclaration | undefined,
): readonly Surface[] {
  if (!exposure) return [];
  return ALL_SURFACES.filter((s) => exposure[s] === true);
}
