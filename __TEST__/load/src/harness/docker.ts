/**
 * Docker fault-injection lever.
 *
 * The platform has no in-process chaos/latency env hooks (that would be
 * production code a load suite shouldn't add), so resilience faults are
 * injected at the container boundary instead — the cleanest lever that
 * touches no service code:
 *
 *   - `stop` / `start`  → hard outage + recovery (Redis, AI service)
 *   - `pause` / `unpause` → freeze a container (≈ infinite latency /
 *                           stall) without losing its state (Postgres)
 *   - `restart`         → process restart + recovery (event-pipeline)
 *
 * Every helper is a thin wrapper over `docker <verb> <container>`. If
 * the docker CLI isn't available the call rejects, and the scenario's
 * guard converts that into a clean skip rather than a hang.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function docker(verb: string, container: string): Promise<void> {
  await run("docker", [verb, container], { timeout: 30_000 });
}

export const fault = {
  stop: (c: string) => docker("stop", c),
  start: (c: string) => docker("start", c),
  pause: (c: string) => docker("pause", c),
  unpause: (c: string) => docker("unpause", c),
  restart: (c: string) => docker("restart", c),
};

/**
 * Run `body` with a container faulted, guaranteeing restoration even if
 * `body` throws. `down`/`up` are the inject/restore verbs (e.g.
 * stop/start or pause/unpause).
 */
export async function withFault(
  container: string,
  down: (c: string) => Promise<void>,
  up: (c: string) => Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  await down(container);
  try {
    await body();
  } finally {
    await up(container).catch(() => {
      /* best-effort restore; a leaked paused container is surfaced by the next run's stack probe */
    });
  }
}
