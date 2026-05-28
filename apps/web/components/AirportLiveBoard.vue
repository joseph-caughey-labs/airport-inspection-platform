<script setup lang="ts">
import { ref, watch } from "vue";
import { useAirportLiveStream } from "~/composables/useAirportLiveStream";
import type { Airport, Runway, Sensor } from "~/types/airport";

const props = defineProps<{
  airport: Airport;
  runways: Runway[];
  sensors: Sensor[];
  airportId: string;
}>();

interface MapHandle {
  resetCamera: () => void;
  pulseSensor: (id: string) => void;
}

const emit = defineEmits<{ "map-ready": [handle: MapHandle | null] }>();

const mapRef = ref<MapHandle | null>(null);

watch(mapRef, (handle) => emit("map-ready", handle), { immediate: true });

useAirportLiveStream({
  airportId: props.airportId,
  onSensorFrame(sensorId) {
    mapRef.value?.pulseSensor(sensorId);
  },
});
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[1fr_minmax(280px,360px)]">
    <ClientOnly>
      <AirportMapClient ref="mapRef" :airport="airport" :runways="runways" :sensors="sensors" />
      <template #fallback>
        <div
          class="flex h-[calc(100vh-12rem)] min-h-[480px] items-center justify-center rounded-md border border-aip-border bg-aip-base text-sm text-aip-muted"
        >
          Initializing map…
        </div>
      </template>
    </ClientOnly>

    <aside class="flex flex-col gap-4">
      <SensorHealthPanel :sensors="sensors" />
      <PresencePanel :airport-id="airportId" />
      <AlertFeed :airport-id="airportId" />
    </aside>
  </div>
</template>
