/**
 * In-process event bus contract. V0.1 is synchronous fan-out inside the host
 * process; the shape leaves room for a transactional outbox later without
 * changing publisher code.
 */

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
