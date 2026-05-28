import { type Logger } from "@aip/logger";
import { type RedisClient } from "@aip/redis-client";
import { type ConsumerHandler } from "./types.js";

export interface RedisSubscriberOptions {
  /** Dedicated subscriber Redis client (must NOT be reused for publish). */
  redis: RedisClient;
  logger: Logger;
}

/**
 * Routes ioredis pub/sub messages to registered handlers. Each
 * handler claims a single channel; the subscriber forwards every
 * message on that channel to the handler via the orchestrator.
 *
 * Per `@aip/redis-client` README, pub/sub requires a dedicated
 * connection — never pass the publish-side client here.
 */
export class RedisSubscriber {
  private readonly redis: RedisClient;
  private readonly logger: Logger;
  private readonly handlers = new Map<string, ConsumerHandler>();
  private dispatcher: ((handler: ConsumerHandler, raw: string) => Promise<void>) | undefined;
  private wired = false;

  constructor(opts: RedisSubscriberOptions) {
    this.redis = opts.redis;
    this.logger = opts.logger;
  }

  /** Register a handler. Idempotent for the same channel/name pair. */
  register(handler: ConsumerHandler): void {
    const existing = this.handlers.get(handler.channel);
    if (existing && existing.name !== handler.name) {
      throw new Error(`channel ${handler.channel} already owned by handler ${existing.name}`);
    }
    this.handlers.set(handler.channel, handler);
  }

  /**
   * Connect the routing function. The subscriber stays decoupled from
   * the orchestrator class — any dispatcher with the right signature
   * (e.g. tests using a mock) plugs in here.
   */
  setDispatcher(fn: (handler: ConsumerHandler, raw: string) => Promise<void>): void {
    this.dispatcher = fn;
  }

  /** Subscribe to every registered channel and wire the message handler. */
  async start(): Promise<void> {
    if (this.wired) return; // idempotent
    if (this.handlers.size === 0) {
      this.logger.warn("RedisSubscriber.start() with zero handlers — no-op");
      return;
    }
    if (!this.dispatcher) {
      throw new Error("RedisSubscriber.start() called before setDispatcher()");
    }

    const channels = Array.from(this.handlers.keys());
    await this.redis.subscribe(...channels);

    this.redis.on("message", (channel: string, message: string) => {
      const handler = this.handlers.get(channel);
      if (!handler) {
        this.logger.warn({ channel }, "received message on unhandled channel");
        return;
      }
      // Fire and forget — orchestrator owns concurrency.
      void this.dispatcher!(handler, message);
    });

    this.wired = true;
    this.logger.info({ channels }, "subscriber wired");
  }

  async stop(): Promise<void> {
    if (!this.wired) return;
    const channels = Array.from(this.handlers.keys());
    await this.redis.unsubscribe(...channels);
    this.redis.removeAllListeners("message");
    this.wired = false;
  }

  /** Test helper: trigger the dispatcher as if Redis emitted a message. */
  async simulateMessage(channel: string, raw: string): Promise<void> {
    const handler = this.handlers.get(channel);
    if (!handler || !this.dispatcher) return;
    await this.dispatcher(handler, raw);
  }
}
