<script setup lang="ts">
import { computed } from "vue";
import { formatRelativeTime } from "~/utils/alerts";
import type { AlertItem } from "~/types/alert";

const props = defineProps<{ alert: AlertItem; now: Date }>();

const relative = computed(() => formatRelativeTime(props.alert.received_at, props.now));
</script>

<template>
  <article
    class="flex items-start gap-2 border-b border-aip-border/60 px-3 py-2 text-sm last:border-b-0 hover:bg-aip-elevated/60"
    :data-low-confidence="alert.low_confidence ? 'true' : undefined"
  >
    <SeverityBadge :severity="alert.severity" />
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <div class="truncate font-medium">{{ alert.title }}</div>
          <span
            v-if="alert.low_confidence"
            class="shrink-0 rounded-sm border border-severity-medium px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-severity-medium"
            aria-label="Low confidence detection"
            title="Confidence below the actionable threshold (weather-degraded or boundary-case scoring)"
          >
            LOW CONF
          </span>
        </div>
        <time
          class="shrink-0 font-mono text-[10px] tabular-nums text-aip-muted"
          :datetime="alert.received_at"
          :title="alert.received_at"
        >
          {{ relative }}
        </time>
      </div>
      <div v-if="alert.detail" class="mt-0.5 truncate text-xs text-aip-muted">
        {{ alert.detail }}
      </div>
      <div v-if="alert.sensor_id" class="mt-0.5 font-mono text-[10px] text-aip-muted">
        {{ alert.sensor_id }}
      </div>
    </div>
  </article>
</template>
