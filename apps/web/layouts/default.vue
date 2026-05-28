<script setup lang="ts">
import { storeToRefs } from "pinia";

const system = useSystemStore();
const { connection, role, version } = storeToRefs(system);
</script>

<template>
  <div class="min-h-screen bg-aip-base text-aip-fg">
    <header
      class="sticky top-0 z-10 flex items-center justify-between border-b border-aip-border bg-aip-panel/90 px-6 py-3 backdrop-blur"
    >
      <div class="flex items-center gap-4">
        <NuxtLink to="/" class="flex items-center gap-2">
          <span class="inline-block h-2 w-2 rounded-full bg-aip-accent" aria-hidden="true" />
          <span class="font-mono text-sm uppercase tracking-widest">Airport Inspection</span>
        </NuxtLink>
        <span
          class="rounded-sm border border-aip-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-aip-muted"
        >
          OPS · DEMO
        </span>
      </div>

      <div class="flex items-center gap-3">
        <RoleBadge :role="role" />
        <StatusPill :state="connection" />
      </div>
    </header>

    <main class="mx-auto w-full max-w-7xl px-6 py-8">
      <slot />
    </main>

    <footer
      class="border-t border-aip-border px-6 py-3 text-xs text-aip-muted flex items-center justify-between"
    >
      <span class="font-mono">v{{ version }}</span>
      <span>Portfolio demo — no real airport operations data.</span>
    </footer>
  </div>
</template>
