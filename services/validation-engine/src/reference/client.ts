/**
 * Reference-data client interface that L4 (source-of-truth) and L5
 * (cross-system) use to look up sensors + airports for cross-check
 * against incoming detections.
 *
 * Two implementations ship with the engine:
 *
 *   - `InMemoryReferenceDataClient`: seeded from a fixed map.
 *     Tests use this; production wiring lands when a real
 *     `RestReferenceDataClient` arrives in a later ticket.
 *   - (future) `RestReferenceDataClient`: hits the running
 *     reference-data service over HTTP. Out of scope for T-409
 *     because the engine ↔ reference-data wiring is its own
 *     concern; the layers stay testable via the interface here.
 *
 * Both layers are factory-configured with the client. When no
 * client is passed (the orchestrator default `ORDERED_LAYERS`
 * path), the layers pass through — the engine is still usable
 * end-to-end in tests + bootstrap without a reference-data
 * dependency.
 */

export interface SensorReference {
  id: string;
  airport_id: string;
  status: "online" | "degraded" | "offline";
  location?: { lat: number; lng: number };
}

export interface AirportReference {
  id: string;
  iata_code: string;
}

export interface ReferenceDataClient {
  getSensorById(sensorId: string): Promise<SensorReference | null>;
  getAirportById(airportId: string): Promise<AirportReference | null>;
}

/**
 * In-memory client seeded from two maps. The convenience constructor
 * accepts arrays for clarity in tests.
 */
export class InMemoryReferenceDataClient implements ReferenceDataClient {
  private readonly sensors: Map<string, SensorReference>;
  private readonly airports: Map<string, AirportReference>;

  constructor(opts: { sensors?: SensorReference[]; airports?: AirportReference[] } = {}) {
    this.sensors = new Map((opts.sensors ?? []).map((s) => [s.id, s]));
    this.airports = new Map((opts.airports ?? []).map((a) => [a.id, a]));
  }

  async getSensorById(id: string): Promise<SensorReference | null> {
    return this.sensors.get(id) ?? null;
  }

  async getAirportById(id: string): Promise<AirportReference | null> {
    return this.airports.get(id) ?? null;
  }
}
