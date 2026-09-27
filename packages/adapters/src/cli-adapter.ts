import { spawn } from "node:child_process";
import { emptyUsage, type TaskRole, type UsageMetrics } from "@agentdock/core";
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunContext,
  AgentRunResult,
} from "./adapter.js";

export interface CliAdapterOptions {
  id: string;
  name?: string;
  roles?: TaskRole[];
  /** Executable to run, e.g. "claude", "codex", "opencode". */
  command: string;
  /**
   * Build the argv for a given run. Receives the run context so integrations
   * can pass the prompt via a flag, a file, or stdin as the tool requires.
   */
  buildArgs: (ctx: AgentRunContext) => string[];
  /** If true, the prompt is written to the child's stdin. */
  promptToStdin?: boolean;
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
  /**
   * Optional parser that inspects a stdout/stderr line and returns partial
   * usage or a tool-call name. Lets adapters surface structured telemetry from
   * an agent's log output.
   */
  parseLine?: (
    line: string,
  ) => { usage?: Partial<UsageMetrics>; toolCall?: string } | undefined;
}

/**
 * Runs any CLI-based coding agent inside the task's worktree. This is the
 * foundation real integrations extend: point it at the agent's binary, map the
 * prompt to the agent's argument convention, and optionally parse its output
 * for usage/tool-call telemetry.
 */
export class CliAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  #opts: CliAdapterOptions;

  constructor(opts: CliAdapterOptions) {
    this.#opts = opts;
    this.descriptor = {
      id: opts.id,
      name: opts.name ?? opts.id,
      roles: opts.roles ?? [],
    };
  }

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const args = this.#opts.buildArgs(ctx);
    const usage: UsageMetrics = emptyUsage();

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(this.#opts.command, args, {
        cwd: ctx.workspacePath,
        env: { ...process.env, ...this.#opts.env },
      });

      const onAbort = () => child.kill("SIGTERM");
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const handleLine = (stream: "stdout" | "stderr", line: string) => {
        ctx.onLog(stream, line);
        const parsed = this.#opts.parseLine?.(line);
        if (parsed?.toolCall) {
          usage.toolCalls += 1;
          ctx.onToolCall(parsed.toolCall);
        }
        if (parsed?.usage) {
          if (parsed.usage.inputTokens) usage.inputTokens += parsed.usage.inputTokens;
          if (parsed.usage.outputTokens) usage.outputTokens += parsed.usage.outputTokens;
          if (parsed.usage.costUsd) usage.costUsd += parsed.usage.costUsd;
          if (parsed.usage.toolCalls) usage.toolCalls += parsed.usage.toolCalls;
          ctx.onUsage(parsed.usage);
        }
      };

      this.#pipe(child.stdout, (l) => handleLine("stdout", l));
      this.#pipe(child.stderr, (l) => handleLine("stderr", l));

      if (this.#opts.promptToStdin && child.stdin) {
        child.stdin.write(ctx.prompt);
        child.stdin.end();
      }

      child.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        const success = code === 0;
        resolve({
          success,
          exitCode: code ?? -1,
          summary: success ? undefined : `${this.#opts.command} exited ${code}`,
          usage,
        });
      });
    });
  }

  /** Split a stream into lines and forward each complete line. */
  #pipe(
    stream: NodeJS.ReadableStream | null,
    onLine: (line: string) => void,
  ): void {
    if (!stream) return;
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, idx + 1));
        buffer = buffer.slice(idx + 1);
      }
    });
    stream.on("end", () => {
      if (buffer) onLine(buffer);
    });
  }
}
