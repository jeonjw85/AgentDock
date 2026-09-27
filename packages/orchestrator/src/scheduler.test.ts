import { describe, it, expect } from "vitest";
import { makeTask, type Task } from "@agentdock/core";
import { Scheduler } from "./scheduler.js";

function task(overrides: Partial<Task> & { id: string }): Task {
  const base = makeTask({
    projectId: "p",
    role: "work",
    title: overrides.id,
    prompt: "",
  });
  return { ...base, ...overrides };
}

describe("Scheduler.findCycle", () => {
  it("returns null for an acyclic graph", () => {
    const a = task({ id: "a" });
    const b = task({ id: "b", dependsOn: ["a"] });
    const c = task({ id: "c", dependsOn: ["a", "b"] });
    expect(Scheduler.findCycle([a, b, c])).toBeNull();
  });

  it("detects a direct cycle", () => {
    const a = task({ id: "a", dependsOn: ["b"] });
    const b = task({ id: "b", dependsOn: ["a"] });
    const cycle = Scheduler.findCycle([a, b]);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThan(0);
  });

  it("ignores unknown external dependencies", () => {
    const a = task({ id: "a", dependsOn: ["nonexistent"] });
    expect(Scheduler.findCycle([a])).toBeNull();
  });
});

describe("Scheduler.runnable", () => {
  it("returns tasks with all deps succeeded", () => {
    const a = task({ id: "a", status: "succeeded" });
    const b = task({ id: "b", status: "ready", dependsOn: ["a"] });
    const runnable = Scheduler.runnable([a, b]);
    expect(runnable.map((t) => t.id)).toEqual(["b"]);
  });

  it("excludes tasks blocked by unfinished deps", () => {
    const a = task({ id: "a", status: "running" });
    const b = task({ id: "b", status: "blocked", dependsOn: ["a"] });
    expect(Scheduler.runnable([a, b])).toEqual([]);
  });

  it("excludes permanently failed tasks", () => {
    const a = task({ id: "a", status: "failed", attempts: 1, maxAttempts: 1 });
    expect(Scheduler.runnable([a])).toEqual([]);
  });

  it("includes retryable failed tasks", () => {
    const a = task({ id: "a", status: "failed", attempts: 1, maxAttempts: 3 });
    expect(Scheduler.runnable([a]).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("Scheduler.reconcileStatuses", () => {
  it("promotes blocked to ready when deps succeed", () => {
    const a = task({ id: "a", status: "succeeded" });
    const b = task({ id: "b", status: "blocked", dependsOn: ["a"] });
    const updates = Scheduler.reconcileStatuses([a, b]);
    expect(updates.get("b")).toBe("ready");
  });

  it("keeps ready blocked when deps unfinished", () => {
    const a = task({ id: "a", status: "running" });
    const b = task({ id: "b", status: "ready", dependsOn: ["a"] });
    const updates = Scheduler.reconcileStatuses([a, b]);
    expect(updates.get("b")).toBe("blocked");
  });
});

describe("Scheduler.isComplete", () => {
  it("true when all terminal", () => {
    const a = task({ id: "a", status: "succeeded" });
    const b = task({ id: "b", status: "failed", attempts: 1, maxAttempts: 1 });
    expect(Scheduler.isComplete([a, b])).toBe(true);
  });
  it("false when work remains", () => {
    const a = task({ id: "a", status: "ready" });
    expect(Scheduler.isComplete([a])).toBe(false);
  });
});

describe("Scheduler approval gating", () => {
  it("awaiting_approval is not runnable", () => {
    const a = task({ id: "a", status: "awaiting_approval" });
    expect(Scheduler.runnable([a])).toEqual([]);
  });

  it("awaiting_approval does not satisfy a dependent", () => {
    const a = task({ id: "a", status: "awaiting_approval" });
    const b = task({ id: "b", status: "blocked", dependsOn: ["a"] });
    expect(Scheduler.runnable([a, b]).map((t) => t.id)).toEqual([]);
  });

  it("reconcile leaves awaiting_approval untouched", () => {
    const a = task({ id: "a", status: "awaiting_approval" });
    const updates = Scheduler.reconcileStatuses([a]);
    expect(updates.has("a")).toBe(false);
  });

  it("isWaitingForApproval true when only gated tasks remain", () => {
    const a = task({ id: "a", status: "awaiting_approval" });
    const b = task({ id: "b", status: "blocked", dependsOn: ["a"] });
    expect(Scheduler.isWaitingForApproval([a, b])).toBe(true);
  });

  it("isWaitingForApproval false when something is still runnable", () => {
    const a = task({ id: "a", status: "awaiting_approval" });
    const b = task({ id: "b", status: "ready" });
    expect(Scheduler.isWaitingForApproval([a, b])).toBe(false);
  });

  it("isWaitingForApproval false when complete", () => {
    const a = task({ id: "a", status: "succeeded" });
    expect(Scheduler.isWaitingForApproval([a])).toBe(false);
  });

  it("a rejected gated task (failed, maxed) is terminal and leaves dependents stuck", () => {
    const a = task({ id: "a", status: "failed", attempts: 1, maxAttempts: 1 });
    const b = task({ id: "b", status: "blocked", dependsOn: ["a"] });
    // Not complete (b is blocked forever) but nothing runnable and nothing gated.
    expect(Scheduler.runnable([a, b])).toEqual([]);
    expect(Scheduler.isWaitingForApproval([a, b])).toBe(false);
    expect(Scheduler.isComplete([a, b])).toBe(false);
  });
});
