import { promises as fs } from "node:fs";
import * as path from "node:path";
import { emptyUsage, type TaskRole } from "@agentdock/core";
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunContext,
  AgentRunResult,
} from "./adapter.js";

export interface MockAdapterOptions {
  id?: string;
  name?: string;
  roles?: TaskRole[];
  /** Force the run to report failure. */
  fail?: boolean;
  /**
   * A function that writes files into the workspace to simulate the agent
   * making changes. Defaults to writing a marker file.
   */
  effect?: (workspacePath: string, ctx: AgentRunContext) => Promise<void>;
}

/**
 * A deterministic, offline adapter used for tests and demos. It simulates an
 * agent by emitting logs, a tool call, usage, and writing a file into the
 * workspace so downstream diff tracking has real changes to report.
 */
export class MockAdapter implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  #opts: MockAdapterOptions;

  constructor(opts: MockAdapterOptions = {}) {
    this.#opts = opts;
    this.descriptor = {
      id: opts.id ?? "mock",
      name: opts.name ?? "Mock Agent",
      roles: opts.roles ?? [],
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    ctx.onLog("stdout", `[mock] starting ${this.descriptor.id} for "${ctx.title}"\n`);
    ctx.onToolCall("write_file", { path: "AGENT_NOTES.md" });

    if (this.#opts.effect) {
      await this.#opts.effect(ctx.workspacePath, ctx);
    } else {
      const marker = path.join(ctx.workspacePath, `AGENTDOCK_${this.descriptor.id}.md`);
      await fs.writeFile(
        marker,
        `# ${this.descriptor.id}\n\nRole: ${ctx.role}\nTask: ${ctx.title}\n\n${ctx.prompt}\n`,
        "utf8",
      );
    }

    const usage = { ...emptyUsage(), inputTokens: 100, outputTokens: 50, costUsd: 0.001, toolCalls: 1 };
    ctx.onUsage(usage);
    ctx.onLog("stdout", `[mock] finished\n`);

    if (this.#opts.fail) {
      return { success: false, summary: "mock failure", exitCode: 1, usage };
    }
    return {
      success: true,
      summary: `Completed ${ctx.role} task: ${ctx.title}`,
      exitCode: 0,
      usage,
    };
  }
}
