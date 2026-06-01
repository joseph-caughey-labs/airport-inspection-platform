import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { createPgPool } from "@aip/postgres-client";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "reference-data" });
  const registry = createRegistry({ service: "reference-data" });
  const pool = createPgPool({
    host: process.env["POSTGRES_HOST"] ?? "postgres",
    port: Number(process.env["POSTGRES_PORT"] ?? 5432),
    user: process.env["POSTGRES_USER"] ?? "airport_ops",
    password: process.env["POSTGRES_PASSWORD"] ?? "",
    database: process.env["POSTGRES_DB"] ?? "airport_inspection",
  });
  const signer = createJwtSigner({
    secret: process.env["JWT_SECRET"] ?? "dev-only-secret-shared-with-api-gateway-32-bytes-min",
    issuer: "aip-api-gateway",
  });

  const app = await buildApp({ logger, pool, registry, signer });
  const port = Number(process.env["PORT"] ?? 3002);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "reference-data ready");

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
  console.error("reference-data fatal startup error:", err);
  process.exit(1);
});
