import { createRegistry } from "@aip/metrics";
import { describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../../../services/ws-broadcaster/src/channels/registry.js";
import {
  broadcastPresenceChange,
  buildPresenceMessage,
  PRESENCE_EVENT_TYPE,
  PRESENCE_SNAPSHOT_TYPE,
} from "../../../services/ws-broadcaster/src/presence/index.js";
import type {
  BroadcastClient,
  ClientRole,
} from "../../../services/ws-broadcaster/src/channels/types.js";

const AIRPORT = "11111111-2222-3333-4444-555555555555";

function reg() {
  return createRegistry({ service: "presence-test", collectDefault: false });
}

let connSeq = 0;
function makeClient(role: ClientRole = "viewer") {
  const send = vi.fn();
  const c: BroadcastClient = {
    role,
    send,
    close: vi.fn(),
    connection_id: `conn-${++connSeq}`,
    connected_at: "2026-05-28T10:00:00.000Z",
  };
  return { client: c, send };
}

describe("buildPresenceMessage", () => {
  it("emits a presence.snapshot envelope with count + subscribers", () => {
    const out = buildPresenceMessage(
      PRESENCE_SNAPSHOT_TYPE,
      AIRPORT,
      [
        { connection_id: "c1", role: "operator", connected_at: "2026-05-28T10:00:00.000Z" },
        { connection_id: "c2", role: "viewer", connected_at: "2026-05-28T10:01:00.000Z" },
      ],
      () => "2026-05-28T10:02:00.000Z",
    );
    const parsed = JSON.parse(out);
    expect(parsed.type).toBe("presence.snapshot");
    expect(parsed.schema_version).toBe("v1");
    expect(parsed.timestamp).toBe("2026-05-28T10:02:00.000Z");
    expect(parsed.payload.airport_id).toBe(AIRPORT);
    expect(parsed.payload.count).toBe(2);
    expect(parsed.payload.subscribers).toHaveLength(2);
    expect(parsed.payload.subscribers[0]).toEqual({
      connection_id: "c1",
      role: "operator",
      connected_at: "2026-05-28T10:00:00.000Z",
    });
  });

  it("emits a presence.changed envelope with the same shape", () => {
    const out = buildPresenceMessage(
      PRESENCE_EVENT_TYPE,
      AIRPORT,
      [],
      () => "2026-05-28T10:02:00.000Z",
    );
    const parsed = JSON.parse(out);
    expect(parsed.type).toBe("presence.changed");
    expect(parsed.payload.count).toBe(0);
    expect(parsed.payload.subscribers).toEqual([]);
  });
});

describe("ChannelRegistry.snapshot", () => {
  it("returns one entry per subscriber with connection_id + role + connected_at", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const a = makeClient("operator");
    const b = makeClient("viewer");
    r.subscribe(AIRPORT, a.client);
    r.subscribe(AIRPORT, b.client);
    const snap = r.snapshot(AIRPORT);
    expect(snap).toHaveLength(2);
    expect(snap.map((s) => s.role).sort()).toEqual(["operator", "viewer"]);
  });

  it("returns [] for unknown airport", () => {
    const r = new ChannelRegistry({ registry: reg() });
    expect(r.snapshot("99999999-9999-9999-9999-999999999999")).toEqual([]);
  });

  it("excludes detached subscribers", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    const b = makeClient();
    r.subscribe(AIRPORT, a.client);
    r.subscribe(AIRPORT, b.client);
    r.unsubscribe(AIRPORT, a.client);
    expect(r.snapshot(AIRPORT)).toHaveLength(1);
  });
});

describe("broadcastPresenceChange", () => {
  it("dispatches a presence.changed to every current subscriber", () => {
    const r = new ChannelRegistry({ registry: reg() });
    const a = makeClient();
    const b = makeClient();
    r.subscribe(AIRPORT, a.client);
    r.subscribe(AIRPORT, b.client);
    broadcastPresenceChange(r, AIRPORT, () => "2026-05-28T10:00:00.000Z");
    expect(a.send).toHaveBeenCalled();
    expect(b.send).toHaveBeenCalled();
    const sent = JSON.parse(a.send.mock.calls[0]?.[0] as string);
    expect(sent.type).toBe("presence.changed");
    expect(sent.payload.count).toBe(2);
  });

  it("no-op when nobody is subscribed", () => {
    const r = new ChannelRegistry({ registry: reg() });
    // Should not throw; nothing to assert on the send side.
    expect(() => broadcastPresenceChange(r, AIRPORT)).not.toThrow();
  });
});
