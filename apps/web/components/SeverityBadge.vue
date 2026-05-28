<script setup lang="ts">
import { computed } from "vue";
import { SEVERITY_GLYPH, type AlertSeverity } from "~/types/alert";

const props = defineProps<{ severity: AlertSeverity; label?: boolean }>();

const SEV_STYLES: Record<AlertSeverity, { color: string; ring: string; text: string }> = {
  critical: { color: "bg-severity-critical", ring: "ring-severity-critical/40", text: "Critical" },
  high: { color: "bg-severity-high", ring: "ring-severity-high/40", text: "High" },
  medium: { color: "bg-severity-medium", ring: "ring-severity-medium/40", text: "Medium" },
  low: { color: "bg-severity-low", ring: "ring-severity-low/40", text: "Low" },
  info: { color: "bg-severity-info", ring: "ring-severity-info/40", text: "Info" },
};

const style = computed(() => SEV_STYLES[props.severity]);
const glyph = computed(() => SEVERITY_GLYPH[props.severity]);
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 ring-1"
    :class="[style.color, style.ring, 'text-aip-fg']"
    :title="style.text"
    :aria-label="`Severity: ${style.text}`"
  >
    <!-- Shape + position + color: severity must be discriminable
         without color. The glyph + `aria-label` carry the meaning. -->
    <span aria-hidden="true" class="font-mono text-[10px] leading-none">{{ glyph }}</span>
    <span v-if="label" class="font-mono text-[10px] uppercase tracking-widest">
      {{ style.text }}
    </span>
  </span>
</template>
