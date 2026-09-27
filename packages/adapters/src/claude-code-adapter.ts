import { spawn } from "node:child_process";
import { emptyUsage, type TaskRole, type UsageMetrics } from "@agentdock/core";
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunContext,
  AgentRunResult,
} from "./adapter.js";
import { ClaudeStreamParser } from "./claude-stream-parser.js";

export interface ClaudeCodeAdapterOptions {
  id?: string;
  name?: string;
  roles?: TaskRole[];
  /** Path to the claude executable. Defaults to "claude" on PATH. */
  command?: string;
  /** Model alias/name to pass via --model. */
  model?: string;
  /**
   * Permission mode. "acceptEdits" lets the agent write files without prompts,
   * which is what you want for autonomous worktree runs. Defaults to
   * "acceptEdits".
   */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Tools to allow, e.g. ["Write", "Edit", "Bash(git *)"]. */
  allowedTools?: string[];
  /** Extra CLI args appended verbatim. */
  extraArgs?: string[];
}

/**
 * Adapter for Anthropic's Claude Code CLI.
 *
 * Runs `claude -p <prompt> --output-format stream-json --verbose` inside the
 * task's worktree and parses the streamed JSON events into AgentDock's
 * observability callbacks (tool calls, token usage, cost). Success/failure is
 * taken from the terminal `result` event.
 *
 * The worktree is passed via cwd and `--add-dir`, so the agent operates only
 * within its isolated checkout.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  #opts: Required<Pick<ClaudeCodeAdapterOptions, "command" | "permissionMode">> &
    ClaudeCodeAdapterOptions;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.#opts = {
      ...opts,
      command: opts.command ?? "claude",
      permissionMode: opts.permissionMode ?? "acceptEdits",
    };
    this.descriptor = {
      id: opts.id ?? "claude-code",
      name: opts.name ?? "Claude Code",
      roles: opts.roles ?? ["work", "review", "plan"],
    };
  }

  /** Verify the claude CLI is invocable. */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.#opts.command, ["--version"]);
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }

  #buildArgs(ctx: AgentRunContext): string[] {
    const args = [
      "-p",
      ctx.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.#opts.permissionMode,
      "--add-dir",
      ctx.workspacePath,
    ];
    if (this.#opts.model) args.push("--model", this.#opts.model);
    if (this.#opts.allowedTools?.length) {
      args.push("--allowedTools", ...this.#opts.allowedTools);
    }
    if (this.#opts.extraArgs?.length) args.push(...this.#opts.extraArgs);
    return args;
  }

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const usage: UsageMetrics = emptyUsage();
    const parser = new ClaudeStreamParser({
      onToolCall: (tool, input) => {
        usage.toolCalls += 1;
        ctx.onToolCall(tool, input);
      },
      onUsageDelta: (delta) => {
        usage.inputTokens += delta.inputTokens ?? 0;
        usage.outputTokens += delta.outputTokens ?? 0;
        ctx.onUsage({ ...delta });
      },
      onText: (text) => ctx.onLog("stdout", text + "\n"),
    });

    const args = this.#buildArgs(ctx);

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(this.#opts.command, args, {
        cwd: ctx.workspacePath,
        env: { ...process.env },
      });

      const onAbort = () => child.kill("SIGTERM");
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d: Buffer) => parser.push(d.toString()));
      child.stderr.on("data", (d: Buffer) => ctx.onLog("stderr", d.toString()));

      child.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        ctx.signal.removeEventListener("abort", onAbort);
        parser.end();
        const r = parser.result;
        // Fold parser-reported cost into usage totals.
        usage.costUsd = r.costUsd;
        const success = r.success && code === 0;
        let summary = r.summary;
        if (!success && r.apiErrorStatus) {
          summary = `Claude API error ${r.apiErrorStatus}: ${r.summary ?? r.error ?? "failed"}`;
        }
        resolve({
          success,
          exitCode: code ?? -1,
          summary,
          usage,
        });
      });
    });
  }
}
