import { describe, it, expect } from "vitest";
import { EventBus } from "./event-bus.js";
import type { AgentDockEvent } from "./events.js";

describe("EventBus", () => {
  it("emits to global listeners with generated id and timestamp", () => {
    const bus = new EventBus();
    const received: AgentDockEvent[] = [];
    bus.on((e) => received.push(e));
    const evt = bus.emit({ type: "task.created", taskId: "t1", title: "x", role: "work" });
    expect(received).toHaveLength(1);
    expect(evt.id).toBeTruthy();
    expect(evt.at).toBeTruthy();
    expect(received[0]!.type).toBe("task.created");
  });

  it("routes typed subscriptions only for matching type", () => {
    const bus = new EventBus();
    let created = 0;
    let changed = 0;
    bus.onType("task.created", () => created++);
    bus.onType("task.status_changed", () => changed++);
    bus.emit({ type: "task.created", taskId: "t", title: "a", role: "work" });
    bus.emit({ type: "task.status_changed", taskId: "t", from: "ready", to: "running" });
    expect(created).toBe(1);
    expect(changed).toBe(1);
  });

  it("isolates listener errors", () => {
    const bus = new EventBus();
    let reached = false;
    bus.on(() => {
      throw new Error("boom");
    });
    bus.on(() => {
      reached = true;
    });
    expect(() =>
      bus.emit({ type: "task.created", taskId: "t", title: "a", role: "work" }),
    ).not.toThrow();
    expect(reached).toBe(true);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on(() => count++);
    bus.emit({ type: "task.created", taskId: "t", title: "a", role: "work" });
    off();
    bus.emit({ type: "task.created", taskId: "t", title: "a", role: "work" });
    expect(count).toBe(1);
  });
});
