import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createPgPool } from "@aip/postgres-client";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "incident-service" });
  const registry = createRegistry({ service: "incident-service" });
  const pool = createPgPool({
    host: process.env["POSTGRES_HOST"] ?? "postgres",
    port: Number(process.env["POSTGRES_PORT"] ?? 5432),
    user: process.env["POSTGRES_USER"] ?? "airport_ops",
    password: process.env["POSTGRES_PASSWORD"] ?? "",
    database: process.env["POSTGRES_DB"] ?? "airport_inspection",
  });

  const app = await buildApp({ logger, pool, registry });
  const port = Number(process.env["PORT"] ?? 3006);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "incident-service ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("incident-service fatal startup error:", err);
  process.exit(1);
});
