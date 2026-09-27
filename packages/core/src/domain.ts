/**
 * Core domain types for AgentDock.
 *
 * These are intentionally serializable (plain data) so they can be persisted,
 * transmitted over IPC, and replayed for observability.
 */

/** Unique identifier alias for readability. */
export type Id = string;

/** ISO-8601 timestamp string. */
export type Timestamp = string;

// ---------------------------------------------------------------------------
// Project & Workspace
// ---------------------------------------------------------------------------

/** A repository AgentDock operates on. */
export interface Project {
  id: Id;
  name: string;
  /** Absolute path to the root git repository. */
  repoPath: string;
  createdAt: Timestamp;
}

/**
 * An isolated working area for a single task, backed by a git worktree.
 * Multiple workspaces can exist concurrently for one project.
 */
export interface Workspace {
  id: Id;
  projectId: Id;
  taskId: Id;
  /** Absolute path to the worktree directory. */
  path: string;
  /** Git branch checked out in this worktree. */
  branch: string;
  /** Base ref the worktree/branch was created from. */
  baseRef: string;
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "blocked"
  | "ready"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * The role a task plays in the pipeline. Determines which class of agent
 * is assigned and how output is interpreted.
 */
export type TaskRole = "plan" | "work" | "review";

export interface Task {
  id: Id;
  projectId: Id;
  /** Optional parent task (e.g. subtasks produced by a planner). */
  parentId?: Id;
  role: TaskRole;
  title: string;
  /** Natural-language instructions handed to the agent. */
  prompt: string;
  status: TaskStatus;
  /** Task ids that must reach a terminal success before this one becomes ready. */
  dependsOn: Id[];
  /** Preferred agent id; if omitted the orchestrator picks by role. */
  agentId?: Id;
  /** Number of times this task has been attempted. */
  attempts: number;
  /** Maximum attempts before the task is marked failed. */
  maxAttempts: number;
  /**
   * When true, a successful agent run parks the task in `awaiting_approval`
   * (work committed but gated) until a human approves it. Dependents stay
   * blocked until approval.
   */
  approvalRequired: boolean;
  /** Set when a human approves the task. */
  approvedAt?: Timestamp;
  approvedBy?: string;
  /** Set when a human rejects the task (moves it to `failed`). */
  rejectedAt?: Timestamp;
  rejectionReason?: string;
  /** URL of the pull request opened for this task's branch, if any. */
  prUrl?: string;
  /** Commit SHA the successful work was committed as, if any. */
  commitSha?: string;
  /** Whether this task's branch has been merged into its base. */
  merged?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Input used to create a task; ids/timestamps/status are filled in by core. */
export interface TaskInput {
  projectId: Id;
  parentId?: Id;
  role: TaskRole;
  title: string;
  prompt: string;
  dependsOn?: Id[];
  agentId?: Id;
  maxAttempts?: number;
  approvalRequired?: boolean;
}

// ---------------------------------------------------------------------------
// Sessions (one agent execution attempt)
// ---------------------------------------------------------------------------

export type SessionStatus = "running" | "succeeded" | "failed" | "cancelled";

/** A single execution of an agent against a task inside a workspace. */
export interface Session {
  id: Id;
  taskId: Id;
  workspaceId: Id;
  agentId: Id;
  attempt: number;
  status: SessionStatus;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  /** Aggregated usage/cost metrics reported by the adapter. */
  usage: UsageMetrics;
  /** Optional human-readable summary produced by the agent. */
  summary?: string;
  /** Exit code of the underlying process, if applicable. */
  exitCode?: number;
}

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in USD. */
  costUsd: number;
  /** Number of tool calls the agent made. */
  toolCalls: number;
}

export function emptyUsage(): UsageMetrics {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0 };
}
