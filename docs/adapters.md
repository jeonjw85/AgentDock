# Writing an Agent Adapter

An **adapter** teaches AgentDock how to drive a specific coding agent. Every agent,
whether it is Claude Code, Codex, OpenCode, Gemini, or your own, is orchestrated
through the same small interface. Once you write an adapter it takes part in
planning, scheduling, worktree isolation, retries, and observability for free.

## The contract

```ts
interface AgentAdapter {
  readonly descriptor: AgentDescriptor;      // id, name, roles
  isAvailable?(): Promise<boolean>;           // optional readiness check
  run(ctx: AgentRunContext): Promise<AgentRunResult>;
}
```

`AgentRunContext` gives the adapter everything it needs to work in isolation:

```ts
interface AgentRunContext {
  prompt: string;          // the task instructions
  title: string;
  role: "plan" | "work" | "review";
  workspacePath: string;   // the isolated git worktree; operate ONLY here
  branch: string;
  baseRef: string;
  signal: AbortSignal;     // terminate the agent when this fires
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  onToolCall: (tool: string, input?: unknown) => void;
  onUsage: (usage: Partial<UsageMetrics>) => void;
}
```

Return an `AgentRunResult`:

```ts
interface AgentRunResult {
  success: boolean;        // did the task complete?
  summary?: string;
  exitCode?: number;
  usage: UsageMetrics;     // tokens, cost, tool calls
}
```

**Contract rules**

- Operate only inside `ctx.workspacePath`. AgentDock created it as an isolated
  worktree, and writing outside it breaks isolation.
- Stream telemetry via `onLog`, `onToolCall`, and `onUsage` so runs are
  observable and cost is tracked.
- Honor `ctx.signal` by killing the agent process when it aborts.
- Do **not** commit. The orchestrator commits successful work automatically.

## Option A: wrap a CLI agent (most common)

Most agents are command-line tools. Use the built-in `CliAdapter` instead of
implementing the interface by hand:

```ts
import { CliAdapter, AdapterRegistry } from "@agentdock/adapters";

const claude = new CliAdapter({
  id: "claude-code",
  name: "Claude Code",
  roles: ["work", "review"],
  command: "claude",
  // Map the AgentDock prompt to the agent's own CLI convention:
  buildArgs: (ctx) => ["-p", ctx.prompt, "--permission-mode", "acceptEdits"],
  // Optionally parse the agent's output for structured telemetry:
  parseLine: (line) => {
    const m = line.match(/tokens: (\d+) in \/ (\d+) out/);
    if (m) return { usage: { inputTokens: +m[1], outputTokens: +m[2] } };
    if (line.includes("Tool:")) return { toolCall: line.split("Tool:")[1]?.trim() };
    return undefined;
  },
});

const registry = new AdapterRegistry().register(claude);
```

`CliAdapter` spawns the command in the worktree, streams stdout/stderr as logs,
runs `parseLine` on each line to surface usage/tool calls, forwards `SIGTERM` on
abort, and reports success from the exit code.

Other agents follow the same shape, and only `command` and `buildArgs` change:

```ts
new CliAdapter({ id: "codex",    command: "codex",    buildArgs: (c) => ["exec", c.prompt] });
new CliAdapter({ id: "opencode", command: "opencode", buildArgs: (c) => ["run", c.prompt] });
```

## Option B: implement `AgentAdapter` directly

For agents driven by an SDK/API rather than a CLI, implement the interface:

```ts
import type { AgentAdapter, AgentRunContext, AgentRunResult } from "@agentdock/adapters";
import { emptyUsage } from "@agentdock/core";

export class MyApiAdapter implements AgentAdapter {
  readonly descriptor = { id: "my-agent", name: "My Agent", roles: ["work"] as const };

  async isAvailable() {
    return Boolean(process.env.MY_AGENT_API_KEY);
  }

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const usage = emptyUsage();
    ctx.onLog("stdout", `Starting on ${ctx.branch}\n`);

    // ... call your SDK, write files into ctx.workspacePath ...
    ctx.onToolCall("edit_file", { path: "src/index.ts" });
    usage.inputTokens += 1200;
    usage.outputTokens += 800;
    usage.costUsd += 0.02;
    ctx.onUsage(usage);

    return { success: true, summary: "done", exitCode: 0, usage };
  }
}
```

## Roles and dispatch

`descriptor.roles` declares which task roles an adapter can serve:

- The orchestrator picks an adapter for a task by `task.agentId` if set, otherwise
  by the task's role via `AdapterRegistry.pickForRole`.
- An empty `roles: []` means "any role" (a fallback adapter).
- Assign a specific agent to a task with `agentdock add <title> --agent <id>` or
  by setting `agentId` in `TaskInput`.

## Registering adapters

The CLI builds its registry in `packages/cli/src/registry.ts`. Add your adapter
there to make it available to `agentdock run`:

```ts
export function buildDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new CliAdapter({ id: "claude-code", command: "claude", /* ... */ }));
  return registry;
}
```

Programmatic users pass their own registry straight to the `Orchestrator`:

```ts
const orch = new Orchestrator({ store, registry: myRegistry });
```

## Testing your adapter

Use a temp git repo and the in-memory store, exactly like AgentDock's own
integration tests (`packages/orchestrator/src/orchestrator.test.ts`). The
`MockAdapter` is a good reference implementation: it emits logs, a tool call,
usage, and writes a file into the workspace so diff tracking has real changes to
report.
