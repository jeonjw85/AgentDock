import type { TaskInput } from "@agentdock/core";

/** A high-level request to decompose, e.g. a GitHub issue. */
export interface PlanRequest {
  projectId: string;
  title: string;
  description: string;
  /**
   * Roles whose tasks should require human approval after a successful run.
   * E.g. `["review"]` gates the final review step behind an approval.
   */
  gateRoles?: import("@agentdock/core").TaskRole[];
}

/**
 * A plan is a set of task inputs plus dependency wiring expressed by index.
 * The orchestrator materializes these into real tasks with generated ids.
 */
export interface PlannedTask extends Omit<TaskInput, "projectId" | "dependsOn"> {
  /** Local key used to express dependencies within the plan. */
  key: string;
  /** Keys of other planned tasks this one depends on. */
  dependsOnKeys?: string[];
}

export interface Plan {
  tasks: PlannedTask[];
}

/** Decomposes a high-level request into an executable plan. */
export interface Planner {
  plan(req: PlanRequest): Promise<Plan>;
}

/**
 * Deterministic, offline planner. Produces the canonical AgentDock pipeline:
 * a backend worker and a frontend worker running in parallel, followed by a
 * reviewer that depends on both. Suitable as a default and for tests; swap in
 * an agent-backed planner for real decomposition.
 */
export class DefaultPlanner implements Planner {
  async plan(req: PlanRequest): Promise<Plan> {
    const backend: PlannedTask = {
      key: "backend",
      role: "work",
      title: `${req.title} — backend`,
      prompt: `Implement the backend portion of: ${req.title}\n\n${req.description}`,
    };
    const frontend: PlannedTask = {
      key: "frontend",
      role: "work",
      title: `${req.title} — frontend`,
      prompt: `Implement the frontend portion of: ${req.title}\n\n${req.description}`,
    };
    const review: PlannedTask = {
      key: "review",
      role: "review",
      title: `${req.title} — review`,
      prompt: `Review the backend and frontend changes for: ${req.title}. Verify correctness, tests, and consistency.`,
      dependsOnKeys: ["backend", "frontend"],
    };
    return { tasks: [backend, frontend, review] };
  }
}

/**
 * A single-worker planner: one task, no decomposition. Useful for simple
 * issues or when you want one agent to own the whole change.
 */
export class SingleTaskPlanner implements Planner {
  async plan(req: PlanRequest): Promise<Plan> {
    return {
      tasks: [
        {
          key: "main",
          role: "work",
          title: req.title,
          prompt: `${req.title}\n\n${req.description}`,
        },
      ],
    };
  }
}
