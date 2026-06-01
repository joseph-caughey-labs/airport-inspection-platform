/**
 * Re-hydrate auth from localStorage on app start (T-504d).
 *
 * `.client.ts` keeps this off the server entirely — the auth state
 * lives in localStorage and is per-browser. Server-side rendering
 * would see no token regardless, so there's no point asking.
 */
import { useAuthStore } from "~/stores/auth";

export default defineNuxtPlugin(() => {
  const auth = useAuthStore();
  auth.restoreFromStorage();
});
