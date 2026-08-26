import type { Component } from 'vue';

const editors = new Map<string, Component>();

export function registerEditor(id: string, component: Component): void {
  const key = id.trim();
  if (!key) throw new Error('编辑器标识不能为空。');
  editors.set(key, component);
}

export function getEditor(id: string | undefined): Component | undefined {
  return id ? editors.get(id) : undefined;
}

export function registeredEditorIds(): readonly string[] {
  return [...editors.keys()];
}
