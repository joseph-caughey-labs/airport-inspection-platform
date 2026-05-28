<script setup lang="ts">
import { useSeedData } from "~/composables/useSeedData";

const system = useSystemStore();
const { data, pending } = await useSeedData();

const sixQuestions = [
  "What happened?",
  "Where is it?",
  "How serious is it?",
  "Who acknowledged it?",
  "What should happen next?",
  "Is the airport safe to operate?",
] as const;
</script>

<template>
  <div class="space-y-8">
    <section class="aip-card">
      <h1 class="text-xl font-semibold tracking-tight">Live Ops</h1>
      <p class="mt-2 max-w-2xl text-sm text-aip-muted">
        Operator shell. Pick an airport below to open the live airfield map. WebSocket fanout
        attaches in T-213; today the map renders runways + sensors from the seed dataset.
      </p>
      <div class="mt-4 text-xs font-mono text-aip-muted">
        connection: {{ system.connection }} · operational:
        {{ system.isOperational ? "yes" : "no" }}
      </div>
    </section>

    <section class="aip-card">
      <h2 class="text-sm uppercase tracking-widest text-aip-muted">Airports</h2>
      <div v-if="pending" class="mt-3 text-xs text-aip-muted">Loading…</div>
      <ul v-else class="mt-3 grid gap-2 sm:grid-cols-2">
        <li v-for="a in data?.airports ?? []" :key="a.id">
          <NuxtLink
            :to="`/airports/${a.id}`"
            class="flex items-center justify-between gap-3 rounded-sm border border-aip-border bg-aip-panel px-3 py-2 text-sm transition hover:border-aip-accent"
          >
            <div>
              <div class="font-medium">{{ a.name }}</div>
              <div class="font-mono text-xs text-aip-muted">
                {{ a.icao_code }} · {{ a.iata_code }} · {{ a.timezone }}
              </div>
            </div>
            <div class="flex flex-col items-end text-xs text-aip-muted">
              <span class="font-mono tabular-nums">
                {{ data?.runwaysFor(a.id).length ?? 0 }} rwy
              </span>
              <span class="font-mono tabular-nums">
                {{ data?.sensorsFor(a.id).length ?? 0 }} sensors
              </span>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </section>

    <section class="aip-card">
      <h2 class="text-sm uppercase tracking-widest text-aip-muted">
        The six questions every panel serves
      </h2>
      <ol class="mt-3 grid gap-2 sm:grid-cols-2">
        <li
          v-for="(q, i) in sixQuestions"
          :key="q"
          class="flex items-baseline gap-3 rounded-sm border border-aip-border bg-aip-panel px-3 py-2"
        >
          <span class="font-mono text-xs tabular-nums text-aip-muted">
            {{ String(i + 1).padStart(2, "0") }}
          </span>
          <span class="text-sm">{{ q }}</span>
        </li>
      </ol>
    </section>
  </div>
</template>
