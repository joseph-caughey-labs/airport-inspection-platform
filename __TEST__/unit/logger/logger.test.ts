import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PATHS,
  createLogger,
  withContext,
  type Logger,
} from "../../../packages/logger/src/index.js";

/**
 * Capture log output by piping through an in-memory writable. Uses
 * only the public `@aip/logger` surface — no direct pino import.
 */
function makeCaptured(redact?: readonly string[]): {
  log: Logger;
  lines: () => Record<string, unknown>[];
} {
  const buf: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      buf.push(chunk.toString());
      cb();
    },
  });
  const log = createLogger({
    service: "test-service",
    level: "trace",
    redact,
    destination: dest,
  });
  return {
    log,
    lines: () =>
      buf
        .join("")
        .split("\n")
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("returns a logger with the service binding", () => {
    const { log, lines } = makeCaptured();
    log.info("ping");
    expect(lines()[0]).toMatchObject({ service: "test-service", msg: "ping" });
  });

  it("defaults to level=info", () => {
    const log = createLogger({ service: "unit-test" });
    expect(log.level).toBe("info");
  });

  it("honors level option", () => {
    const log = createLogger({ service: "unit-test", level: "debug" });
    expect(log.level).toBe("debug");
  });

  it("emits ISO timestamps", () => {
    const { log, lines } = makeCaptured();
    log.info("ping");
    expect(lines()[0]?.["time"]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("mixin context propagation", () => {
  it("attaches withContext ids to every log line within scope", () => {
    const { log, lines } = makeCaptured();
    withContext({ request_id: "req-1", correlation_id: "corr-1" }, () => {
      log.info("inside");
    });
    log.info("outside");
    const entries = lines();
    expect(entries[0]).toMatchObject({
      msg: "inside",
      request_id: "req-1",
      correlation_id: "corr-1",
    });
    expect(entries[1]?.["request_id"]).toBeUndefined();
    expect(entries[1]?.["correlation_id"]).toBeUndefined();
  });
});

describe("redaction", () => {
  it("redacts default sensitive fields", () => {
    const { log, lines } = makeCaptured();
    log.info({ password: "p4ssw0rd", username: "alice" }, "login");
    const [entry] = lines();
    expect(entry?.["password"]).toBe("[REDACTED]");
    expect(entry?.["username"]).toBe("alice");
  });

  it("redacts nested authorization headers", () => {
    const { log, lines } = makeCaptured();
    log.info({ req: { headers: { authorization: "Bearer xyz" } } }, "req");
    const [entry] = lines();
    const req = entry?.["req"] as { headers: { authorization: string } };
    expect(req.headers.authorization).toBe("[REDACTED]");
  });

  it("honors caller-supplied redaction list", () => {
    const { log, lines } = makeCaptured(["secret_thing"]);
    log.info({ secret_thing: "boo", password: "kept-visible" }, "extra");
    const [entry] = lines();
    expect(entry?.["secret_thing"]).toBe("[REDACTED]");
    // `password` is NOT in caller's list, so it should pass through.
    expect(entry?.["password"]).toBe("kept-visible");
  });
});

describe("DEFAULT_REDACTION_PATHS", () => {
  it("includes the common credential fields", () => {
    expect(DEFAULT_REDACTION_PATHS).toContain("password");
    expect(DEFAULT_REDACTION_PATHS).toContain("token");
    expect(DEFAULT_REDACTION_PATHS).toContain("authorization");
    expect(DEFAULT_REDACTION_PATHS).toContain("req.headers.authorization");
  });
});
