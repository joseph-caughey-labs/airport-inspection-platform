import { decodeWsFrame, type DecodeResult } from "~/utils/ws-decoder";
import { nextReconnectDelay } from "~/utils/ws-reconnect";

export type WsConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface WsClientOptions {
  url: string;
  /** Server-side cursor (event_id) for resume on reconnect. */
  lastEventId?: () => string | undefined;
  /**
   * Access token to pass on the WS upgrade (T-504d). Read per
   * connect so a refresh between attempts picks up the new value.
   *
   * Browsers can't set arbitrary headers on a WebSocket upgrade, so
   * the token rides on `Sec-WebSocket-Protocol: bearer.<token>` —
   * the only header the `WebSocket(url, protocols)` constructor
   * exposes. The server (ws-broadcaster) reads either this
   * subprotocol or the `?access_token=` query string (T-504b).
   */
  token?: () => string | undefined | null;
  /** Called on every decoded frame outcome. */
  onFrame: (result: DecodeResult) => void;
  /** Connection-state changes (UI bindings live here). */
  onState: (state: WsConnectionState) => void;
  /** Override the WebSocket constructor (for tests). */
  WebSocketCtor?: typeof WebSocket;
  /** Pluggable timer + RNG (also for tests). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  randomFn?: () => number;
}

const DEFAULT_OPTS: Required<Pick<WsClientOptions, "setTimeoutFn" | "clearTimeoutFn">> = {
  setTimeoutFn: setTimeout,
  clearTimeoutFn: clearTimeout,
};

/**
 * Lightweight WS client: exponential-backoff reconnect, last_event_id
 * resume, dispose-able. Designed to be driven from a Vue component
 * with `onMounted` / `onBeforeUnmount` — the imperative lifecycle
 * (reconnect timers, socket listeners) lives here so the component
 * stays declarative.
 *
 * Resume protocol: when reconnecting, the URL gets `?last_event_id=`
 * appended if `lastEventId()` returns a value. T-210's server-side
 * `hydrateSince` does the rest.
 *
 * Not a Vue composable in the strict sense — exported as a class so
 * tests can drive it with a fake WebSocket. The `useAirportLiveStream`
 * composable in `composables/useAirportLiveStream.ts` is the Vue-aware
 * wrapper.
 */
export class WsClient {
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private disposed = false;
  private state: WsConnectionState = "disconnected";
  private readonly opts: WsClientOptions & typeof DEFAULT_OPTS;

  constructor(opts: WsClientOptions) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  start(): void {
    if (this.disposed) return;
    this.openOnce();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      this.opts.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // readyState values: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED.
    // Inline literals so this module doesn't reach for the WebSocket
    // global (it would be undefined under vitest/Node).
    if (this.socket && this.socket.readyState <= 1) {
      try {
        this.socket.close(1000, "client dispose");
      } catch {
        // ignore — best-effort close
      }
    }
    this.socket = undefined;
  }

  private setState(s: WsConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState(s);
  }

  private buildUrl(): string {
    const cursor = this.opts.lastEventId?.();
    if (!cursor) return this.opts.url;
    const sep = this.opts.url.includes("?") ? "&" : "?";
    return `${this.opts.url}${sep}last_event_id=${encodeURIComponent(cursor)}`;
  }

  private openOnce(): void {
    if (this.disposed) return;
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");

    const Ctor = this.opts.WebSocketCtor ?? WebSocket;
    const url = this.buildUrl();
    const token = this.opts.token?.() ?? null;
    const sock = token ? new Ctor(url, [`bearer.${token}`]) : new Ctor(url);
    this.socket = sock;

    sock.addEventListener("open", () => {
      this.attempt = 0;
      this.setState("connected");
    });

    sock.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : "";
      this.opts.onFrame(decodeWsFrame(raw));
    });

    const scheduleReconnect = (): void => {
      if (this.disposed) return;
      this.setState("reconnecting");
      const delay = nextReconnectDelay(this.attempt, { randomFn: this.opts.randomFn });
      this.attempt++;
      this.reconnectTimer = this.opts.setTimeoutFn(() => {
        this.reconnectTimer = undefined;
        this.openOnce();
      }, delay);
    };

    sock.addEventListener("close", () => {
      if (this.disposed) {
        this.setState("disconnected");
        return;
      }
      scheduleReconnect();
    });

    sock.addEventListener("error", () => {
      // Don't reconnect here — `close` always fires after `error`,
      // and we'd otherwise schedule two reconnects per failure.
    });
  }
}
