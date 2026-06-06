/**
 * Per-file skip-guard. Each scenario calls `await gatedDescribe()` at
 * module top level; if the stack isn't reachable it returns `describe.skip`
 * so the whole file no-ops with a logged reason instead of hanging on a
 * dead Redis/WS. The probe is cached across files (single fork).
 */
import { describe } from "vitest";
import { probeStack } from "../src/harness/index.js";

export async function gatedDescribe(): Promise<typeof describe | typeof describe.skip> {
  const { up, reason } = await probeStack();
  if (!up) {
    // eslint-disable-next-line no-console -- intentional operator-facing skip notice
    console.warn(`[load] SKIP — ${reason}`);
    return describe.skip;
  }
  return describe;
}
