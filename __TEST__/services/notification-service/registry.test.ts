/**
 * ChannelRegistry tests (T-413).
 *
 * Verifies fan-out semantics: every applicable channel runs in
 * parallel, skipped channels still surface a `status="skipped"`
 * row so /deliveries shows the full picture, and the ring buffer
 * caps recent deliveries.
 */
import { describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../../../services/notification-service/src/channels/registry.js";
import type {
  DeliveryResult,
  NotificationChannel,
  NotificationEvent,
} from "../../../services/notification-service/src/channels/types.js";

function event(id = "e-1"): NotificationEvent {
  return {
    event_id: id,
    event_type: "incident.transitioned",
    subject_id: "incident-1",
    source: "incident-service",
    occurred_at: "2026-05-29T10:00:00.000Z",
    payload: {},
  };
}

function fakeChannel(name: string, applies = true): NotificationChannel & { delivered: number } {
  return {
    name,
    delivered: 0,
    appliesTo: () => applies,
    deliver: vi.fn(async (e: NotificationEvent): Promise<DeliveryResult> => {
      return {
        channel: name,
        event_id: e.event_id,
        status: "delivered",
        attempts: 1,
        completed_at: "2026-05-29T10:00:00.000Z",
      };
    }),
  };
}

describe("ChannelRegistry.dispatch", () => {
  it("delivers to every applicable channel and records skipped ones", async () => {
    const a = fakeChannel("a", true);
    const b = fakeChannel("b", false);
    const c = fakeChannel("c", true);
    const reg = new ChannelRegistry({ channels: [a, b, c] });
    const results = await reg.dispatch(event());
    expect(results.find((r) => r.channel === "a")?.status).toBe("delivered");
    expect(results.find((r) => r.channel === "b")?.status).toBe("skipped");
    expect(results.find((r) => r.channel === "c")?.status).toBe("delivered");
    expect(a.deliver).toHaveBeenCalledOnce();
    expect(b.deliver).not.toHaveBeenCalled();
    expect(c.deliver).toHaveBeenCalledOnce();
  });

  it("fires channels in parallel (Promise.all under the hood)", async () => {
    let resolveA: () => void = () => {};
    let resolveB: () => void = () => {};
    const slow = (resolveRef: (cb: () => void) => void): NotificationChannel => ({
      name: "slow",
      appliesTo: () => true,
      deliver: () =>
        new Promise<DeliveryResult>((resolve) => {
          resolveRef(() =>
            resolve({
              channel: "slow",
              event_id: "x",
              status: "delivered",
              attempts: 1,
              completed_at: "x",
            }),
          );
        }),
    });
    const reg = new ChannelRegistry({
      channels: [
        slow((cb) => {
          resolveA = cb;
        }),
        slow((cb) => {
          resolveB = cb;
        }),
      ],
    });
    const dispatched = reg.dispatch(event());
    // Both should be in flight before either resolves.
    resolveB();
    resolveA();
    const results = await dispatched;
    expect(results).toHaveLength(2);
  });

  it("keeps the ring buffer bounded at recentLimit", async () => {
    const ch = fakeChannel("a", true);
    const reg = new ChannelRegistry({ channels: [ch], recentLimit: 3 });
    await reg.dispatch(event("e-1"));
    await reg.dispatch(event("e-2"));
    await reg.dispatch(event("e-3"));
    await reg.dispatch(event("e-4"));
    expect(reg.recentDeliveries).toHaveLength(3);
    // Most-recent first
    expect(reg.recentDeliveries[0]?.event_id).toBe("e-4");
  });

  it("status() lists every configured channel", () => {
    const reg = new ChannelRegistry({
      channels: [fakeChannel("in_app"), fakeChannel("webhook"), fakeChannel("email")],
    });
    expect(reg.status().map((c) => c.name)).toEqual(["in_app", "webhook", "email"]);
  });
});
