import type { TaskRole, UsageMetrics } from "@agentdock/core";

/**
 * Context handed to an adapter for a single execution. Everything an agent
 * needs to do its job in isolation.
 */
export interface AgentRunContext {
  /** The task's natural-language instructions. */
  prompt: string;
  /** Human-readable task title. */
  title: string;
  /** The role this execution fulfils. */
  role: TaskRole;
  /** Absolute path to the isolated worktree the agent must operate in. */
  workspacePath: string;
  /** Git branch checked out in the workspace. */
  branch: string;
  /** Base ref the workspace was created from. */
  baseRef: string;
  /** Abort signal; adapters should terminate the agent when it fires. */
  signal: AbortSignal;
  /** Emit a streamed log line for observability. */
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Report a tool call the agent performed. */
  onToolCall: (tool: string, input?: unknown) => void;
  /** Report incremental usage/cost. */
  onUsage: (usage: Partial<UsageMetrics>) => void;
}

/** Outcome of a single agent execution. */
export interface AgentRunResult {
  /** Whether the agent believes it completed the task successfully. */
  success: boolean;
  /** Optional summary the agent produced. */
  summary?: string;
  /** Process exit code, if the adapter wraps a subprocess. */
  exitCode?: number;
  /** Final usage totals for this run. */
  usage: UsageMetrics;
}

/** Static description of an adapter, used for discovery and role matching. */
export interface AgentDescriptor {
  /** Stable unique id, e.g. "claude-code", "codex", "mock". */
  id: string;
  /** Display name. */
  name: string;
  /** Roles this agent is suited for. Empty means "any". */
  roles: TaskRole[];
}

/**
 * The contract every coding agent integration implements. AgentDock treats all
 * agents uniformly through this interface, which is what lets Claude Code,
 * Codex, OpenCode, Gemini, or any custom tool be orchestrated side by side.
 */
export interface AgentAdapter {
  readonly descriptor: AgentDescriptor;

  /**
   * Optional readiness check (e.g. verify the CLI is installed / authed).
   * Should resolve true when the agent can run.
   */
  isAvailable?(): Promise<boolean>;

  /** Execute the task. Must run to completion or reject on fatal error. */
  run(ctx: AgentRunContext): Promise<AgentRunResult>;
}
