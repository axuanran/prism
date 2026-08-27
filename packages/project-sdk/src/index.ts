export * from "@prismengine/contracts-data";
export * from "@prismengine/contracts-project";

import type { JsonValue } from "@prismengine/contracts-data";
import type {
  ProjectAction,
  ProjectClientModule,
  ProjectCodeMaterial,
} from "@prismengine/contracts-project";

export function defineProjectApp(module: ProjectClientModule<HTMLElement>): ProjectClientModule<HTMLElement> {
  return module;
}

export function defineProjectActions<
  TActions extends Readonly<Record<string, ProjectAction>>,
>(actions: TActions): TActions {
  return actions;
}

export function defineCodeMaterial<
  TInput extends JsonValue = JsonValue,
  TConfiguration extends JsonValue = JsonValue,
  TOutput extends JsonValue = JsonValue,
>(execute: (
  input: TInput,
  configuration: TConfiguration,
  context: Parameters<ProjectCodeMaterial>[2],
) => TOutput | Promise<TOutput>): ProjectCodeMaterial {
  // Generic authoring narrows JSON inputs; the Runtime validates JSON before invocation.
  return execute as unknown as ProjectCodeMaterial;
}
