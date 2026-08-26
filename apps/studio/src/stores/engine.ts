import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { inspectEngine } from '../api/client';
import type { EngineInspection } from '../types/engine';

export const useEngineStore = defineStore('engine', () => {
  const inspection = ref<EngineInspection | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loaded = computed(() => inspection.value !== null);

  async function load(force = false): Promise<void> {
    if (loading.value || (loaded.value && !force)) {
      return;
    }

    loading.value = true;
    error.value = null;

    try {
      inspection.value = await inspectEngine();
    } catch (cause: unknown) {
      error.value = cause instanceof Error ? cause.message : '无法读取引擎状态。';
    } finally {
      loading.value = false;
    }
  }

  return { inspection, loading, error, loaded, load };
});
