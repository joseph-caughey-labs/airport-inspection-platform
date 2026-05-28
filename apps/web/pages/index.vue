<script setup lang="ts">
const system = useSystemStore();

const sixQuestions = [
  "What happened?",
  "Where is it?",
  "How serious is it?",
  "Who acknowledged it?",
  "What should happen next?",
  "Is the airport safe to operate?",
] as const;

const phaseTwoComponents = [
  { name: "Live airfield map", lands: "T-211" },
  { name: "Live alert feed", lands: "T-212" },
  { name: "WebSocket integration", lands: "T-213" },
  { name: "Sensor health panel", lands: "T-212" },
];
</script>

<template>
  <div class="space-y-8">
    <section class="aip-card">
      <h1 class="text-xl font-semibold tracking-tight">Live Ops</h1>
      <p class="mt-2 max-w-2xl text-sm text-aip-muted">
        Operator shell scaffold. Connection status, role context, and version are wired through
        Pinia. The live map, alert feed, and incident timeline attach in Phase 2 and Phase 4.
      </p>
      <div class="mt-4 text-xs font-mono text-aip-muted">
        connection: {{ system.connection }} · operational:
        {{ system.isOperational ? "yes" : "no" }}
      </div>
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

    <section class="aip-card">
      <h2 class="text-sm uppercase tracking-widest text-aip-muted">Landing in Phase 2</h2>
      <ul class="mt-3 grid gap-2 sm:grid-cols-2">
        <li
          v-for="item in phaseTwoComponents"
          :key="item.name"
          class="flex items-center justify-between rounded-sm border border-aip-border bg-aip-panel px-3 py-2 text-sm"
        >
          <span>{{ item.name }}</span>
          <span class="font-mono text-xs text-aip-muted">{{ item.lands }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
