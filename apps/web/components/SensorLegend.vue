<script setup lang="ts">
import { computed } from "vue";
import type { Sensor, SensorType } from "~/types/airport";
import { SENSOR_TYPE_COLOR } from "~/utils/map-geo";

const props = defineProps<{ sensors: Sensor[] }>();

const SENSOR_TYPE_LABEL: Record<SensorType, string> = {
  camera: "Camera",
  lidar: "LiDAR",
  gps: "GPS",
  imu: "IMU",
  weather: "Weather",
  perimeter: "Perimeter",
};

const groups = computed(() => {
  const counts = new Map<SensorType, number>();
  for (const s of props.sensors) {
    counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => ({
      type,
      count,
      color: SENSOR_TYPE_COLOR[type],
      label: SENSOR_TYPE_LABEL[type],
    }));
});
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-aip-border bg-aip-panel px-3 py-2"
    aria-label="Sensor legend"
  >
    <span class="font-mono text-xs uppercase tracking-widest text-aip-muted">Sensors</span>
    <div v-for="g in groups" :key="g.type" class="flex items-center gap-2 text-xs">
      <span
        class="inline-block h-2 w-2 rounded-full"
        :style="{ backgroundColor: g.color }"
        aria-hidden="true"
      />
      <span>{{ g.label }}</span>
      <span class="font-mono tabular-nums text-aip-muted">{{ g.count }}</span>
    </div>
  </div>
</template>
