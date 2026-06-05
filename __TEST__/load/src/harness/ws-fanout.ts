/**
 * WebSocket fanout harness — opens N authenticated client connections
 * to ws-broadcaster (through the nginx edge) for the same airport, so a
 * scenario can publish to `events.broadcast.<airport>` and assert every
 * client receives the fanout.
 *
 * Auth rides the subprotocol the browser WebSocket API allows:
 * `Sec-WebSocket-Protocol: bearer.<token>` (ws-broadcaster echoes it
 * back to complete the handshake).
 */
import WebSocket from "ws";
import { env } from "./env.js";
import { operatorToken } from "./auth.js";
import { sleep } from "./redis-load.js";

export interface FanoutClient {
  ws: WebSocket;
  received: number;
  closedCode?: number;
}

export interface FanoutPool {
  clients: FanoutClient[];
  /** How many of the N clients completed the upgrade. */
  connectedCount: () => number;
  /** Total messages delivered across all clients. */
  totalReceived: () => number;
  /** Clients that received at least `min` messages. */
  clientsWithAtLeast: (min: number) => number;
  closeAll: () => Promise<void>;
}

/** Open `n` clients and wait until they've all opened (or timed out). */
export async function openFanout(airportId: string, n: number): Promise<FanoutPool> {
  const token = await operatorToken();
  const url = `ws://${env.edge.host}:${env.edge.port}/ws/v1/airport/${airportId}/events`;
  const clients: FanoutClient[] = [];

  const opens = Array.from({ length: n }, () => {
    const ws = new WebSocket(url, [`bearer.${token}`]);
    const client: FanoutClient = { ws, received: 0 };
    clients.push(client);
    ws.on("message", () => {
      client.received++;
    });
    ws.on("close", (code) => {
      client.closedCode = code;
    });
    return new Promise<void>((resolve) => {
      ws.on("open", () => resolve());
      ws.on("error", () => resolve()); // a refused client still counts (as not-connected)
    });
  });

  await Promise.all(opens);
  // Small settle so OPEN state is observable before the caller publishes.
  await sleep(250);

  return {
    clients,
    connectedCount: () => clients.filter((c) => c.ws.readyState === WebSocket.OPEN).length,
    totalReceived: () => clients.reduce((acc, c) => acc + c.received, 0),
    clientsWithAtLeast: (min: number) => clients.filter((c) => c.received >= min).length,
    closeAll: async () => {
      for (const c of clients) {
        try {
          c.ws.close();
        } catch {
          /* already closing */
        }
      }
      await sleep(100);
    },
  };
}
