<script setup lang="ts">
import "maplibre-gl/dist/maplibre-gl.css";
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { Airport, Runway, Sensor } from "~/types/airport";
import { mountAirportMap, type AirportMapHandle } from "~/composables/useAirportMap";

const props = defineProps<{
  airport: Airport;
  runways: Runway[];
  sensors: Sensor[];
}>();

defineExpose({
  pulseSensor: (id: string) => handle.value?.pulseSensor(id),
  resetCamera: () => handle.value?.resetCamera(),
});

const container = ref<HTMLDivElement | null>(null);
const handle = shallowRef<AirportMapHandle | null>(null);

onMounted(() => {
  if (!container.value) return;
  handle.value = mountAirportMap({
    container: container.value,
    airport: props.airport,
    runways: props.runways,
    sensors: props.sensors,
  });
});

// Re-mount the map when the airport changes (e.g. switching from SFO → JFK).
// MapLibre style updates would also work, but a clean remount is simpler
// and the map is fast to instantiate.
watch(
  () => props.airport.id,
  (next, prev) => {
    if (next === prev || !container.value) return;
    handle.value?.destroy();
    handle.value = mountAirportMap({
      container: container.value,
      airport: props.airport,
      runways: props.runways,
      sensors: props.sensors,
    });
  },
);

onBeforeUnmount(() => {
  handle.value?.destroy();
  handle.value = null;
});
</script>

<template>
  <div
    ref="container"
    class="aip-map relative h-[calc(100vh-12rem)] min-h-[480px] w-full overflow-hidden rounded-md border border-aip-border bg-aip-base"
    role="region"
    :aria-label="`Live airfield map for ${airport.name}`"
  />
</template>

<style>
/* MapLibre injects its controls; keep them legible against the dark theme. */
.maplibregl-ctrl-attrib {
  background: rgba(11, 15, 20, 0.72) !important;
  color: #8b9aa9 !important;
}
.maplibregl-ctrl-attrib a {
  color: #22d3ee !important;
}
</style>
