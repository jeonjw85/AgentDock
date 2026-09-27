import {
  type AgentAdapter,
  type AgentRunContext,
  type AgentRunResult,
} from "@agentdock/adapters";
import type { TaskRole, UsageMetrics } from "@agentdock/core";

/**
 * Parameters describing where and how to execute an agent. The runtime is
 * responsible for placing the agent's execution environment (local process,
 * Docker container, remote host) but delegates the actual agent behaviour to
 * the adapter.
 */
export interface ExecutionRequest {
  adapter: AgentAdapter;
  prompt: string;
  title: string;
  role: TaskRole;
  workspacePath: string;
  branch: string;
  baseRef: string;
  signal: AbortSignal;
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  onToolCall: (tool: string, input?: unknown) => void;
  onUsage: (usage: Partial<UsageMetrics>) => void;
}

/**
 * A Runtime decides the execution environment for an agent. Implementations:
 *  - LocalRuntime: run in the host process/worktree (default).
 *  - DockerRuntime: run inside a sandboxed container mounting the worktree.
 */
export interface Runtime {
  readonly id: string;
  execute(req: ExecutionRequest): Promise<AgentRunResult>;
}

/**
 * Executes the adapter directly on the host, operating in the task's worktree.
 * The simplest and default backend; no isolation beyond the worktree itself.
 */
export class LocalRuntime implements Runtime {
  readonly id = "local";

  async execute(req: ExecutionRequest): Promise<AgentRunResult> {
    const ctx: AgentRunContext = {
      prompt: req.prompt,
      title: req.title,
      role: req.role,
      workspacePath: req.workspacePath,
      branch: req.branch,
      baseRef: req.baseRef,
      signal: req.signal,
      onLog: req.onLog,
      onToolCall: req.onToolCall,
      onUsage: req.onUsage,
    };
    return req.adapter.run(ctx);
  }
}
