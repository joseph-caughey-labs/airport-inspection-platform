/**
 * Platform RBAC policy. The single source of truth for which roles
 * may act on which resources. Both backend (Fastify `requireRole`)
 * and frontend (UI visibility) read from this file so a permission
 * change is one edit, not a coordinated rollout.
 *
 * Roles (see `enums/role.ts`):
 *   - `operator` — on-shift staff. Acknowledges + works incidents.
 *   - `reviewer` — owns HITL queue; can resolve / reject anything.
 *   - `admin`    — full access; manages users, runs migrations.
 *
 * Permissions are named verb_resource tuples to keep grep-ability
 * obvious. Add a new permission HERE first, then add a `requireRole`
 * call at the route. Tests in `__TEST__/unit/shared-contracts`
 * verify every permission lists at least one allowed role and that
 * the permission names are stable.
 */
import type { Role } from "../enums/role.js";

export type Permission =
  // Incident lifecycle
  | "incident.read"
  | "incident.create"
  | "incident.acknowledge"
  | "incident.assign"
  | "incident.start_progress"
  | "incident.resolve"
  | "incident.escalate"
  | "incident.archive"
  | "incident.reject"
  // Audit log
  | "audit.read"
  | "audit.verify"
  // Validation engine
  | "validation.run"
  | "validation.override" // HITL approve/deny override
  // Notification config
  | "notification.read"
  | "notification.replay_dlq"
  // Reference data (airports / runways / sensors / SOP thresholds)
  | "reference.read"
  // User management
  | "user.read"
  | "user.create"
  | "user.update_role"
  // Platform admin
  | "platform.admin";

/**
 * Roles allowed to perform each permission. `admin` is granted
 * everything implicitly by `isAllowed`; this map encodes the
 * non-admin distinctions.
 */
export const PERMISSION_POLICY: Readonly<Record<Permission, readonly Role[]>> = {
  // Read paths: operators + reviewers see everything in their queue.
  "incident.read": ["operator", "reviewer"],
  "audit.read": ["operator", "reviewer"],
  "audit.verify": ["reviewer"],
  "validation.run": ["operator", "reviewer"],
  "notification.read": ["operator", "reviewer"],
  "reference.read": ["operator", "reviewer"],
  "user.read": ["operator", "reviewer"],

  // Incident write paths: operator can drive the happy path,
  // reviewer can escalate/reject + override decisions.
  "incident.create": ["operator", "reviewer"],
  "incident.acknowledge": ["operator", "reviewer"],
  "incident.assign": ["operator", "reviewer"],
  "incident.start_progress": ["operator", "reviewer"],
  "incident.resolve": ["operator", "reviewer"],
  "incident.escalate": ["operator", "reviewer"],
  "incident.archive": ["reviewer"], // archive needs review approval
  "incident.reject": ["reviewer"],

  // HITL override is reviewer-only — the whole point of the HITL
  // gate.
  "validation.override": ["reviewer"],

  // DLQ replay is destructive (re-fires webhooks).
  "notification.replay_dlq": ["reviewer"],

  // User management + platform admin: admin-only.
  "user.create": [],
  "user.update_role": [],
  "platform.admin": [],
};

/**
 * True when `role` is allowed to perform `permission`. `admin` is
 * implicitly allowed everything.
 */
export function isAllowed(role: Role, permission: Permission): boolean {
  if (role === "admin") return true;
  return PERMISSION_POLICY[permission].includes(role);
}

/**
 * Returns every role that can perform `permission` (admin included).
 * Used by `requireRole(...rolesFor(permission))` so route files
 * don't hand-spell the role list.
 */
export function rolesFor(permission: Permission): Role[] {
  return ["admin", ...PERMISSION_POLICY[permission]];
}
