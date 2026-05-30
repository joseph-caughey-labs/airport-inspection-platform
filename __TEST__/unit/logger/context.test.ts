import { describe, expect, it } from "vitest";
import { enterContext, getContext, withContext } from "../../../packages/logger/src/index.js";
import { AsyncLocalStorage } from "node:async_hooks";

describe("withContext", () => {
  it("returns undefined outside any context scope", () => {
    expect(getContext()).toBeUndefined();
  });

  it("populates request_id and correlation_id inside the scope", () => {
    withContext({}, () => {
      const ctx = getContext();
      expect(ctx).toBeDefined();
      expect(ctx?.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(ctx?.correlation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it("uses caller-supplied ids when provided", () => {
    withContext({ request_id: "req-abc", correlation_id: "corr-xyz" }, () => {
      const ctx = getContext();
      expect(ctx?.request_id).toBe("req-abc");
      expect(ctx?.correlation_id).toBe("corr-xyz");
    });
  });

  it("inherits ids from the outer scope when nested", () => {
    withContext({ correlation_id: "outer-corr" }, () => {
      withContext({ request_id: "inner-req" }, () => {
        const ctx = getContext();
        expect(ctx?.request_id).toBe("inner-req");
        expect(ctx?.correlation_id).toBe("outer-corr");
      });
    });
  });

  it("does not leak context to sibling scopes", () => {
    withContext({ request_id: "scope-a" }, () => {
      expect(getContext()?.request_id).toBe("scope-a");
    });
    expect(getContext()).toBeUndefined();
  });

  it("propagates across awaited async boundaries", async () => {
    await withContext({ request_id: "async-req" }, async () => {
      await new Promise((r) => setTimeout(r, 0));
      expect(getContext()?.request_id).toBe("async-req");
      await new Promise((r) => setTimeout(r, 0));
      expect(getContext()?.request_id).toBe("async-req");
    });
  });

  it("returns the value of the inner function", () => {
    const result = withContext({}, () => 42);
    expect(result).toBe(42);
  });
});

describe("enterContext", () => {
  it("sets the context for the rest of the current async chain", async () => {
    // Wrap in an isolated AsyncLocalStorage entry so the enterWith
    // call doesn't leak across tests.
    const isolation = new AsyncLocalStorage<undefined>();
    await isolation.run(undefined, async () => {
      enterContext({ request_id: "enter-1", correlation_id: "corr-1" });
      const ctx = getContext();
      expect(ctx?.request_id).toBe("enter-1");
      expect(ctx?.correlation_id).toBe("corr-1");
      // Survives an awaited async boundary in the same chain.
      await new Promise((r) => setTimeout(r, 0));
      expect(getContext()?.request_id).toBe("enter-1");
    });
  });

  it("returns the resolved context (auto-generated ids when missing)", async () => {
    const isolation = new AsyncLocalStorage<undefined>();
    await isolation.run(undefined, async () => {
      const ctx = enterContext({});
      expect(ctx.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(ctx.correlation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it("inherits the outer correlation_id when only request_id is supplied", async () => {
    const isolation = new AsyncLocalStorage<undefined>();
    await isolation.run(undefined, async () => {
      enterContext({ correlation_id: "shared-corr" });
      const inner = enterContext({ request_id: "inner-req" });
      expect(inner.correlation_id).toBe("shared-corr");
      expect(inner.request_id).toBe("inner-req");
    });
  });
});
