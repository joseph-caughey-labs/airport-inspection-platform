import { z } from "zod";

/**
 * Runway designator — heading-derived ICAO format.
 *
 * Format: NN[LRC]
 * - NN: 01–36, the magnetic heading divided by 10 (so 09 ≈ 090°, 27 ≈ 270°).
 * - Optional suffix L / R / C for left, right, or center when parallel
 *   runways share the same heading.
 *
 * Examples: "09", "09L", "27R", "36C".
 */
export const RunwayDesignator = z
  .string()
  .regex(
    /^(0[1-9]|[12][0-9]|3[0-6])[LRC]?$/,
    "Runway designator must be NN (01–36) with optional L/R/C suffix",
  );
export type RunwayDesignator = z.infer<typeof RunwayDesignator>;

export const RunwaySurface = z.enum(["asphalt", "concrete", "gravel", "turf", "other"]);
export type RunwaySurface = z.infer<typeof RunwaySurface>;

export const RunwayStatus = z.enum(["open", "closed", "restricted", "maintenance"]);
export type RunwayStatus = z.infer<typeof RunwayStatus>;

export const Runway = z.object({
  id: z.string().uuid(),
  airport_id: z.string().uuid(),
  designator: RunwayDesignator,
  paired_designator: RunwayDesignator.describe("Opposite-direction designator (e.g. 09L ↔ 27R)"),
  length_m: z.number().positive(),
  width_m: z.number().positive(),
  surface: RunwaySurface,
  status: RunwayStatus,
  created_at: z.string().datetime(),
});
export type Runway = z.infer<typeof Runway>;
