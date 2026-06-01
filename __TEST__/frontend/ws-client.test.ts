import { afterEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "~/composables/useWebSocket";

/**
 * Fake WebSocket — lets us drive open/message/close/error events
 * synchronously and verify the URL the client opened, including
 * the `last_event_id` query-string when applicable.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static lastUrl: string | undefined;
  static lastProtocols: string | string[] | undefined;
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = 0;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.instances.push(this);
    FakeSocket.lastUrl = url;
    FakeSocket.lastProtocols = protocols;
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = FakeSocket.CLOSED;
  }

  emitOpen(): void {
    this.readyState = FakeSocket.OPEN;
    for (const fn of this.listeners["open"] ?? []) fn(new Event("open"));
  }
  emitMessage(data: string): void {
    for (const fn of this.listeners["message"] ?? []) fn({ data } as MessageEvent);
  }
  emitClose(): void {
    this.readyState = FakeSocket.CLOSED;
    for (const fn of this.listeners["close"] ?? []) fn(new Event("close"));
  }
}

const FakeWsCtor = FakeSocket as unknown as typeof WebSocket;

afterEach(() => {
  FakeSocket.instances = [];
  FakeSocket.lastUrl = undefined;
  FakeSocket.lastProtocols = undefined;
});

describe("WsClient — lifecycle + dispatch", () => {
  it("opens the URL and reports connected on open", () => {
    const states: string[] = [];
    const c = new WsClient({
      url: "ws://test/ws/v1/airport/abc/events",
      onFrame: vi.fn(),
      onState: (s) => states.push(s),
      WebSocketCtor: FakeWsCtor,
    });
    c.start();
    FakeSocket.instances[0]!.emitOpen();
    expect(states).toEqual(["connecting", "connected"]);
    expect(FakeSocket.lastUrl).toBe("ws://test/ws/v1/airport/abc/events");
    c.dispose();
  });

  it("appends ?last_event_id when the cursor returns a value", () => {
    const c = new WsClient({
      url: "ws://test/events",
      onFrame: vi.fn(),
      onState: vi.fn(),
      WebSocketCtor: FakeWsCtor,
      lastEventId: () => "abc-123",
    });
    c.start();
    expect(FakeSocket.lastUrl).toBe("ws://test/events?last_event_id=abc-123");
    c.dispose();
  });

  it("decodes incoming frames and forwards via onFrame", () => {
    const onFrame = vi.fn();
    const c = new WsClient({
      url: "ws://test",
      onFrame,
      onState: vi.fn(),
      WebSocketCtor: FakeWsCtor,
    });
    c.start();
    FakeSocket.instances[0]!.emitOpen();
    FakeSocket.instances[0]!.emitMessage(
      JSON.stringify({
        type: "sensor.frame.captured",
        schema_version: "v1",
        timestamp: "2026-05-28T10:00:00.000Z",
        payload: {
          sensor_id: "CAM-1",
          sensor_type: "camera",
          frame_id: "F-1",
          captured_at: "2026-05-28T10:00:00.000Z",
          geo: { lat: 0, lng: 0 },
        },
      }),
    );
    expect(onFrame).toHaveBeenCalledTimes(1);
    const arg = onFrame.mock.calls[0]?.[0];
    expect(arg?.kind).toBe("message");
    c.dispose();
  });
});

describe("WsClient — auth subprotocol (T-504d)", () => {
  it("opens with `bearer.<token>` as the subprotocol when token returns a string", () => {
    const c = new WsClient({
      url: "ws://test/events",
      onFrame: vi.fn(),
      onState: vi.fn(),
      WebSocketCtor: FakeWsCtor,
      token: () => "access-1",
    });
    c.start();
    expect(FakeSocket.lastProtocols).toEqual(["bearer.access-1"]);
    c.dispose();
  });

  it("omits the protocols arg entirely when token returns null", () => {
    const c = new WsClient({
      url: "ws://test/events",
      onFrame: vi.fn(),
      onState: vi.fn(),
      WebSocketCtor: FakeWsCtor,
      token: () => null,
    });
    c.start();
    expect(FakeSocket.lastProtocols).toBeUndefined();
    c.dispose();
  });

  it("re-reads the token on reconnect so a refresh between attempts is observed", () => {
    let token: string | null = "access-1";
    let scheduled: (() => void) | undefined;
    const fakeSetTimeout = ((fn: () => void) => {
      scheduled = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const c = new WsClient({
      url: "ws://test/events",
      onFrame: vi.fn(),
      onState: vi.fn(),
      WebSocketCtor: FakeWsCtor,
      token: () => token,
      setTimeoutFn: fakeSetTimeout,
      randomFn: () => 0.5,
    });
    c.start();
    expect(FakeSocket.lastProtocols).toEqual(["bearer.access-1"]);
    FakeSocket.instances[0]!.emitOpen();
    FakeSocket.instances[0]!.emitClose();
    token = "access-2";
    scheduled?.();
    expect(FakeSocket.lastProtocols).toEqual(["bearer.access-2"]);
    c.dispose();
  });
});

describe("WsClient — reconnect", () => {
  it("transitions connecting → connected → reconnecting on socket close", () => {
    const states: string[] = [];
    const setTimeoutFn = vi.fn() as unknown as typeof setTimeout;
    const c = new WsClient({
      url: "ws://test",
      onFrame: vi.fn(),
      onState: (s) => states.push(s),
      WebSocketCtor: FakeWsCtor,
      setTimeoutFn,
      randomFn: () => 0.5,
    });
    c.start();
    FakeSocket.instances[0]!.emitOpen();
    FakeSocket.instances[0]!.emitClose();
    expect(states).toEqual(["connecting", "connected", "reconnecting"]);
    expect(setTimeoutFn).toHaveBeenCalledOnce();
    c.dispose();
  });

  it("after dispose, close transitions to disconnected and does NOT reconnect", () => {
    const states: string[] = [];
    const setTimeoutFn = vi.fn() as unknown as typeof setTimeout;
    const c = new WsClient({
      url: "ws://test",
      onFrame: vi.fn(),
      onState: (s) => states.push(s),
      WebSocketCtor: FakeWsCtor,
      setTimeoutFn,
    });
    c.start();
    FakeSocket.instances[0]!.emitOpen();
    c.dispose();
    FakeSocket.instances[0]!.emitClose();
    expect(states[states.length - 1]).toBe("disconnected");
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });

  it("on the second open uses the up-to-date last_event_id", () => {
    let cursor: string | undefined = undefined;
    let scheduled: (() => void) | undefined;
    const fakeSetTimeout = ((fn: () => void) => {
      scheduled = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const c = new WsClient({
      url: "ws://test",
      onFrame: vi.fn(),
      onState: vi.fn(),
      WebSocketCtor: FakeWsCtor,
      lastEventId: () => cursor,
      setTimeoutFn: fakeSetTimeout,
      randomFn: () => 0.5,
    });
    c.start();
    FakeSocket.instances[0]!.emitOpen();
    expect(FakeSocket.lastUrl).toBe("ws://test");

    // The "client" learned a cursor between sessions.
    cursor = "evt-77";
    FakeSocket.instances[0]!.emitClose();
    scheduled?.();
    expect(FakeSocket.lastUrl).toBe("ws://test?last_event_id=evt-77");
    c.dispose();
  });
});
