import { z } from "zod";
import { Role } from "../enums/role.js";

export const User = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: Role,
  organization: z.string().min(1).max(200),
  created_at: z.string().datetime(),
});
export type User = z.infer<typeof User>;
