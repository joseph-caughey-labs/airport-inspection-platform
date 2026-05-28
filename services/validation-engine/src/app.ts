import { type Logger } from "@aip/logger";
import { type Registry } from "@aip/metrics";
import Fastify from "fastify";
import { z } from "zod";
import { runValidation } from "./orchestrator/index.js";

export interface BuildAppOptions {
  logger: Logger;
  registry: Registry;
}

const ValidateBody = z.object({
  submission_id: z.string().uuid().optional(),
  payload: z.unknown(),
});

export async function buildApp({ logger, registry }: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  app.post("/validate", async (req, reply) => {
    const parsed = ValidateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation_failed",
          message: "invalid /validate body",
          details: { issues: parsed.error.issues },
        },
      });
    }
    const opts = parsed.data.submission_id ? { submission_id: parsed.data.submission_id } : {};
    const run = await runValidation(parsed.data.payload, opts);
    return run;
  });

  return app;
}
