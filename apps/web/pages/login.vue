<script setup lang="ts">
import { ref } from "vue";
import { storeToRefs } from "pinia";
import { useAuthStore } from "~/stores/auth";

definePageMeta({
  // Skip the global auth middleware on the login page itself — the
  // whole point of this route is to *get* a session.
  auth: false,
  // Standalone screen — no app chrome (the header carries Sign-Out
  // which would be confusing pre-login).
  layout: false,
});

const auth = useAuthStore();
const { loading, error } = storeToRefs(auth);
const router = useRouter();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();

// Seeded users — keep the demo a one-click affair. Real deployments
// would have a password (and ideally an SSO step).
const SEEDED = [
  { email: "pat.operator@airport-ops.test", label: "Pat Operator", role: "operator" as const },
  { email: "rio.reviewer@airport-ops.test", label: "Rio Reviewer", role: "reviewer" as const },
  { email: "alex.admin@airport-ops.test", label: "Alex Admin", role: "admin" as const },
];

const email = ref("");

async function submit(value: string): Promise<void> {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return;
  try {
    const baseUrl = runtimeConfig.public["apiBaseUrl"] as string;
    await auth.login(trimmed, { baseUrl });
  } catch {
    // The store stamped `error` for the UI; nothing else to do here.
    return;
  }
  const next = typeof route.query["next"] === "string" ? route.query["next"] : "/";
  await router.replace(next);
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-aip-base text-aip-fg px-6">
    <div class="w-full max-w-md">
      <div class="mb-6 flex items-center justify-center gap-2">
        <span class="inline-block h-2 w-2 rounded-full bg-aip-accent" aria-hidden="true" />
        <span class="font-mono text-sm uppercase tracking-widest">Airport Inspection</span>
      </div>

      <form
        class="rounded border border-aip-border bg-aip-panel p-6"
        data-testid="login-form"
        @submit.prevent="submit(email)"
      >
        <label for="email" class="block font-mono text-xs uppercase tracking-widest text-aip-muted">
          Sign in
        </label>
        <input
          id="email"
          v-model="email"
          type="email"
          autocomplete="email"
          placeholder="email"
          required
          class="mt-2 block w-full rounded border border-aip-border bg-aip-base px-3 py-2 font-mono text-sm text-aip-fg focus:outline-none focus:ring-1 focus:ring-aip-accent"
          data-testid="login-email"
        />

        <button
          type="submit"
          :disabled="loading"
          class="mt-4 inline-flex w-full justify-center rounded border border-aip-accent bg-aip-accent/10 px-3 py-2 font-mono text-sm uppercase tracking-widest text-aip-fg hover:bg-aip-accent/20 disabled:opacity-50"
          data-testid="login-submit"
        >
          {{ loading ? "Signing in…" : "Sign in" }}
        </button>

        <p
          v-if="error"
          class="mt-3 font-mono text-xs text-red-400"
          data-testid="login-error"
          role="alert"
        >
          {{ error }}
        </p>

        <div class="mt-6">
          <p class="font-mono text-[10px] uppercase tracking-widest text-aip-muted">
            Demo accounts
          </p>
          <ul class="mt-2 space-y-1">
            <li v-for="u in SEEDED" :key="u.email">
              <button
                type="button"
                class="flex w-full items-center justify-between rounded border border-aip-border bg-aip-base px-3 py-2 font-mono text-xs text-aip-muted hover:text-aip-fg"
                :data-testid="`login-quickpick-${u.role}`"
                :disabled="loading"
                @click="
                  email = u.email;
                  void submit(u.email);
                "
              >
                <span>{{ u.label }}</span>
                <span class="text-[10px] uppercase tracking-widest">{{ u.role }}</span>
              </button>
            </li>
          </ul>
        </div>
      </form>
    </div>
  </div>
</template>
