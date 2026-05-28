<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useAlertsStore } from "~/stores/alerts";
import type { AlertSeverity } from "~/types/alert";

const props = defineProps<{ airportId: string }>();

const alerts = useAlertsStore();
const { feedState, error, counts, worst } = storeToRefs(alerts);

const items = computed(() => alerts.forAirport(props.airportId));

// Re-render relative times once a second without re-rendering rows
// when nothing else changed. The clock is read by each AlertRow.
const now = ref(new Date());
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  tick = setInterval(() => {
    now.value = new Date();
  }, 1000);
});
onBeforeUnmount(() => {
  if (tick) clearInterval(tick);
});

const severityOrder: AlertSeverity[] = ["critical", "high", "medium", "low", "info"];
</script>

<template>
  <section
    class="flex h-[calc(100vh-12rem)] min-h-[480px] flex-col overflow-hidden rounded-md border border-aip-border bg-aip-elevated"
    aria-label="Live alert feed"
  >
    <header
      class="flex items-center justify-between gap-2 border-b border-aip-border bg-aip-panel/80 px-3 py-2"
    >
      <div class="flex items-baseline gap-2">
        <h2 class="text-sm font-semibold tracking-tight">Live alerts</h2>
        <span class="font-mono text-[10px] uppercase tracking-widest text-aip-muted">
          worst:
          <SeverityBadge :severity="worst" :label="true" />
        </span>
      </div>
      <div class="flex items-center gap-1">
        <span
          v-for="sev in severityOrder"
          :key="sev"
          class="font-mono text-[10px] tabular-nums text-aip-muted"
        >
          <SeverityBadge :severity="sev" />
          {{ counts[sev] }}
        </span>
      </div>
    </header>

    <div
      v-if="feedState === 'loading'"
      class="flex flex-1 items-center justify-center text-xs text-aip-muted"
    >
      Connecting…
    </div>
    <div
      v-else-if="feedState === 'error'"
      class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-xs"
    >
      <span class="font-mono uppercase tracking-widest text-severity-critical">Feed error</span>
      <span class="text-aip-muted">{{ error ?? "unknown error" }}</span>
    </div>
    <div
      v-else-if="items.length === 0"
      class="flex flex-1 items-center justify-center text-xs text-aip-muted"
    >
      No alerts yet — watching for telemetry.
    </div>
    <div v-else class="flex-1 overflow-y-auto" role="log" aria-live="polite">
      <AlertRow v-for="a in items" :key="a.id" :alert="a" :now="now" />
    </div>
  </section>
</template>
