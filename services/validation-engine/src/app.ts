import { correlationHook, type Logger } from "@aip/logger";
import { installMetrics, type Registry } from "@aip/metrics";
import { ValidationSubmissionRequest } from "@aip/shared-contracts";
import Fastify from "fastify";
import {
  createOrchestratorMetrics,
  type OrchestratorMetrics,
  runValidation,
} from "./orchestrator/index.js";

export interface BuildAppOptions {
  logger: Logger;
  registry: Registry;
  /**
   * Production default `true`: once real layers ship (T-406+) we stop
   * at the first failing layer — wasted CPU + cascading false
   * failures in the audit log otherwise. Tests pass `false` to assert
   * every layer ran.
   */
  shortCircuit?: boolean;
  /** Test seam — when omitted, metrics are wired off the registry. */
  metrics?: OrchestratorMetrics;
}

export async function buildApp({
  logger,
  registry,
  shortCircuit = true,
  metrics,
}: BuildAppOptions) {
  const app = Fastify({
    logger: { level: logger.level },
    disableRequestLogging: false,
  });

  app.addHook("onRequest", correlationHook());
  installMetrics({ app, registry });

  const orchestratorMetrics = metrics ?? createOrchestratorMetrics(registry);

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => ({ status: "ready" }));

  app.post("/validate", async (req, reply) => {
    const parsed = ValidationSubmissionRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "validation_failed",
          message: "invalid /validate body",
          details: { issues: parsed.error.issues },
        },
      });
    }
    const opts: Parameters<typeof runValidation>[1] = {
      shortCircuit,
      metrics: orchestratorMetrics,
    };
    if (parsed.data.submission_id) {
      opts.submission_id = parsed.data.submission_id;
    }
    const run = await runValidation(parsed.data.payload, opts);
    return run;
  });

  return app;
}
