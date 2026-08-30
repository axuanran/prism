/**
 * In-process event bus contract. V0.1 is synchronous fan-out inside the host
 * process; the shape leaves room for a transactional outbox later without
 * changing publisher code.
 */

import { PrismError } from "@prismengine/contracts-data";

export const EVENT_TYPE_MAX_LENGTH = 128;
export const EVENT_TYPE_MAX_SEGMENTS = 16;
export const EVENT_CORRELATION_ID_MAX_LENGTH = 128;
const EVENT_SEGMENT = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/u;
const EVENT_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export function assertEventType(type: string): void {
  if (typeof type !== "string" || type.length < 1 || type.length > EVENT_TYPE_MAX_LENGTH) {
    throw invalidEventMetadata("type");
  }
  const segments = type.split(".");
  if (
    segments.length > EVENT_TYPE_MAX_SEGMENTS ||
    !segments.every((segment) => EVENT_SEGMENT.test(segment))
  ) {
    throw invalidEventMetadata("type");
  }
}

export function assertEventSubscription(type: string): void {
  if (type === "*") return;
  if (typeof type !== "string") throw invalidEventMetadata("subscription");
  if (type.endsWith(".*")) {
    const exact = type.slice(0, -2);
    assertEventType(exact);
    return;
  }
  assertEventType(type);
}

export function assertEventCorrelationId(correlationId: string): void {
  if (
    typeof correlationId !== "string" ||
    correlationId.length < 1 ||
    correlationId.length > EVENT_CORRELATION_ID_MAX_LENGTH ||
    !EVENT_CORRELATION_ID.test(correlationId)
  ) {
    throw invalidEventMetadata("correlationId");
  }
}

function invalidEventMetadata(field: string): PrismError {
  return PrismError.of("EVENT_METADATA_INVALID", "Event metadata is invalid.", { field });
}

export interface PrismEvent<TPayload = unknown> {
  /** Dotted, plugin-namespaced, e.g. "performance.run.completed". */
  readonly type: string;
  readonly payload: TPayload;
  readonly occurredAt: string;
  /** Plugin id of the publisher. Set by the engine, not the caller. */
  readonly source: string;
  /** Ties an event to the request/run that caused it. */
  readonly correlationId?: string;
}

export type EventHandler<TPayload = unknown> = (
  event: PrismEvent<TPayload>,
) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface EventBus {
  publish<TPayload>(
    type: string,
    payload: TPayload,
    options?: { readonly correlationId?: string },
  ): Promise<void>;

  /** `type` supports a single trailing wildcard, e.g. "performance.run.*". */
  subscribe<TPayload>(type: string, handler: EventHandler<TPayload>): Unsubscribe;
}
