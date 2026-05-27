# `@aip/db-schema`

PostgreSQL schema, migrations, and a programmatic runner for the platform's persistent state.

- **Drizzle ORM** schema definitions in `src/schema/`. Services import these for typed queries.
- **Hand-authored SQL migrations** in `src/migrations/`. Each numbered file is run exactly once and tracked in `_schema_migrations`.
- **`runMigrations(pool)`** — programmatic runner suitable for service startup.
- **`pnpm db:migrate`** — CLI that runs migrations against the configured database (uses `.env` at the repo root).

## Entities

The first migration (`0001_initial.sql`) creates six tables:

| Table          | Purpose                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `airports`     | Airport master data — ICAO/IATA codes, name, city, country, IANA timezone.                 |
| `runways`      | Per-airport runway records — designator (`09L`/`27R`), pairs, dimensions, surface, status. |
| `sensors`      | Per-airport sensors — `TYPE-LOCATION-INDEX` id, type, geolocation, status.                 |
| `users`        | Platform users — email, role (`operator` / `reviewer` / `admin`), organization.            |
| `incidents`    | Operational incidents — severity, status, airport/runway refs, idempotency_key.            |
| `audit_events` | Append-only audit log — hash-chained; `UPDATE` and `DELETE` revoked at the DB role level.  |

See [`docs/architecture/data-model.md`](../../docs/architecture/data-model.md) for the ER diagram and column-level rationale.

## Usage from a service

```ts
import { createPgPool } from "@aip/postgres-client";
import { runMigrations, schema } from "@aip/db-schema";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = createPgPool({
  /* env */
});
await runMigrations(pool);

const db = drizzle(pool, { schema });
const airports = await db.select().from(schema.airports);
```

## Running migrations manually

```bash
cp infrastructure/env/.env.example .env
docker compose up -d postgres
pnpm db:migrate
```

The runner is idempotent — already-applied migrations are skipped via the `_schema_migrations` ledger.

## Adding a new migration

1. Create `src/migrations/00NN_<concise-slug>.sql`.
2. Use **forward-only** patterns (no destructive ops without an expand/contract plan).
3. Audit-table mutations are forbidden — see ADR 0010.
4. Update the ER diagram in `docs/architecture/data-model.md` if entities change.
5. Run `pnpm db:migrate` against a dev DB and verify behavior before opening the PR.

## Why hand-authored SQL over `drizzle-kit generate`

For this stage of the project, hand-authored migrations are more legible and let us bundle in DB-level grant revocations (audit immutability) that `drizzle-kit` won't emit. Once the schema grows past ~10 entities, we may revisit and pair the two: Drizzle defines the shape, drizzle-kit handles boilerplate diffs, and a postscript SQL file enforces the security-relevant grants.
