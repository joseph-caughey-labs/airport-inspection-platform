<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { formatRelativeTime } from "~/utils/alerts";
import { summarizeSensorHealth } from "~/utils/sensor-health";
import type { Sensor, SensorStatus } from "~/types/airport";

const props = defineProps<{ sensors: Sensor[] }>();

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

const summary = computed(() => summarizeSensorHealth(props.sensors, now.value));

const STATUS_LABEL: Record<SensorStatus, string> = {
  online: "Online",
  degraded: "Degraded",
  offline: "Offline",
};
const STATUS_TEXT_CLASS: Record<SensorStatus, string> = {
  online: "text-conn-ok",
  degraded: "text-severity-medium",
  offline: "text-severity-critical",
};

const sortedSensors = computed(() =>
  [...props.sensors].sort((a, b) => {
    const aMs = Date.parse(a.last_seen_at);
    const bMs = Date.parse(b.last_seen_at);
    return aMs - bMs;
  }),
);
</script>

<template>
  <section
    class="space-y-3 rounded-md border border-aip-border bg-aip-elevated p-3"
    aria-label="Sensor health"
  >
    <header class="flex items-baseline justify-between">
      <h2 class="text-sm font-semibold tracking-tight">Sensor health</h2>
      <span
        class="font-mono text-[10px] uppercase tracking-widest"
        :class="STATUS_TEXT_CLASS[summary.worst]"
      >
        {{ STATUS_LABEL[summary.worst] }}
      </span>
    </header>

    <dl class="grid grid-cols-3 gap-2 text-center text-xs">
      <div class="rounded-sm border border-aip-border bg-aip-panel py-2">
        <dt class="font-mono uppercase tracking-widest text-aip-muted">Total</dt>
        <dd class="mt-0.5 font-mono text-base tabular-nums">{{ summary.total }}</dd>
      </div>
      <div class="rounded-sm border border-aip-border bg-aip-panel py-2">
        <dt class="font-mono uppercase tracking-widest text-aip-muted">Online</dt>
        <dd class="mt-0.5 font-mono text-base tabular-nums text-conn-ok">
          {{ summary.byStatus.online }}
        </dd>
      </div>
      <div class="rounded-sm border border-aip-border bg-aip-panel py-2">
        <dt class="font-mono uppercase tracking-widest text-aip-muted">Stale</dt>
        <dd
          class="mt-0.5 font-mono text-base tabular-nums"
          :class="summary.staleCount > 0 ? 'text-severity-medium' : 'text-aip-muted'"
        >
          {{ summary.staleCount }}
        </dd>
      </div>
    </dl>

    <ul
      v-if="sortedSensors.length > 0"
      class="max-h-56 space-y-1 overflow-y-auto"
      aria-label="Per-sensor last seen"
    >
      <li
        v-for="s in sortedSensors"
        :key="s.id"
        class="flex items-center justify-between rounded-sm border border-aip-border/60 bg-aip-panel px-2 py-1 text-xs"
      >
        <span class="truncate font-mono">{{ s.id }}</span>
        <div class="flex items-center gap-2">
          <span class="font-mono text-[10px]" :class="STATUS_TEXT_CLASS[s.status]">
            {{ STATUS_LABEL[s.status] }}
          </span>
          <time
            class="shrink-0 font-mono text-[10px] tabular-nums text-aip-muted"
            :datetime="s.last_seen_at"
            :title="s.last_seen_at"
          >
            {{ formatRelativeTime(s.last_seen_at, now) }}
          </time>
        </div>
      </li>
    </ul>
    <p v-else class="text-xs text-aip-muted">No sensors configured for this airport.</p>
  </section>
</template>
