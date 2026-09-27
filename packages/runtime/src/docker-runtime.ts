import { spawn } from "node:child_process";
import { emptyUsage } from "@agentdock/core";
import type { AgentRunResult } from "@agentdock/adapters";
import type { ExecutionRequest, Runtime } from "./runtime.js";

export interface DockerRuntimeOptions {
  /** Container image to run the agent in. */
  image: string;
  /** Working directory inside the container where the worktree is mounted. */
  containerWorkdir?: string;
  /** Extra `docker run` flags (e.g. resource limits, network mode). */
  extraArgs?: string[];
  /**
   * Command to execute inside the container. The prompt is appended as the
   * final argument. Defaults to a shell that echoes the prompt (placeholder).
   */
  command?: (req: ExecutionRequest, containerWorkdir: string) => string[];
}

/**
 * Sandboxed execution backend. Runs the agent inside a Docker container with
 * the task's worktree bind-mounted, isolating filesystem and network from the
 * host. This is the recommended backend for running untrusted or autonomous
 * agents.
 *
 * Note: the container must contain the agent CLI. The mapping between an
 * {@link AgentAdapter} and its containerized command is provided via the
 * `command` option, keeping the adapter contract host/sandbox agnostic.
 */
export class DockerRuntime implements Runtime {
  readonly id = "docker";
  #opts: DockerRuntimeOptions;

  constructor(opts: DockerRuntimeOptions) {
    this.#opts = opts;
  }

  /** Verify docker is available on the host. */
  static async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"]);
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }

  async execute(req: ExecutionRequest): Promise<AgentRunResult> {
    const workdir = this.#opts.containerWorkdir ?? "/workspace";
    const inner = this.#opts.command
      ? this.#opts.command(req, workdir)
      : ["sh", "-lc", `echo "$AGENTDOCK_PROMPT"`];

    const args = [
      "run",
      "--rm",
      "-v",
      `${req.workspacePath}:${workdir}`,
      "-w",
      workdir,
      "-e",
      `AGENTDOCK_PROMPT=${req.prompt}`,
      ...(this.#opts.extraArgs ?? []),
      this.#opts.image,
      ...inner,
    ];

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn("docker", args);
      const usage = emptyUsage();

      const onAbort = () => child.kill("SIGTERM");
      req.signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (d: Buffer) => req.onLog("stdout", d.toString()));
      child.stderr.on("data", (d: Buffer) => req.onLog("stderr", d.toString()));

      child.on("error", (err) => {
        req.signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        req.signal.removeEventListener("abort", onAbort);
        const success = code === 0;
        resolve({
          success,
          exitCode: code ?? -1,
          summary: success ? undefined : `docker run exited ${code}`,
          usage,
        });
      });
    });
  }
}
