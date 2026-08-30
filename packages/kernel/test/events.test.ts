import {
  EVENT_CORRELATION_ID_MAX_LENGTH,
  EVENT_TYPE_MAX_SEGMENTS,
  EventBusStore,
} from "@prismengine/kernel";
import { describe, expect, it } from "vitest";

const event = (type: string, correlationId?: string) => ({
  type,
  payload: { value: 1 },
  occurredAt: "2026-08-29T00:00:00.000Z",
  ...(correlationId === undefined ? {} : { correlationId }),
});

describe("EventBus metadata", () => {
  it("preserves exact, trailing wildcard, global, and subscriber isolation", async () => {
    const deliveries: string[] = [];
    const errors: string[] = [];
    const store = new EventBusStore((_error, value) => errors.push(value.type));
    store.subscribe("alpha.beta", () => {
      deliveries.push("exact");
    });
    store.subscribe("alpha.*", () => {
      deliveries.push("prefix");
    });
    store.subscribe("*", () => {
      deliveries.push("global");
    });
    store.subscribe("alpha.beta", () => {
      throw new Error("subscriber failed");
    });
    store.subscribe("alpha.beta", () => {
      deliveries.push("after-error");
    });

    await store.publish("publisher", event("alpha.beta", "correlation-1"));

    expect(deliveries).toEqual(["exact", "after-error", "global", "prefix"]);
    expect(errors).toEqual(["alpha.beta"]);
  });

  it("rejects invalid subscription and publish metadata before registration/delivery", async () => {
    let deliveries = 0;
    const store = new EventBusStore();
    const invalidSubscriptions = [
      "",
      ".",
      "alpha..beta",
      "alpha.*.beta",
      "alpha*",
      "alpha.beta.*.*",
      "alpha.\u0001beta",
      Array.from({ length: EVENT_TYPE_MAX_SEGMENTS + 1 }, () => "a").join("."),
      "a".repeat(129),
    ];
    for (const type of invalidSubscriptions) {
      expect(() =>
        store.subscribe(type, () => {
          deliveries += 1;
        }),
      ).toThrow("EVENT_METADATA_INVALID");
    }

    const invalidEvents = [
      event("invalid type"),
      event("alpha.beta", ""),
      event("alpha.beta", "invalid correlation"),
      event("alpha.beta", "c".repeat(EVENT_CORRELATION_ID_MAX_LENGTH + 1)),
    ];
    for (const value of invalidEvents) {
      await expect(store.publish("publisher", value)).rejects.toThrow(
        "EVENT_METADATA_INVALID",
      );
    }
    await expect(
      store.scopedTo("publisher").publish("alpha.beta", {}, { correlationId: "" }),
    ).rejects.toThrow("EVENT_METADATA_INVALID");

    await store.publish("publisher", event("alpha.beta"));
    expect(deliveries).toBe(0);
  });

  it("accepts exact type and correlation boundaries", async () => {
    const segments = Array.from({ length: EVENT_TYPE_MAX_SEGMENTS }, () => "aaaaaaa");
    segments[0] = "aaaaaaaa";
    const type = segments.join(".");
    expect(type).toHaveLength(128);
    const correlationId = "c".repeat(EVENT_CORRELATION_ID_MAX_LENGTH);
    const store = new EventBusStore();
    let received = "";
    store.subscribe(`${segments.slice(0, -1).join(".")}.*`, (value) => {
      received = value.correlationId ?? "";
    });

    await store.publish("publisher", event(type, correlationId));

    expect(received).toBe(correlationId);
  });
});
