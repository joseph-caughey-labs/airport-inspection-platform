import { createLogger } from "@aip/logger";
import { buildChannelName, createRedis } from "@aip/redis-client";
import { buildApp } from "./app.js";
import { CameraSimulator, SimulatorRegistry } from "./simulators/index.js";

/**
 * Phase 2 baseline camera fleet. Three cameras across the two seeded
 * airports. Sensor ids match the rows in `data/seed/sensors.json` so
 * downstream consumers (event-pipeline, validation-engine) can
 * correlate published frames against the source-of-truth registry.
 *
 * T-202/T-203 add LiDAR/GPS/IMU/weather simulators alongside these.
 */
const BASELINE_CAMERAS = [
  {
    sensorId: "CAM-RWY10L-01",
    airportId: "11111111-1111-1111-1111-aaaaaaaaaaaa",
    location: { lat: 37.6213, lng: -122.379, alt_m: 4 },
    hz: Number(process.env["SENSOR_CAM_HZ"] ?? 5),
  },
  {
    sensorId: "CAM-RWY28R-01",
    airportId: "11111111-1111-1111-1111-aaaaaaaaaaaa",
    location: { lat: 37.6234, lng: -122.3658, alt_m: 4 },
    hz: Number(process.env["SENSOR_CAM_HZ"] ?? 5),
  },
  {
    sensorId: "CAM-RWY04L-01",
    airportId: "11111111-1111-1111-1111-bbbbbbbbbbbb",
    location: { lat: 40.6395, lng: -73.7789, alt_m: 4 },
    hz: Number(process.env["SENSOR_CAM_HZ"] ?? 5),
  },
] as const;

async function main(): Promise<void> {
  const logger = createLogger({ service: "sensor-gateway" });
  const redis = createRedis({
    host: process.env["REDIS_HOST"] ?? "redis",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  });

  const registry = new SimulatorRegistry();
  const channel = buildChannelName("sensor", "frame", "captured");

  for (const cam of BASELINE_CAMERAS) {
    registry.register(
      new CameraSimulator(
        {
          ...cam,
          sensorType: "camera",
        },
        { redis, logger, channel },
      ),
    );
  }

  const app = await buildApp({ logger, redis });
  const port = Number(process.env["PORT"] ?? 3003);
  await app.listen({ port, host: "0.0.0.0" });

  if (process.env["SENSOR_SIMULATORS_DISABLED"] !== "true") {
    registry.start();
    logger.info(
      { simulators: registry.size(), channel, ids: registry.ids() },
      "simulators started",
    );
  } else {
    logger.warn("simulators disabled via SENSOR_SIMULATORS_DISABLED");
  }

  logger.info({ port }, "sensor-gateway ready");

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn({ signal }, "shutting down");
    await registry.stop();
    await app.close();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("sensor-gateway fatal startup error:", err);
  process.exit(1);
});
