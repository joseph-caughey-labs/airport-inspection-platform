<script setup lang="ts">
import { computed, ref } from "vue";
import { useSeedData } from "~/composables/useSeedData";

const route = useRoute();
const airportId = computed(() => String(route.params["id"]));

const { data, pending, error } = await useSeedData();

const airport = computed(() => data.value?.airportById(airportId.value));
const runways = computed(() => data.value?.runwaysFor(airportId.value) ?? []);
const sensors = computed(() => data.value?.sensorsFor(airportId.value) ?? []);

const mapRef = ref<{
  resetCamera: () => void;
  pulseSensor: (id: string) => void;
} | null>(null);

useHead(() => ({
  title: airport.value ? `${airport.value.iata_code} — Live Map` : "Live Map",
}));
</script>

<template>
  <div class="space-y-4">
    <div v-if="pending" class="aip-card text-sm text-aip-muted">Loading seed data…</div>
    <div v-else-if="error" class="aip-card text-sm text-severity-critical">
      Failed to load seed data: {{ error.message }}
    </div>
    <template v-else-if="airport">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold tracking-tight">
            {{ airport.name }}
            <span class="ml-2 font-mono text-sm text-aip-muted">
              {{ airport.icao_code }} · {{ airport.iata_code }}
            </span>
          </h1>
          <p class="text-sm text-aip-muted">
            {{ airport.city }}, {{ airport.country }} · {{ airport.timezone }}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <NuxtLink
            to="/"
            class="rounded-sm border border-aip-border bg-aip-panel px-3 py-1.5 text-xs uppercase tracking-widest text-aip-muted hover:text-aip-fg"
          >
            ← All airports
          </NuxtLink>
          <button
            type="button"
            class="rounded-sm border border-aip-border bg-aip-panel px-3 py-1.5 text-xs uppercase tracking-widest text-aip-muted hover:text-aip-fg"
            @click="mapRef?.resetCamera()"
          >
            Reset view
          </button>
        </div>
      </header>

      <SensorLegend :sensors="sensors" />

      <!-- :key remounts the live-stream owner whenever the airport
           changes, which disposes the old WsClient cleanly. -->
      <AirportLiveBoard
        :key="airportId"
        :airport="airport"
        :runways="runways"
        :sensors="sensors"
        :airport-id="airportId"
        @map-ready="(ref) => (mapRef = ref)"
      />
    </template>
    <div v-else class="aip-card text-sm">
      Unknown airport id <code class="font-mono">{{ airportId }}</code
      >.
      <NuxtLink class="ml-2 text-aip-accent" to="/">Back to list</NuxtLink>
    </div>
  </div>
</template>
