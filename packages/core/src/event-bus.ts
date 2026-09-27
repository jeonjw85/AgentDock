import { nanoid } from "nanoid";
import type { AgentDockEvent, EventType } from "./events.js";

type Listener = (event: AgentDockEvent) => void;

/** Distributive omit so each event variant keeps its own discriminated fields. */
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;

/** Fields the bus fills in automatically. */
type EmitInput = DistributiveOmit<AgentDockEvent, "id" | "at">;

/**
 * A lightweight synchronous pub/sub bus. Listeners are invoked in registration
 * order. Errors in a listener are isolated so one bad subscriber cannot break
 * the pipeline.
 *
 * The bus is the single choke point through which all observability data
 * flows, which makes it trivial to attach a persistence sink, a live TUI, or
 * a replay recorder.
 */
export class EventBus {
  #listeners = new Set<Listener>();
  #typed = new Map<EventType, Set<Listener>>();

  /** Subscribe to every event. Returns an unsubscribe function. */
  on(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Subscribe to a single event type. Returns an unsubscribe function. */
  onType(type: EventType, listener: Listener): () => void {
    let set = this.#typed.get(type);
    if (!set) {
      set = new Set();
      this.#typed.set(type, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Emit an event; id and timestamp are generated here. */
  emit(input: EmitInput): AgentDockEvent {
    const event = {
      ...input,
      id: nanoid(),
      at: new Date().toISOString(),
    } as AgentDockEvent;

    for (const listener of this.#listeners) {
      this.#safeInvoke(listener, event);
    }
    const typed = this.#typed.get(event.type);
    if (typed) {
      for (const listener of typed) {
        this.#safeInvoke(listener, event);
      }
    }
    return event;
  }

  #safeInvoke(listener: Listener, event: AgentDockEvent): void {
    try {
      listener(event);
    } catch (err) {
      // A failing subscriber must never break event propagation.
      // eslint-disable-next-line no-console
      console.error("[agentdock] event listener threw:", err);
    }
  }
}
