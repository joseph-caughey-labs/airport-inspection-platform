<script setup lang="ts">
import { computed } from "vue";
import { usePresenceStore } from "~/stores/presence";

const props = defineProps<{ airportId: string }>();

const presence = usePresenceStore();

const count = computed(() => presence.countFor(props.airportId));
const list = computed(() => presence.listFor(props.airportId));
</script>

<template>
  <section
    class="rounded-md border border-aip-border bg-aip-elevated p-3"
    aria-label="Active subscribers"
  >
    <header class="flex items-baseline justify-between">
      <h2 class="text-sm font-semibold tracking-tight">Subscribers</h2>
      <span class="font-mono text-[10px] uppercase tracking-widest text-aip-muted">
        {{ count }} online
      </span>
    </header>
    <ul v-if="list.length > 0" class="mt-2 space-y-1 text-xs">
      <li
        v-for="s in list"
        :key="s.connection_id"
        class="flex items-center justify-between rounded-sm border border-aip-border/60 bg-aip-panel px-2 py-1"
      >
        <span class="font-mono uppercase tracking-widest text-aip-muted">{{ s.role }}</span>
        <span class="truncate font-mono text-[10px] text-aip-muted">
          {{ s.connection_id.slice(0, 8) }}
        </span>
      </li>
    </ul>
    <p v-else class="mt-2 text-xs text-aip-muted">
      No subscribers reported yet — waiting on first presence frame.
    </p>
  </section>
</template>
