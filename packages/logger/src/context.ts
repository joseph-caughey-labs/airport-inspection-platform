import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface LogContext {
  request_id: string;
  correlation_id: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Read the current log context. Returns `undefined` outside any
 * `withContext` / `enterContext` scope.
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
 *
 * Use this when you have a single function whose entire async chain
 * needs the context (e.g. a job runner, a CLI command). For
 * middleware-style use where you need to *enter* a context and have
 * later code (in the same async chain but not inside your function)
 * see it, use `enterContext` instead.
 */
export function withContext<T>(ctx: Partial<LogContext>, fn: () => T): T {
  const next = mergeContext(ctx);
  return storage.run(next, fn);
}

/**
 * Enter a log context for the rest of the current async chain
 * without wrapping a function.
 *
 * Required for Fastify-style `onRequest` middleware, where the hook
 * doesn't *call* the next handler — it returns, and the framework
 * runs the next handler in the same async chain. `AsyncLocalStorage.run`
 * exits as soon as its callback returns, so `withContext` would not
 * propagate; `enterWith` keeps the store set for the rest of the
 * chain.
 *
 * Returns the resolved context (with any auto-generated ids) so the
 * caller can echo them back on the response.
 */
export function enterContext(ctx: Partial<LogContext>): LogContext {
  const next = mergeContext(ctx);
  storage.enterWith(next);
  return next;
}

function mergeContext(ctx: Partial<LogContext>): LogContext {
  const current = storage.getStore();
  return {
    request_id: ctx.request_id ?? current?.request_id ?? randomUUID(),
    correlation_id: ctx.correlation_id ?? current?.correlation_id ?? randomUUID(),
  };
}
