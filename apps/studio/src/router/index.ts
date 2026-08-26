import { createRouter, createWebHistory } from 'vue-router';
import CapabilityInspectorView from '../views/CapabilityInspectorView.vue';
import DashboardView from '../views/DashboardView.vue';
import OrganizationView from '../views/OrganizationView.vue';
import PipelineEditorView from '../views/PipelineEditorView.vue';
import ResourcesView from '../views/ResourcesView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'dashboard',
      component: DashboardView,
      meta: { title: '概览', eyebrow: '运行概况' },
    },
    {
      path: '/resources',
      name: 'resources',
      component: ResourcesView,
      meta: { title: '配置资源', eyebrow: '业务配置' },
    },
    {
      path: '/organization',
      name: 'organization',
      component: OrganizationView,
      meta: { title: '组织', eyebrow: '业务配置' },
    },
    {
      path: '/developer/capabilities',
      name: 'capability-inspector',
      component: CapabilityInspectorView,
      meta: { title: '能力检查器', eyebrow: '开发者工具' },
    },
    {
      path: '/developer/pipelines',
      name: 'pipeline-editor',
      component: PipelineEditorView,
      meta: { title: '流水线编辑器', eyebrow: '开发者工具' },
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
