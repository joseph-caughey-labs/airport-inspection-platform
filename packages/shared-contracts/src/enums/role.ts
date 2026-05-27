import { z } from "zod";

/**
 * Platform roles. RBAC enforcement lands in T-504; the enum is shared
 * here so frontend and backend agree on the policy surface.
 */
export const Role = z.enum(["operator", "reviewer", "admin"]);
export type Role = z.infer<typeof Role>;
