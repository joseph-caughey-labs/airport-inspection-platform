# `@aip/shared-contracts`

Cross-service contracts for the Airport Inspection Platform. Every domain entity, enum, event envelope, API DTO, WebSocket message, and error code lives here once.

**Rule of thumb**: if two services exchange a type, it lives in this package.

## Subpath exports

| Import path | What's there |
|---|---|
| `@aip/shared-contracts` | Everything (barrel) |
| `@aip/shared-contracts/enums` | `Severity`, `IncidentStatus`, `SensorType`, `Role`, `DetectionClass` |
| `@aip/shared-contracts/domain` | `Airport`, `Runway`, `Sensor`, `GeoPoint`, `User` |
| `@aip/shared-contracts/events` | `EventEnvelope` (base for all internal events) |
| `@aip/shared-contracts/api` | `ErrorResponse`, `PaginationQuery`, `PaginatedResponse` |
| `@aip/shared-contracts/ws` | `WsMessage` envelope |
| `@aip/shared-contracts/errors` | Canonical `ErrorCode` constants |

## Pattern

Every export is a **Zod schema** with a TypeScript type inferred from it:

```ts
import { z } from "zod";

export const Severity = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof Severity>;
```

This gives both runtime validation (`Severity.parse(value)`) and compile-time types in one definition. No drift between schema and type.

## Adding a new contract

1. Define the Zod schema in the appropriate subfolder.
2. Export both the schema (value) and the inferred type using the same name (TypeScript allows this — they live in different namespaces).
3. Add a test in `__TEST__/unit/contracts/` covering happy parse + at least one reject case.
4. Re-export from the subfolder's `index.ts`.

## Tests

Tests live in `__TEST__/unit/contracts/` (per the brief's centralized test mandate). Run from this package:

```bash
pnpm --filter @aip/shared-contracts test
```
