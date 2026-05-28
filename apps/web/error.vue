<script setup lang="ts">
import type { NuxtError } from "#app";

defineProps<{ error: NuxtError }>();

const handleError = () => clearError({ redirect: "/" });
</script>

<template>
  <div class="min-h-screen bg-aip-base text-aip-fg flex items-center justify-center px-6">
    <div class="aip-card max-w-md w-full text-center space-y-4">
      <p class="font-mono text-xs uppercase tracking-widest text-aip-muted">
        error · {{ error.statusCode }}
      </p>
      <h1 class="text-lg font-semibold">{{ error.message || "Something went wrong" }}</h1>
      <button
        type="button"
        class="rounded-sm border border-aip-border bg-aip-panel px-4 py-2 text-sm font-medium hover:bg-aip-elevated focus-visible:outline-aip-accent"
        @click="handleError"
      >
        Return to Live Ops
      </button>
    </div>
  </div>
</template>
