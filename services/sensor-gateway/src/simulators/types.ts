import { type Logger } from "@aip/logger";
import { type RedisClient } from "@aip/redis-client";
import { type GeoPoint, type SensorType } from "@aip/shared-contracts";

/**
 * Context passed to every simulator on construction. Holds the
 * collaborators the simulator needs to publish frames and log.
 */
export interface SimulatorContext {
  redis: RedisClient;
  logger: Logger;
  /** Redis channel the simulator publishes to (e.g. "sensor.frame.captured"). */
  channel: string;
  /** Override clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Static config for an individual sensor instance.
 */
export interface SimulatorConfig {
  sensorId: string;
  sensorType: SensorType;
  airportId: string;
  location: GeoPoint;
  /** Emission rate in Hz. */
  hz: number;
}

/**
 * Common simulator contract. Each implementation (camera, lidar, gps,
 * imu, weather, perimeter) handles its own metadata shape but exposes
 * the same lifecycle.
 */
export interface Simulator {
  readonly sensorId: string;
  readonly sensorType: SensorType;
  start(): void;
  stop(): Promise<void>;
}
