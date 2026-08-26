<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { useEngineStore } from './stores/engine';

interface NavItem {
  to: string;
  label: string;
  shortLabel: string;
}

const businessNavigation: NavItem[] = [
  { to: '/', label: '概览', shortLabel: '总' },
  { to: '/resources', label: '配置资源', shortLabel: '资' },
  { to: '/organization', label: '组织', shortLabel: '组' },
];

const developerNavigation: NavItem[] = [
  { to: '/developer/capabilities', label: '能力检查器', shortLabel: 'DEV' },
  { to: '/developer/pipelines', label: '流水线编辑器', shortLabel: 'FLOW' },
];

const route = useRoute();
const engineStore = useEngineStore();
const mobileNavigationOpen = ref(false);
const pageTitle = computed(() => String(route.meta.title ?? 'Prism Studio'));
const pageEyebrow = computed(() => String(route.meta.eyebrow ?? '工作台'));

onMounted(() => {
  void engineStore.load();
});

watch(
  () => route.fullPath,
  () => {
    mobileNavigationOpen.value = false;
  },
);
</script>

<template>
  <div class="app-shell">
    <button
      v-if="mobileNavigationOpen"
      class="navigation-scrim"
      type="button"
      aria-label="关闭导航"
      @click="mobileNavigationOpen = false"
    ></button>

    <aside id="studio-navigation" class="side-navigation" :class="{ 'side-navigation--open': mobileNavigationOpen }">
      <div class="brand">
        <div class="brand__mark" aria-hidden="true"><span></span><span></span><span></span></div>
        <div>
          <strong>Prism</strong>
          <span>Studio</span>
        </div>
      </div>

      <nav class="navigation" aria-label="主导航">
        <p class="navigation__label">工作台</p>
        <RouterLink
          v-for="item in businessNavigation"
          :key="item.to"
          :to="item.to"
          class="navigation__item"
          exact-active-class="navigation__item--active"
        >
          <span class="navigation__mark" aria-hidden="true">{{ item.shortLabel }}</span>
          <span>{{ item.label }}</span>
        </RouterLink>

        <div class="developer-navigation">
          <div class="developer-navigation__heading">
            <p class="navigation__label">开发者工具</p>
            <span>TECH</span>
          </div>
          <RouterLink
            v-for="item in developerNavigation"
            :key="item.to"
            :to="item.to"
            class="navigation__item navigation__item--developer"
            active-class="navigation__item--active"
          >
            <span class="navigation__mark navigation__mark--developer" aria-hidden="true">{{ item.shortLabel }}</span>
            <span>{{ item.label }}</span>
          </RouterLink>
        </div>
      </nav>

      <div class="side-navigation__footer">
        <span class="connection-dot" aria-hidden="true"></span>
        <div>
          <strong>V0.1 业务环境</strong>
          <span>{{ engineStore.error ? '服务连接异常' : '实时引擎连接' }}</span>
        </div>
      </div>
    </aside>

    <div class="workspace">
      <header class="top-bar">
        <div class="top-bar__title">
          <button
            class="menu-button"
            type="button"
            :aria-expanded="mobileNavigationOpen"
            aria-controls="studio-navigation"
            aria-label="打开导航"
            @click="mobileNavigationOpen = true"
          >
            <span></span><span></span><span></span>
          </button>
          <div>
            <p>{{ pageEyebrow }}</p>
            <h1>{{ pageTitle }}</h1>
          </div>
        </div>
        <div class="top-bar__meta" aria-label="当前环境">
          <span>PRISM ENGINE</span>
          <strong>V{{ engineStore.inspection?.engineVersion ?? '—' }}</strong>
        </div>
      </header>

      <main class="page-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: var(--color-canvas);
}

.side-navigation {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: var(--z-navigation);
  display: flex;
  width: var(--navigation-width);
  flex-direction: column;
  border-right: var(--border-width) solid var(--color-navigation-border);
  background: var(--color-navigation);
  color: var(--color-navigation-text);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: var(--top-bar-height);
  padding: 0 var(--space-6);
  border-bottom: var(--border-width) solid var(--color-navigation-border);
}

.brand__mark {
  display: grid;
  width: var(--space-6);
  height: var(--space-6);
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-1);
  transform: skewX(-12deg);
}

.brand__mark span {
  background: var(--color-brand-mark);
}

.brand__mark span:nth-child(2) {
  opacity: var(--opacity-strong);
}

.brand__mark span:nth-child(3) {
  opacity: var(--opacity-muted);
}

.brand strong,
.brand span {
  display: block;
}

.brand strong {
  color: var(--color-navigation-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-lg);
  letter-spacing: var(--letter-spacing-tight);
}

.brand > div > span {
  margin-top: var(--space-1);
  color: var(--color-navigation-muted);
  font-size: var(--font-size-xs);
  letter-spacing: var(--letter-spacing-wide);
  text-transform: uppercase;
}

.navigation {
  flex: 1;
  padding: var(--space-6) var(--space-3);
  overflow-y: auto;
}

.navigation__label {
  margin: 0;
  color: var(--color-navigation-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: var(--letter-spacing-wide);
}

.navigation__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  color: var(--color-navigation-text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  text-decoration: none;
  transition:
    color var(--duration-fast) var(--ease-out),
    background-color var(--duration-fast) var(--ease-out);
}

.navigation__item:hover {
  background: var(--color-navigation-hover);
  color: var(--color-navigation-strong);
}

.navigation__item:focus-visible {
  outline: var(--focus-width) solid var(--color-focus);
  outline-offset: var(--focus-offset-inset);
}

.navigation__item--active {
  background: var(--color-navigation-active);
  color: var(--color-navigation-strong);
}

.navigation__mark {
  display: grid;
  width: var(--space-7);
  height: var(--space-7);
  flex: 0 0 auto;
  place-items: center;
  border: var(--border-width) solid var(--color-navigation-border);
  border-radius: var(--radius-sm);
  color: var(--color-navigation-muted);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
}

.navigation__item--active .navigation__mark {
  border-color: var(--color-brand-mark);
  color: var(--color-brand-mark);
}

.developer-navigation {
  margin-top: var(--space-8);
  padding: var(--space-4) var(--space-2) var(--space-2);
  border-top: var(--border-width) solid var(--color-developer-border);
  border-bottom: var(--border-width) solid var(--color-developer-border);
  background: var(--color-developer-surface);
}

.developer-navigation__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-1);
}

.developer-navigation__heading > span {
  padding: var(--space-1) var(--space-2);
  border: var(--border-width) solid var(--color-developer-accent);
  border-radius: var(--radius-sm);
  color: var(--color-developer-accent);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}

.navigation__mark--developer {
  width: var(--space-9);
}

.side-navigation__footer {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-6);
  border-top: var(--border-width) solid var(--color-navigation-border);
}

.side-navigation__footer strong,
.side-navigation__footer span {
  display: block;
}

.side-navigation__footer strong {
  color: var(--color-navigation-strong);
  font-size: var(--font-size-xs);
}

.side-navigation__footer div span {
  margin-top: var(--space-1);
  color: var(--color-navigation-muted);
  font-size: var(--font-size-2xs);
}

.connection-dot {
  width: var(--space-2);
  height: var(--space-2);
  flex: 0 0 auto;
  border-radius: var(--radius-round);
  background: var(--color-success);
  box-shadow: 0 0 0 var(--space-1) var(--color-success-soft);
}

.workspace {
  min-width: 0;
  margin-left: var(--navigation-width);
}

.top-bar {
  position: sticky;
  top: 0;
  z-index: var(--z-top-bar);
  display: flex;
  height: var(--top-bar-height);
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-8);
  border-bottom: var(--border-width) solid var(--color-border);
  background: var(--color-top-bar);
  backdrop-filter: blur(var(--blur-sm));
}

.top-bar__title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.top-bar__title p {
  margin: 0 0 var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: var(--letter-spacing-wide);
}

.top-bar__title h1 {
  margin: 0;
  color: var(--color-text-strong);
  font-family: var(--font-display);
  font-size: var(--font-size-xl);
  line-height: var(--line-height-tight);
}

.top-bar__meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--font-size-2xs);
  letter-spacing: var(--letter-spacing-wide);
}

.top-bar__meta strong {
  padding: var(--space-1) var(--space-2);
  border: var(--border-width) solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
}

.page-content {
  width: min(100%, var(--content-max));
  margin: 0 auto;
  padding: var(--space-8);
}

.menu-button,
.navigation-scrim {
  display: none;
}

@media (max-width: 960px) {
  .side-navigation {
    transform: translateX(-100%);
    transition: transform var(--duration-normal) var(--ease-out);
  }

  .side-navigation--open {
    transform: translateX(0);
  }

  .workspace {
    margin-left: 0;
  }

  .navigation-scrim {
    position: fixed;
    inset: 0;
    z-index: var(--z-scrim);
    display: block;
    border: 0;
    background: var(--color-scrim);
  }

  .menu-button {
    display: grid;
    width: var(--space-9);
    height: var(--space-9);
    padding: var(--space-2);
    place-content: center;
    gap: var(--space-1);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }

  .menu-button span {
    width: var(--space-4);
    height: var(--border-width-strong);
    background: var(--color-text-strong);
  }

  .menu-button:focus-visible {
    outline: var(--focus-width) solid var(--color-focus);
    outline-offset: var(--focus-offset);
  }
}

@media (max-width: 640px) {
  .top-bar {
    padding: 0 var(--space-4);
  }

  .top-bar__meta {
    display: none;
  }

  .page-content {
    padding: var(--space-5) var(--space-4) var(--space-8);
  }
}
</style>
