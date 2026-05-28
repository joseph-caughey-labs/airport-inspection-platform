import { randomUUID } from "node:crypto";
import { type SensorFrameEvent } from "@aip/shared-contracts";
import { type Simulator, type SimulatorConfig, type SimulatorContext } from "./types.js";

export interface CameraSimulatorOptions extends SimulatorConfig {
  /** Frame width in pixels. Default 1920. */
  width?: number;
  /** Frame height in pixels. Default 1080. */
  height?: number;
  /**
   * Optional reference to a static fixture image consumed by AI in
   * Phase 3. Phase 1/2 has no real frame bytes — just metadata.
   */
  fixtureRef?: string;
}

/**
 * Camera sensor simulator. Emits a SensorFrameEvent on each tick at
 * the configured Hz. Publishes are awaited individually with a small
 * timeout so a slow Redis never blocks the tick loop; failures are
 * logged and the frame is dropped (backpressure-safe per the brief).
 */
export class CameraSimulator implements Simulator {
  readonly sensorId: string;
  readonly sensorType = "camera" as const;

  private readonly cfg: CameraSimulatorOptions;
  private readonly ctx: SimulatorContext;
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | undefined;
  private frameCounter = 0;

  constructor(cfg: CameraSimulatorOptions, ctx: SimulatorContext) {
    this.sensorId = cfg.sensorId;
    this.cfg = cfg;
    this.ctx = ctx;
    this.clock = ctx.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined) return; // idempotent
    const intervalMs = Math.max(1, Math.floor(1000 / this.cfg.hz));
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Build and publish one frame. Exposed for deterministic tests. */
  async tick(): Promise<void> {
    const now = new Date(this.clock()).toISOString();
    this.frameCounter++;
    const frameId = `${this.sensorId}-${this.frameCounter.toString().padStart(8, "0")}`;
    const event: SensorFrameEvent = {
      event_id: randomUUID(),
      event_type: "sensor.frame.captured",
      schema_version: "v1",
      source: { service: "sensor-gateway" },
      timestamp: now,
      idempotency_key: `frame:${frameId}`,
      payload: {
        sensor_id: this.sensorId,
        sensor_type: "camera",
        frame_id: frameId,
        captured_at: now,
        geo: this.cfg.location,
        metadata: {
          width: this.cfg.width ?? 1920,
          height: this.cfg.height ?? 1080,
          ...(this.cfg.fixtureRef ? { fixture_ref: this.cfg.fixtureRef } : {}),
        },
      },
    };

    try {
      await this.ctx.redis.publish(this.ctx.channel, JSON.stringify(event));
    } catch (err) {
      // Backpressure-safe: drop the frame, log loudly, keep ticking.
      // Retry policies belong at the Redis client; we surface the loss.
      this.ctx.logger.warn(
        {
          sensor_id: this.sensorId,
          frame_id: frameId,
          err: err instanceof Error ? err.message : String(err),
        },
        "sensor frame publish failed; dropping",
      );
    }
  }
}
