import { Registry as PromRegistry, collectDefaultMetrics } from "prom-client";

export type Registry = PromRegistry;

export interface RegistryOptions {
  service: string;
  /**
   * Collect Node process metrics (cpu, memory, event loop lag, etc.).
   * Default `true`. Set `false` for unit tests to keep output deterministic.
   */
  collectDefault?: boolean;
}

/**
 * Create the canonical service registry. One per service, at startup.
 * The `service` label is attached as a default label on every metric.
 */
export function createRegistry({ service, collectDefault = true }: RegistryOptions): Registry {
  const registry = new PromRegistry();
  registry.setDefaultLabels({ service });
  if (collectDefault) {
    collectDefaultMetrics({ register: registry });
  }
  return registry;
}
