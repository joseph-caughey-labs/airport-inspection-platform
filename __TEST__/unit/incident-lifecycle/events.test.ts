import { describe, expect, it } from "vitest";
import {
  buildTransitionEvent,
  channelFor,
  type Transition,
} from "../../../services/incident-service/src/domain/index.js";

const baseTransition: Transition = {
  from: "new",
  to: "acknowledged",
  command: "acknowledge",
  actor: "op-1",
  occurred_at: "2026-05-29T10:00:00.000Z",
};

describe("channelFor", () => {
  it("uses incident.transition.<next_state> per the channel convention", () => {
    expect(channelFor(baseTransition)).toBe("incident.transition.acknowledged");
    expect(channelFor({ ...baseTransition, to: "escalated" })).toBe(
      "incident.transition.escalated",
    );
    expect(channelFor({ ...baseTransition, to: "resolved" })).toBe("incident.transition.resolved");
  });
});

describe("buildTransitionEvent", () => {
  it("returns the canonical envelope shape", () => {
    const event = buildTransitionEvent("inc-1", baseTransition);
    expect(event).toEqual({
      event_type: "incident.transitioned",
      schema_version: "v1",
      incident_id: "inc-1",
      transition: baseTransition,
    });
  });

  it("includes correlation_id when provided", () => {
    const event = buildTransitionEvent("inc-1", baseTransition, "corr-7");
    expect(event.correlation_id).toBe("corr-7");
  });

  it("omits correlation_id when undefined (exactOptionalPropertyTypes safe)", () => {
    const event = buildTransitionEvent("inc-1", baseTransition);
    expect("correlation_id" in event).toBe(false);
  });
});
