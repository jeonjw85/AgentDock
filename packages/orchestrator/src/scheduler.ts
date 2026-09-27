import type { Id, Task } from "@agentdock/core";

/**
 * Pure dependency-graph logic over a set of tasks. Stateless and easily
 * testable: given the current task list, it answers "what can run now?" and
 * validates the graph is acyclic.
 */
export class Scheduler {
  /** Detect a cycle in the dependency graph. Returns the cycle path if any. */
  static findCycle(tasks: Task[]): Id[] | null {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const state = new Map<Id, "visiting" | "done">();
    const stack: Id[] = [];

    const visit = (id: Id): Id[] | null => {
      const s = state.get(id);
      if (s === "done") return null;
      if (s === "visiting") {
        const start = stack.indexOf(id);
        return stack.slice(start).concat(id);
      }
      state.set(id, "visiting");
      stack.push(id);
      const task = byId.get(id);
      for (const dep of task?.dependsOn ?? []) {
        if (!byId.has(dep)) continue; // external/unknown dep ignored
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
      stack.pop();
      state.set(id, "done");
      return null;
    };

    for (const t of tasks) {
      const cycle = visit(t.id);
      if (cycle) return cycle;
    }
    return null;
  }

  /**
   * Tasks that are ready to run: not running/terminal/awaiting-approval, and
   * whose dependencies have all *succeeded* (approval-gated deps do not count
   * as succeeded until approved).
   */
  static runnable(tasks: Task[]): Task[] {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return tasks.filter((t) => {
      if (
        t.status === "running" ||
        t.status === "succeeded" ||
        t.status === "cancelled" ||
        t.status === "awaiting_approval"
      ) {
        return false;
      }
      if (t.status === "failed" && t.attempts >= t.maxAttempts) return false;
      return t.dependsOn.every((dep) => byId.get(dep)?.status === "succeeded");
    });
  }

  /**
   * Recompute derived status for tasks that are not running/terminal/awaiting:
   *  - "ready" when all deps succeeded
   *  - "blocked" when some dep is not yet succeeded
   *  - a task whose dep failed permanently stays blocked (never becomes ready)
   */
  static reconcileStatuses(tasks: Task[]): Map<Id, Task["status"]> {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const updates = new Map<Id, Task["status"]>();
    for (const t of tasks) {
      if (
        t.status === "running" ||
        t.status === "succeeded" ||
        t.status === "cancelled" ||
        t.status === "awaiting_approval"
      ) {
        continue;
      }
      if (t.status === "failed") continue;
      const allDone = t.dependsOn.every((d) => byId.get(d)?.status === "succeeded");
      const next = allDone ? "ready" : "blocked";
      if (next !== t.status) updates.set(t.id, next);
    }
    return updates;
  }

  /** True when every task has reached a terminal state. */
  static isComplete(tasks: Task[]): boolean {
    return tasks.every(
      (t) =>
        t.status === "succeeded" ||
        t.status === "cancelled" ||
        (t.status === "failed" && t.attempts >= t.maxAttempts),
    );
  }

  /**
   * True when the run cannot make further automated progress: nothing is
   * runnable, but at least one task is parked awaiting human approval. The
   * orchestrator uses this to stop the run loop and hand control to a human.
   */
  static isWaitingForApproval(tasks: Task[]): boolean {
    if (Scheduler.isComplete(tasks)) return false;
    if (Scheduler.runnable(tasks).length > 0) return false;
    return tasks.some((t) => t.status === "awaiting_approval");
  }
}
