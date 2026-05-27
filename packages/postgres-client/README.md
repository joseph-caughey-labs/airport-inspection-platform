# `@aip/postgres-client`

PostgreSQL client wrapper for every Node/TS service that talks to Postgres. Built on [node-postgres (`pg`)](https://node-postgres.com/), with three additions on top:

1. **`createPgPool(...)`** — `Pool` factory with safe-by-default timeouts and sized limits.
2. **`withTransaction(pool, fn)`** — automatic `BEGIN` / `COMMIT` / `ROLLBACK`. Throws ⇒ rollback. Returns ⇒ commit.
3. **`checkHealth(pool)`** — readiness probe returning `{ healthy, latency_ms }`. Use in service `/health` endpoints.

The **migration runner** is a separate concern that lands in T-105.

## Usage

```ts
import { createPgPool, withTransaction, checkHealth } from "@aip/postgres-client";

const pool = createPgPool({
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? "airport_ops",
  password: process.env.POSTGRES_PASSWORD ?? "",
  database: process.env.POSTGRES_DB ?? "airport_inspection",
});

// Simple query
const { rows } = await pool.query<{ id: string }>("SELECT id FROM airports WHERE icao_code = $1", [
  "KSFO",
]);

// Transaction
await withTransaction(pool, async (client) => {
  await client.query("INSERT INTO incidents (...) VALUES (...)");
  await client.query("INSERT INTO audit_events (...) VALUES (...)");
});

// Health probe
const health = await checkHealth(pool);
// { healthy: true, latency_ms: 4 }
```

## Defaults

| Setting                           | Default | Why                                                         |
| --------------------------------- | ------- | ----------------------------------------------------------- |
| `max` (pool size)                 | 10      | Reasonable for a single-instance service.                   |
| `idleTimeoutMillis`               | 30_000  | Drop idle connections after 30s to free DB resources.       |
| `connectionTimeoutMillis`         | 5_000   | Fail-fast on DB unavailability instead of hanging requests. |
| `statement_timeout` (server-side) | 30_000  | Kill runaway queries after 30s.                             |

Override any of these per-pool when needed.

## Transaction semantics

`withTransaction` uses a dedicated client checked out from the pool. The client is released automatically (no manual `release()` calls). Nested `withTransaction` calls within the same async scope are flagged in tests but allowed — they degrade to **savepoints** in a future iteration (not yet implemented).

## Migration runner

Schema migrations are owned by **T-105**. This package will gain a `runMigrations()` helper there. For now, schema lives in `init.sql` for the demo and via this client's `query()` for ad-hoc setup.
