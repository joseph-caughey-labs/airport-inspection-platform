/**
 * Reactive RBAC gate. Returns a `ComputedRef<boolean>` that flips
 * true when the current auth role is allowed to perform `perm`
 * per `@aip/shared-contracts`'s policy matrix.
 *
 * The matrix is the same one the backend's `requireRole(...rolesFor(perm))`
 * reads from, so a `usePermission("incident.archive")` hide on a
 * button matches a 403 from incident-service exactly.
 *
 * Example:
 *
 *   const canArchive = usePermission("incident.archive");
 *   <button v-if="canArchive" ...>Archive</button>
 */
import { isAllowed, type Permission } from "@aip/shared-contracts";
import { computed, type ComputedRef } from "vue";
import { useAuthStore } from "~/stores/auth";

export function usePermission(perm: Permission): ComputedRef<boolean> {
  const auth = useAuthStore();
  return computed(() => {
    if (!auth.role) return false;
    return isAllowed(auth.role, perm);
  });
}
