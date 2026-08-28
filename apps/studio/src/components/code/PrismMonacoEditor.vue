<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

const props = defineProps<{
  modelValue: string;
  path: string;
  projectId: string;
  readonly?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const host = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let model: monaco.editor.ITextModel | undefined;
let suppress = false;
let profileSdkTypesLib: monaco.IDisposable | undefined;

const workerScope = self as unknown as {
  MonacoEnvironment?: {
    getWorker(_moduleId: string, label: string): Worker;
  };
};
workerScope.MonacoEnvironment ??= {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  allowNonTsExtensions: true,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  strict: true,
  target: monaco.languages.typescript.ScriptTarget.ES2020,
});
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
});

const PROJECT_SDK_TYPES = `
declare module "@prismengine/project-sdk" {
  export interface ProjectReleaseRef { resourceId: string; revision: number; fingerprint: string }
  export interface ProjectClientRuntimeContext {
    projectId: string;
    release: ProjectReleaseRef;
    root: HTMLElement;
    actions: { call(actionId: string, input: unknown): Promise<unknown> };
    logger: Pick<Console, "info" | "warn" | "error">;
  }
  export function defineProjectApp(module: {
    mount(context: ProjectClientRuntimeContext): void | Promise<void>;
  }): unknown;
  export function defineProjectActions<T extends Record<string, (input: unknown, context: unknown) => unknown>>(actions: T): T;
  export function defineCodeMaterial(execute: (input: unknown, configuration: unknown, context: unknown) => unknown): unknown;
}
`;
monaco.languages.typescript.typescriptDefaults.addExtraLib(
  PROJECT_SDK_TYPES,
  'prism-project-sdk.d.ts',
);

async function loadProfileSdkTypes(): Promise<void> {
  const response = await fetch('/api/project-runtime-profile/sdk-types');
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`Profile SDK Types request failed: ${response.status}`);
  const profile = await response.json() as {
    readonly identity: { readonly sdkTypesFingerprint: string };
    readonly content: string;
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(profile.content),
  );
  const fingerprint = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (fingerprint !== profile.identity.sdkTypesFingerprint) {
    throw new Error('PROJECT_SDK_TYPES_MISMATCH: Monaco SDK Types do not match Runtime Profile.');
  }
  profileSdkTypesLib?.dispose();
  profileSdkTypesLib = monaco.languages.typescript.typescriptDefaults.addExtraLib(
    profile.content,
    `prism-profile-sdk-${fingerprint}.d.ts`,
  );
}

function language(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    css: 'css',
    md: 'markdown',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
  }[extension] ?? 'plaintext';
}

function replaceModel(): void {
  if (!editor) return;
  editor.setModel(null);
  model?.dispose();
  const uri = monaco.Uri.parse(`prism-project://${props.projectId}/${props.path}`);
  model = monaco.editor.createModel(props.modelValue, language(props.path), uri);
  editor.setModel(model);
}

onMounted(async () => {
  await loadProfileSdkTypes();
  if (!host.value) return;
  editor = monaco.editor.create(host.value, {
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: false },
    readOnly: props.readonly ?? false,
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: 'vs',
  });
  replaceModel();
  editor.onDidChangeModelContent(() => {
    if (!suppress) emit('update:modelValue', editor?.getValue() ?? '');
  });
});

watch(() => props.path, replaceModel);
watch(() => props.readonly, (value) => editor?.updateOptions({ readOnly: value ?? false }));
watch(() => props.modelValue, (value) => {
  if (!model || model.getValue() === value) return;
  suppress = true;
  model.setValue(value);
  suppress = false;
});

onBeforeUnmount(() => {
  editor?.dispose();
  model?.dispose();
  profileSdkTypesLib?.dispose();
});
</script>

<template><div ref="host" class="monaco-host"></div></template>

<style scoped>
.monaco-host { width: 100%; height: 100%; min-height: 420px; }
</style>
