<script setup lang="ts">
/**
 * Incident detail + playback page (T-414).
 *
 * Operators land here from an alert deep-link or a notification.
 * The page shows the audit-driven timeline; the local incident
 * store will hydrate the current envelope when the list/detail
 * fetch routes land in a follow-up.
 */
import { computed } from "vue";

const route = useRoute();
const incidentId = computed(() => String(route.params["id"]));

useHead(() => ({
  title: `Incident ${incidentId.value.slice(0, 8)}…`,
}));
</script>

<template>
  <div class="space-y-4">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">
          Incident
          <span class="ml-2 font-mono text-sm text-aip-muted">{{ incidentId }}</span>
        </h1>
        <p class="text-sm text-aip-muted">
          Lifecycle replay sourced from the audit-service hash chain.
        </p>
      </div>
      <NuxtLink
        to="/"
        class="rounded-sm border border-aip-border bg-aip-panel px-3 py-1.5 text-xs uppercase tracking-widest text-aip-muted hover:text-aip-fg"
      >
        ← All airports
      </NuxtLink>
    </header>
    <IncidentTimeline :incident-id="incidentId" />
  </div>
</template>
