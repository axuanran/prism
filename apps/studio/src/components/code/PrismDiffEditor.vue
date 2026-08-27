<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

const props = defineProps<{
  original: string;
  modified: string;
  path: string;
}>();
const host = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneDiffEditor | undefined;
let originalModel: monaco.editor.ITextModel | undefined;
let modifiedModel: monaco.editor.ITextModel | undefined;

function language(path: string): string {
  if (/\.tsx?$/i.test(path)) return 'typescript';
  if (/\.jsx?$/i.test(path)) return 'javascript';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.css$/i.test(path)) return 'css';
  if (/\.md$/i.test(path)) return 'markdown';
  return 'plaintext';
}

function models(): void {
  if (!editor) return;
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = monaco.editor.createModel(props.original, language(props.path));
  modifiedModel = monaco.editor.createModel(props.modified, language(props.path));
  editor.setModel({ original: originalModel, modified: modifiedModel });
}

onMounted(() => {
  if (!host.value) return;
  editor = monaco.editor.createDiffEditor(host.value, {
    automaticLayout: true,
    fontSize: 13,
    readOnly: true,
    renderSideBySide: true,
  });
  models();
});
watch(() => [props.original, props.modified, props.path], models);
onBeforeUnmount(() => {
  editor?.dispose();
  originalModel?.dispose();
  modifiedModel?.dispose();
});
</script>

<template><div ref="host" class="diff-host"></div></template>

<style scoped>
.diff-host { width: 100%; height: 520px; }
</style>
