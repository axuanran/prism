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

onMounted(() => {
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
});
</script>

<template><div ref="host" class="monaco-host"></div></template>

<style scoped>
.monaco-host { width: 100%; height: 100%; min-height: 420px; }
</style>
