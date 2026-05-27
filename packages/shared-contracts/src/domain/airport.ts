import { z } from "zod";

/** ICAO airport code — 4 uppercase letters (e.g. KSFO, KJFK, EGLL). */
export const IcaoCode = z
  .string()
  .length(4, "ICAO code must be 4 characters")
  .regex(/^[A-Z]{4}$/, "ICAO code must be uppercase A–Z");
export type IcaoCode = z.infer<typeof IcaoCode>;

/** IATA airport code — 3 uppercase letters (e.g. SFO, JFK, LHR). */
export const IataCode = z
  .string()
  .length(3, "IATA code must be 3 characters")
  .regex(/^[A-Z]{3}$/, "IATA code must be uppercase A–Z");
export type IataCode = z.infer<typeof IataCode>;

export const Airport = z.object({
  id: z.string().uuid(),
  icao_code: IcaoCode,
  iata_code: IataCode.optional(),
  name: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  country: z
    .string()
    .length(2, "ISO 3166-1 alpha-2 country code (2 letters)")
    .regex(/^[A-Z]{2}$/),
  timezone: z.string().min(1).describe("IANA timezone identifier"),
  created_at: z.string().datetime(),
});
export type Airport = z.infer<typeof Airport>;
