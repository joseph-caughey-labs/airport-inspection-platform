import { describe, expect, it } from "vitest";
import { getContext, withContext } from "../../../packages/logger/src/index.js";

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
