<script setup lang="ts">
/**
 * Operator-facing incident lifecycle timeline + playback (T-414).
 *
 * Renders the chronologically-ordered transitions for one incident
 * (sourced from audit-service `/audit/lineage/:incident_id`) and a
 * playback control (prev/next + slider) that highlights one step.
 * The selected step's status is surfaced on `details.snapshot` so
 * surrounding panels can render the incident's state at that point.
 */
import { computed, toRef } from "vue";
import { useIncidentTimeline } from "~/composables/useIncidentTimeline";
import type { AuditApi } from "~/utils/audit-api";

const props = defineProps<{
  incidentId: string;
  /** Test seam — pass a stubbed AuditApi. Production omits it and
   * the composable instantiates with same-origin fetch. */
  api?: AuditApi;
}>();

const {
  steps,
  cursor,
  currentStep,
  pending,
  error,
  atFirst,
  atLast,
  refresh,
  setCursor,
  prev,
  next,
  jumpToLast,
} = useIncidentTimeline(toRef(props, "incidentId"), props.api ? { api: props.api } : {});

const sliderMax = computed(() => Math.max(0, steps.value.length - 1));

function onSliderInput(e: Event): void {
  const value = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(value)) setCursor(value);
}

function shortActor(actor: string | null): string {
  if (!actor) return "system";
  return `${actor.slice(0, 8)}…`;
}
</script>

<template>
  <section
    class="rounded-md border border-aip-border bg-aip-elevated"
    aria-label="Incident lifecycle timeline"
    data-testid="incident-timeline"
  >
    <header
      class="flex items-center justify-between gap-2 border-b border-aip-border bg-aip-panel/80 px-3 py-2"
    >
      <h2 class="text-sm font-semibold tracking-tight">Timeline</h2>
      <button
        type="button"
        class="rounded-sm border border-aip-border bg-aip-panel px-2 py-0.5 text-[10px] uppercase tracking-widest text-aip-muted hover:text-aip-fg"
        data-testid="incident-timeline-refresh"
        @click="refresh"
      >
        Refresh
      </button>
    </header>

    <div
      v-if="pending"
      class="px-3 py-4 text-xs text-aip-muted"
      data-testid="incident-timeline-pending"
    >
      Loading lineage…
    </div>

    <div
      v-else-if="error"
      class="px-3 py-4 text-xs text-severity-critical"
      data-testid="incident-timeline-error"
    >
      Failed to load lineage: {{ error.message }}
    </div>

    <div
      v-else-if="steps.length === 0"
      class="px-3 py-4 text-xs text-aip-muted"
      data-testid="incident-timeline-empty"
    >
      No transitions recorded yet.
    </div>

    <template v-else>
      <ol class="divide-y divide-aip-border" data-testid="incident-timeline-steps">
        <li
          v-for="(step, index) in steps"
          :key="step.id"
          :data-testid="`incident-timeline-step-${index}`"
          :class="[
            'flex items-baseline gap-2 px-3 py-2 text-sm',
            index === cursor ? 'bg-aip-panel/60' : '',
          ]"
        >
          <button
            type="button"
            class="font-mono text-[10px] uppercase tracking-widest text-aip-muted hover:text-aip-fg"
            :class="index === cursor ? 'text-aip-accent' : ''"
            :data-testid="`incident-timeline-jump-${index}`"
            @click="setCursor(index)"
          >
            {{ String(index + 1).padStart(2, "0") }}
          </button>
          <span class="flex-1">
            <span class="font-medium">
              {{ step.kind === "created" ? "created" : step.command }}
            </span>
            <span v-if="step.kind === 'transition'" class="text-aip-muted">
              {{ " " }}({{ step.from }} → {{ step.status }})
            </span>
            <span v-else class="text-aip-muted">{{ " " }}({{ step.status }})</span>
            <div class="text-[11px] text-aip-muted">
              {{ step.occurred_at }} · actor {{ shortActor(step.actor) }}
              <span v-if="step.rationale"> · "{{ step.rationale }}"</span>
            </div>
          </span>
        </li>
      </ol>

      <footer class="border-t border-aip-border bg-aip-panel/80 px-3 py-2">
        <div class="flex items-center gap-2 text-[10px] uppercase tracking-widest text-aip-muted">
          <button
            type="button"
            class="rounded-sm border border-aip-border bg-aip-panel px-2 py-0.5 hover:text-aip-fg disabled:opacity-40"
            data-testid="incident-timeline-prev"
            :disabled="atFirst"
            @click="prev"
          >
            ◀ Prev
          </button>
          <input
            type="range"
            min="0"
            :max="sliderMax"
            :value="cursor"
            class="flex-1"
            aria-label="Timeline cursor"
            data-testid="incident-timeline-slider"
            @input="onSliderInput"
          />
          <button
            type="button"
            class="rounded-sm border border-aip-border bg-aip-panel px-2 py-0.5 hover:text-aip-fg disabled:opacity-40"
            data-testid="incident-timeline-next"
            :disabled="atLast"
            @click="next"
          >
            Next ▶
          </button>
          <button
            type="button"
            class="rounded-sm border border-aip-border bg-aip-panel px-2 py-0.5 hover:text-aip-fg disabled:opacity-40"
            data-testid="incident-timeline-last"
            :disabled="atLast"
            @click="jumpToLast"
          >
            Latest
          </button>
        </div>
        <div
          v-if="currentStep"
          class="mt-2 text-[11px] text-aip-muted"
          data-testid="incident-timeline-snapshot"
        >
          State at cursor: <span class="font-mono text-aip-fg">{{ currentStep.status }}</span>
        </div>
      </footer>
    </template>
  </section>
</template>
