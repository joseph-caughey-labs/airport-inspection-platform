import { type Simulator } from "./types.js";

/**
 * Lifecycle owner for a collection of simulators. Services construct
 * one of these at startup, register every configured simulator, then
 * call `start()` once. Shutdown drains every simulator's stop().
 */
export class SimulatorRegistry {
  private readonly simulators = new Map<string, Simulator>();

  register(sim: Simulator): void {
    if (this.simulators.has(sim.sensorId)) {
      throw new Error(`simulator already registered for sensor_id=${sim.sensorId}`);
    }
    this.simulators.set(sim.sensorId, sim);
  }

  start(): void {
    for (const sim of this.simulators.values()) {
      sim.start();
    }
  }

  async stop(): Promise<void> {
    await Promise.all(Array.from(this.simulators.values()).map((s) => s.stop()));
  }

  size(): number {
    return this.simulators.size;
  }

  has(sensorId: string): boolean {
    return this.simulators.has(sensorId);
  }

  ids(): string[] {
    return Array.from(this.simulators.keys());
  }
}
