import { createRegistry } from "@aip/metrics";
import { describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../../../services/ws-broadcaster/src/channels/registry.js";
import type {
  BroadcastClient,
  ClientRole,
} from "../../../services/ws-broadcaster/src/channels/types.js";

function reg() {
  return createRegistry({ service: "registry-test", collectDefault: false });
}

let connIdSeq = 0;
function makeClient(role: ClientRole = "viewer") {
  const send = vi.fn();
  const close = vi.fn();
  const c: BroadcastClient = {
    role,
    send,
    close,
    connection_id: `conn-${++connIdSeq}`,
    connected_at: "2026-05-28T10:00:00.000Z",
  };
  return { client: c, send, close };
}

const AIRPORT = "11111111-2222-3333-4444-555555555555";

describe("ChannelRegistry — subscribe / unsubscribe", () => {
  it("tracks subscriber count per airport", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    const b = makeClient();
    r.subscribe(AIRPORT, a.client);
    r.subscribe(AIRPORT, b.client);
    expect(r.subscriberCount(AIRPORT)).toBe(2);
    r.unsubscribe(AIRPORT, a.client);
    expect(r.subscriberCount(AIRPORT)).toBe(1);
  });

  it("subscribe is idempotent for the same client", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    r.subscribe(AIRPORT, a.client);
    r.subscribe(AIRPORT, a.client);
    expect(r.subscriberCount(AIRPORT)).toBe(1);
  });

  it("airport bucket is cleaned up when last subscriber leaves", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    r.subscribe(AIRPORT, a.client);
    r.unsubscribe(AIRPORT, a.client);
    expect(r.subscriberCount(AIRPORT)).toBe(0);
  });
});

describe("ChannelRegistry — dispatch", () => {
  it("delivers payload to every subscriber on the airport", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    const b = makeClient();
    r.subscribe(AIRPORT, a.client);
    r.subscribe(AIRPORT, b.client);
    const result = r.dispatch(AIRPORT, "sensor.frame.captured", "payload");
    expect(result.delivered).toBe(2);
    expect(a.send).toHaveBeenCalledWith("payload");
    expect(b.send).toHaveBeenCalledWith("payload");
  });

  it("does not deliver across airports", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    r.subscribe(AIRPORT, a.client);
    const other = "99999999-9999-9999-9999-999999999999";
    const result = r.dispatch(other, "sensor.frame.captured", "x");
    expect(result.delivered).toBe(0);
    expect(a.send).not.toHaveBeenCalled();
  });

  it("survives a single send() throwing without dropping siblings", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const bad = makeClient();
    bad.send.mockImplementation(() => {
      throw new Error("socket dead");
    });
    const good = makeClient();
    r.subscribe(AIRPORT, bad.client);
    r.subscribe(AIRPORT, good.client);
    const result = r.dispatch(AIRPORT, "sensor.frame.captured", "x");
    expect(result.delivered).toBe(1);
    expect(good.send).toHaveBeenCalled();
  });

  it("honors a custom ClientFilter that denies based on role", () => {
    const r = new ChannelRegistry({
      registry: reg(),
      filter: { allow: (role) => role !== "viewer" },
    });
    const viewer = makeClient("viewer");
    const operator = makeClient("operator");
    r.subscribe(AIRPORT, viewer.client);
    r.subscribe(AIRPORT, operator.client);
    const result = r.dispatch(AIRPORT, "sensor.frame.captured", "x");
    expect(result.delivered).toBe(1);
    expect(viewer.send).not.toHaveBeenCalled();
    expect(operator.send).toHaveBeenCalled();
  });

  it("emits subscribers gauge + dispatched counter", async () => {
    const registry = reg();
    const r = new ChannelRegistry({ registry });
    const a = makeClient();
    r.subscribe(AIRPORT, a.client);
    r.dispatch(AIRPORT, "sensor.frame.captured", "x");
    const text = await registry.metrics();
    expect(text).toMatch(/ws_broadcaster_subscribers[^\n]*airport="11111111/);
    expect(text).toMatch(/ws_broadcaster_dispatched_total[^\n]*airport="11111111/);
  });
});
