import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "validation-engine" });
  const registry = createRegistry({ service: "validation-engine" });

  const app = await buildApp({ logger, registry });
  const port = Number(process.env["PORT"] ?? 3009);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "validation-engine ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("validation-engine fatal startup error:", err);
  process.exit(1);
});
