<script setup lang="ts">
import type { ConnectionState } from "~/stores/system";

const props = defineProps<{ state: ConnectionState }>();

const label = computed(() => {
  switch (props.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "stale":
      return "Stale";
    case "disconnected":
      return "Offline";
  }
});

const dotClass = computed(() => {
  switch (props.state) {
    case "connected":
      return "bg-conn-ok";
    case "stale":
      return "bg-conn-stale";
    case "disconnected":
      return "bg-conn-down";
    case "connecting":
      return "bg-aip-muted animate-pulse";
  }
});
</script>

<template>
  <div
    role="status"
    :aria-label="`Connection ${state}`"
    class="inline-flex items-center gap-2 rounded-full border border-aip-border bg-aip-elevated px-3 py-1 text-xs font-medium text-aip-fg"
  >
    <span class="inline-block h-2 w-2 rounded-full" :class="dotClass" aria-hidden="true" />
    <span>{{ label }}</span>
  </div>
</template>
