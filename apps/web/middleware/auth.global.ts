/**
 * Global auth guard (T-504d). Routes that opt out set
 * `definePageMeta({ auth: false })` — currently just `/login`.
 *
 * Anything else without an authenticated session is bounced to
 * `/login?next=<originally-requested-path>` so the post-login
 * redirect lands the user where they were going.
 *
 * Why client-only check: tokens live in localStorage. On the server
 * we'd see no token even for an authenticated user, so we'd
 * infinite-redirect. Nuxt's auto-imported `process.client` keeps
 * this honest.
 */
import { useAuthStore } from "~/stores/auth";

export default defineNuxtRouteMiddleware((to) => {
  if (to.meta["auth"] === false) return;
  if (!import.meta.client) return;

  const auth = useAuthStore();
  if (auth.isAuthenticated) return;

  const next = to.fullPath !== "/" ? to.fullPath : undefined;
  return navigateTo(next ? { path: "/login", query: { next } } : { path: "/login" }, {
    replace: true,
  });
});
