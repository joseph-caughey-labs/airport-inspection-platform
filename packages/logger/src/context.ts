import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface LogContext {
  request_id: string;
  correlation_id: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Read the current log context. Returns `undefined` outside any
 * `withContext` scope.
 */
export function getContext(): LogContext | undefined {
  return storage.getStore();
}

/**
 * Run `fn` inside a log context. Any logger calls (or nested
 * `withContext` calls) inside `fn` will see the ids.
 *
 * Missing ids are generated as UUIDv4. Inheriting from an outer
 * context preserves whichever id was already present.
 */
export function withContext<T>(ctx: Partial<LogContext>, fn: () => T): T {
  const current = storage.getStore();
  const next: LogContext = {
    request_id: ctx.request_id ?? current?.request_id ?? randomUUID(),
    correlation_id: ctx.correlation_id ?? current?.correlation_id ?? randomUUID(),
  };
  return storage.run(next, fn);
}
