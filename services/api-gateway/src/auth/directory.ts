/**
 * In-memory user directory for the demo. The production path swaps
 * this for a Postgres-backed implementation behind the same
 * `UserDirectory` interface — no callers need to change.
 *
 * The seed list is hand-curated to match `data/seed/users.json` so
 * a fresh dev environment can `POST /auth/login` against any of the
 * three roles without a DB connection.
 */
import { Role } from "@aip/shared-contracts";
import type { DirectoryUser, UserDirectory } from "../routes/auth.js";

/**
 * Mirror of `data/seed/users.json`. Inline here so api-gateway
 * doesn't need to read the file at boot — the file is the source
 * of truth for db:seed; this is the in-memory equivalent.
 */
const SEEDED: DirectoryUser[] = [
  {
    id: "33333333-1111-1111-1111-000000000001",
    email: "pat.operator@airport-ops.test",
    name: "Pat Operator",
    role: Role.parse("operator"),
  },
  {
    id: "33333333-1111-1111-1111-000000000002",
    email: "rio.reviewer@airport-ops.test",
    name: "Rio Reviewer",
    role: Role.parse("reviewer"),
  },
  {
    id: "33333333-1111-1111-1111-000000000003",
    email: "alex.admin@airport-ops.test",
    name: "Alex Admin",
    role: Role.parse("admin"),
  },
];

export function createInMemoryDirectory(extra: DirectoryUser[] = []): UserDirectory {
  const byEmail = new Map<string, DirectoryUser>();
  const byId = new Map<string, DirectoryUser>();
  for (const u of [...SEEDED, ...extra]) {
    byEmail.set(u.email.toLowerCase(), u);
    byId.set(u.id, u);
  }
  return {
    async findByEmail(email) {
      return byEmail.get(email.toLowerCase()) ?? null;
    },
    async findById(id) {
      return byId.get(id) ?? null;
    },
  };
}
