import { z } from "zod";

export const SensorType = z.enum([
  "camera",
  "lidar",
  "gps",
  "imu",
  "weather",
  "perimeter",
]);
export type SensorType = z.infer<typeof SensorType>;
