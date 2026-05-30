import { createJwtSigner } from "@aip/auth-jwt";
import { createLogger } from "@aip/logger";
import { createRegistry } from "@aip/metrics";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const logger = createLogger({ service: "validation-engine" });
  const registry = createRegistry({ service: "validation-engine" });
  // Shares JWT_SECRET with api-gateway (T-504c). A future split
  // deployment would move auth behind a central service with
  // asymmetric (RS256/EdDSA) keys + a JWKS endpoint.
  const signer = createJwtSigner({
    secret: process.env["JWT_SECRET"] ?? "dev-only-secret-shared-with-api-gateway-32-bytes-min",
    issuer: "aip-api-gateway",
  });

  const app = await buildApp({ logger, registry, signer });
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
