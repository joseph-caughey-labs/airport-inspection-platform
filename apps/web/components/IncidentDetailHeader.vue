<script setup lang="ts">
/**
 * Operator-facing incident detail header. Renders the current
 * envelope from incident-service alongside the audit-driven
 * timeline below it. Adds context the timeline can't show on its
 * own — current status, severity, assignee, acknowledged-by, etc.
 */
import { toRef } from "vue";
import { useIncidentDetail } from "~/composables/useIncidentDetail";
import type { IncidentApi } from "~/utils/incident-api";

const props = defineProps<{
  incidentId: string;
  /** Test seam — pass a stubbed IncidentApi. */
  api?: IncidentApi;
}>();

const { incident, pending, error } = useIncidentDetail(
  toRef(props, "incidentId"),
  props.api ? { api: props.api } : {},
);

const SEVERITY_LABEL = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
} as const;
type SeverityKey = keyof typeof SEVERITY_LABEL;

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  acknowledged: "Acknowledged",
  assigned: "Assigned",
  in_progress: "In progress",
  escalated: "Escalated",
  resolved: "Resolved",
  archived: "Archived",
  rejected: "Rejected",
};

function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return `${id.slice(0, 8)}…`;
}

function fmtTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  // ISO → operator-readable "2026-05-29 10:00 UTC". Keep it plain
  // (no timezone-conversion magic) — operators read the audit
  // timestamps the same way and we want the displays to line up.
  return ts.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");
}
</script>

<template>
  <section
    class="rounded-md border border-aip-border bg-aip-elevated px-4 py-3"
    aria-label="Incident detail"
    data-testid="incident-detail-header"
  >
    <div
      v-if="pending && !incident"
      class="text-sm text-aip-muted"
      data-testid="incident-detail-pending"
    >
      Loading incident…
    </div>
    <div
      v-else-if="error"
      class="text-sm text-red-400"
      data-testid="incident-detail-error"
      role="alert"
    >
      Failed to load incident: {{ error.message }}
    </div>
    <div v-else-if="incident" class="flex flex-wrap items-start justify-between gap-3">
      <div class="space-y-1">
        <h2 class="text-lg font-semibold tracking-tight" data-testid="incident-detail-title">
          {{ incident.title }}
        </h2>
        <p class="font-mono text-xs text-aip-muted">
          {{ incident.id }}
        </p>
      </div>
      <dl
        class="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4"
        data-testid="incident-detail-fields"
      >
        <div>
          <dt class="font-mono text-[10px] uppercase tracking-widest text-aip-muted">Status</dt>
          <dd class="font-medium text-aip-fg" data-testid="incident-detail-status">
            {{ STATUS_LABEL[incident.status] ?? incident.status }}
          </dd>
        </div>
        <div>
          <dt class="font-mono text-[10px] uppercase tracking-widest text-aip-muted">Severity</dt>
          <dd class="font-medium text-aip-fg" data-testid="incident-detail-severity">
            {{ SEVERITY_LABEL[incident.severity as SeverityKey] ?? incident.severity }}
          </dd>
        </div>
        <div>
          <dt class="font-mono text-[10px] uppercase tracking-widest text-aip-muted">Assignee</dt>
          <dd class="font-medium text-aip-fg" data-testid="incident-detail-assignee">
            {{ shortId(incident.assigned_to) }}
          </dd>
        </div>
        <div>
          <dt class="font-mono text-[10px] uppercase tracking-widest text-aip-muted">
            Acknowledged
          </dt>
          <dd class="font-medium text-aip-fg" data-testid="incident-detail-acknowledged">
            {{ fmtTs(incident.acknowledged_at) }}
          </dd>
        </div>
      </dl>
    </div>
  </section>
</template>
