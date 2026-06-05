/**
 * Scenario 02 — WebSocket fanout to N clients.
 *
 * Opens N authenticated WS clients against ws-broadcaster (through the
 * nginx edge) for one airport, publishes a burst to
 * `events.broadcast.<airport>`, and proves every connected client
 * receives the fanout. Exercises the RedisBridge → per-airport channel
 * registry → socket write path under connection fan-out.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  connectLoadPublisher,
  env,
  openFanout,
  pollUntil,
  sensorBroadcastEnvelope,
  thresholds,
  type FanoutPool,
  type LoadPublisher,
} from "../src/harness/index.js";
import { gatedDescribe } from "./_guard.js";

const describeStack = await gatedDescribe();
const T = thresholds.wsFanout;

describeStack("02 — websocket fanout", () => {
  let pub: LoadPublisher;
  let pool: FanoutPool;

  beforeAll(async () => {
    pub = await connectLoadPublisher();
    pool = await openFanout(env.airports.sfo, T.clients);
  });

  afterAll(async () => {
    await pool?.closeAll();
    pub?.disconnect();
  });

  it(`opens all ${T.clients} client connections`, () => {
    if (T.requireAllConnected) {
      expect(pool.connectedCount()).toBe(T.clients);
    } else {
      expect(pool.connectedCount()).toBeGreaterThan(0);
    }
  });

  it(`fans ${T.framesPublished} frames out to ≥${T.minDeliveryFraction * 100}% of every client`, async () => {
    for (let i = 0; i < T.framesPublished; i++) {
      await pub.publishBroadcast(env.airports.sfo, sensorBroadcastEnvelope());
    }

    const need = Math.ceil(T.framesPublished * T.minDeliveryFraction);
    const delivered = await pollUntil(
      async () => pool.clientsWithAtLeast(need) === pool.connectedCount(),
      { timeoutMs: 15_000, intervalMs: 500 },
    );
    expect(
      delivered,
      `only ${pool.clientsWithAtLeast(need)}/${pool.connectedCount()} clients received ≥${need} frames (total ${pool.totalReceived()})`,
    ).toBeTruthy();
  });
});
