<script setup lang="ts">
defineProps<{ role: "operator" | "reviewer" | "admin" | null }>();
</script>

<template>
  <span
    v-if="role"
    class="inline-flex items-center rounded-sm border border-aip-border bg-aip-panel px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-aip-muted"
  >
    {{ role }}
  </span>
  <span
    v-else
    class="inline-flex items-center rounded-sm border border-aip-border bg-aip-panel px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-aip-muted"
    aria-label="unauthenticated"
  >
    Guest
  </span>
</template>
