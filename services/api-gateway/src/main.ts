import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "api-gateway" });
  const registry = createRegistry({ service: "api-gateway" });

  const app = await buildApp({ logger, registry });
  const port = Number(process.env["PORT"] ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "api-gateway ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("api-gateway fatal startup error:", err);
  process.exit(1);
});
