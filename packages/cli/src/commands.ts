import * as path from "node:path";
import {
  Orchestrator,
  DefaultPlanner,
  SingleTaskPlanner,
  type Planner,
} from "@agentdock/orchestrator";
import type { Task, TaskRole } from "@agentdock/core";
import {
  parseArgs,
  flagString,
  flagNumber,
  flagBool,
  type ParsedArgs,
} from "./args.js";
import {
  initProject,
  openStore,
  requireProject,
} from "./context.js";
import { buildDefaultRegistry } from "./registry.js";

const HELP = `agentdock — orchestrate multiple AI coding agents

Usage:
  agentdock init [--name <name>]            Initialize AgentDock in the current repo
  agentdock plan <title> [--desc <text>]    Decompose an issue into a task graph
                       [--planner default|single] [--gate review|work|plan]
  agentdock add <title> [--desc <text>]     Add a single task
                       [--role work|review|plan] [--agent <id>]
                       [--max-attempts <n>] [--approve]
  agentdock run [--concurrency <n>]         Run all pending tasks to completion
  agentdock approve <taskId> [--by <name>]  Approve a task awaiting approval
  agentdock reject <taskId> [--reason <t>]  Reject a task awaiting approval
  agentdock pr <taskId> [--body <text>]     Push branch and open a pull request (gh)
  agentdock merge <taskId>                  Merge a succeeded task's branch into base
  agentdock status                          Show task graph status
  agentdock sessions                        List execution sessions with usage/cost
  agentdock worktrees                       List git worktrees for this repo
  agentdock events [--task <id>]            Show the event log (session replay)
  agentdock agents                          List registered agent adapters
  agentdock help                            Show this help

Global flags:
  --repo <path>   Operate on a different repo (default: cwd)
`;

function repoOf(args: ParsedArgs): string {
  return path.resolve(flagString(args, "repo", process.cwd())!);
}

const roleIcon: Record<TaskRole, string> = { plan: "📋", work: "🔧", review: "🔍" };
const statusIcon: Record<string, string> = {
  pending: "…",
  blocked: "⏸",
  ready: "▶",
  running: "⟳",
  awaiting_approval: "⏳",
  succeeded: "✓",
  failed: "✗",
  cancelled: "⊘",
};

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args.positionals[0];

  if (!cmd || cmd === "help" || flagBool(args, "help")) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (cmd) {
      case "init":
        return await cmdInit(args);
      case "plan":
        return await cmdPlan(args);
      case "add":
        return await cmdAdd(args);
      case "run":
        return await cmdRun(args);
      case "approve":
        return await cmdApprove(args);
      case "reject":
        return await cmdReject(args);
      case "pr":
        return await cmdPr(args);
      case "merge":
        return await cmdMerge(args);
      case "status":
        return await cmdStatus(args);
      case "sessions":
        return await cmdSessions(args);
      case "worktrees":
        return await cmdWorktrees(args);
      case "events":
        return await cmdEvents(args);
      case "agents":
        return await cmdAgents(args);
      default:
        process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdInit(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const project = await initProject(repo, flagString(args, "name"));
  process.stdout.write(`Initialized AgentDock project "${project.name}" (${project.id})\n`);
  process.stdout.write(`Data dir: ${path.join(repo, ".agentdock")}\n`);
  return 0;
}

async function cmdPlan(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const title = args.positionals[1];
  if (!title) {
    process.stderr.write("plan requires a <title>\n");
    return 1;
  }
  const store = await openStore(repo);
  const project = await requireProject(store, repo);
  const planner: Planner =
    flagString(args, "planner") === "single" ? new SingleTaskPlanner() : new DefaultPlanner();
  const orch = new Orchestrator({ store, registry: buildDefaultRegistry(), planner });
  const gate = flagString(args, "gate");
  const tasks = await orch.planAndCreate({
    projectId: project.id,
    title,
    description: flagString(args, "desc", "")!,
    gateRoles: gate ? [gate as TaskRole] : undefined,
  });
  process.stdout.write(`Created ${tasks.length} task(s):\n`);
  for (const t of tasks) {
    const gated = t.approvalRequired ? " (approval required)" : "";
    process.stdout.write(`  ${roleIcon[t.role]} ${t.title}${gated} [${t.id}]\n`);
  }
  await store.close();
  return 0;
}

async function cmdAdd(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const title = args.positionals[1];
  if (!title) {
    process.stderr.write("add requires a <title>\n");
    return 1;
  }
  const store = await openStore(repo);
  const project = await requireProject(store, repo);
  const orch = new Orchestrator({ store, registry: buildDefaultRegistry() });
  const role = (flagString(args, "role", "work") as TaskRole) ?? "work";
  const task = await orch.addTask({
    projectId: project.id,
    role,
    title,
    prompt: flagString(args, "desc", title)!,
    agentId: flagString(args, "agent"),
    maxAttempts: flagNumber(args, "max-attempts", 1),
    approvalRequired: flagBool(args, "approve"),
  });
  process.stdout.write(`Added task ${roleIcon[task.role]} ${task.title} [${task.id}]\n`);
  await store.close();
  return 0;
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const store = await openStore(repo);
  const project = await requireProject(store, repo);
  const orch = new Orchestrator({
    store,
    registry: buildDefaultRegistry(),
    concurrency: flagNumber(args, "concurrency", 4),
  });

  // Live event streaming to stdout.
  orch.bus.on((e) => {
    if (e.type === "task.status_changed") {
      process.stdout.write(`  [${e.to}] task ${e.taskId}\n`);
    } else if (e.type === "session.started") {
      process.stdout.write(`  ▶ session ${e.sessionId} (${e.agentId}, attempt ${e.attempt})\n`);
    } else if (e.type === "session.ended") {
      process.stdout.write(`  ${e.status === "succeeded" ? "✓" : "✗"} session ${e.sessionId}\n`);
    } else if (e.type === "diff.captured") {
      process.stdout.write(
        `  ± ${e.filesChanged} file(s), +${e.insertions}/-${e.deletions}\n`,
      );
    } else if (e.type === "task.approval_requested") {
      process.stdout.write(`  ⏳ task ${e.taskId} awaiting approval\n`);
    }
  });

  process.stdout.write("Running tasks...\n");
  const report = await orch.run(project.id);

  if (report.waitingForApproval) {
    const pending = report.tasks.filter((t) => t.status === "awaiting_approval");
    process.stdout.write(`\n⏳ Paused. ${pending.length} task(s) awaiting approval:\n`);
    for (const t of pending) {
      process.stdout.write(`   ${t.title} [${t.id}]\n`);
    }
    process.stdout.write(
      `Approve with:  agentdock approve <taskId>\n` +
        `Then re-run:   agentdock run\n`,
    );
  } else {
    process.stdout.write(
      `\nDone. ${report.succeeded ? "All tasks succeeded ✓" : "Some tasks did not succeed ✗"}\n`,
    );
  }
  process.stdout.write(
    `Usage: ${report.totalUsage.inputTokens} in / ${report.totalUsage.outputTokens} out tokens, ` +
      `${report.totalUsage.toolCalls} tool calls, $${report.totalUsage.costUsd.toFixed(4)}\n`,
  );
  await store.close();
  return report.succeeded ? 0 : report.waitingForApproval ? 0 : 1;
}

async function cmdApprove(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const taskId = args.positionals[1];
  if (!taskId) {
    process.stderr.write("approve requires a <taskId>\n");
    return 1;
  }
  const store = await openStore(repo);
  await requireProject(store, repo);
  const orch = new Orchestrator({ store, registry: buildDefaultRegistry() });
  const task = await orch.approveTask(taskId, flagString(args, "by"));
  process.stdout.write(`✓ Approved ${task.title} [${task.id}] — now ${task.status}\n`);
  process.stdout.write(`Run 'agentdock run' to continue dependents.\n`);
  await store.close();
  return 0;
}

async function cmdReject(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const taskId = args.positionals[1];
  if (!taskId) {
    process.stderr.write("reject requires a <taskId>\n");
    return 1;
  }
  const store = await openStore(repo);
  await requireProject(store, repo);
  const orch = new Orchestrator({ store, registry: buildDefaultRegistry() });
  const task = await orch.rejectTask(taskId, flagString(args, "reason"));
  process.stdout.write(`✗ Rejected ${task.title} [${task.id}] — now ${task.status}\n`);
  await store.close();
  return 0;
}

async function cmdPr(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const taskId = args.positionals[1];
  if (!taskId) {
    process.stderr.write("pr requires a <taskId>\n");
    return 1;
  }
  const store = await openStore(repo);
  await requireProject(store, repo);
  const orch = new Orchestrator({ store, registry: buildDefaultRegistry() });
  const pr = await orch.openPullRequest(taskId, flagString(args, "body"));
  if (pr.created && pr.url) {
    process.stdout.write(`✓ Pull request opened: ${pr.url}\n`);
  } else {
    process.stdout.write(`Could not open PR automatically: ${pr.detail ?? "unknown reason"}\n`);
  }
  await store.close();
  return pr.created ? 0 : 1;
}

async function cmdMerge(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const taskId = args.positionals[1];
  if (!taskId) {
    process.stderr.write("merge requires a <taskId>\n");
    return 1;
  }
  const store = await openStore(repo);
  await requireProject(store, repo);
  const orch = new Orchestrator({ store, registry: buildDefaultRegistry() });
  const sha = await orch.mergeTask(taskId);
  process.stdout.write(`✓ Merged task ${taskId}. Base HEAD is now ${sha.slice(0, 10)}\n`);
  await store.close();
  return 0;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const store = await openStore(repo);
  const project = await requireProject(store, repo);
  const tasks = await store.listTasks(project.id);
  if (tasks.length === 0) {
    process.stdout.write("No tasks. Use 'agentdock plan' or 'agentdock add'.\n");
  } else {
    process.stdout.write(`Tasks for "${project.name}":\n`);
    for (const t of tasks) {
      const deps = t.dependsOn.length ? ` deps:[${t.dependsOn.join(", ")}]` : "";
      const marks =
        (t.approvalRequired ? " 🔒" : "") +
        (t.prUrl ? " 🔗PR" : "") +
        (t.merged ? " ✅merged" : "");
      process.stdout.write(
        `  ${statusIcon[t.status] ?? "?"} ${roleIcon[t.role]} ${t.title} ` +
          `(${t.status}, ${t.attempts}/${t.maxAttempts})${deps}${marks} [${t.id}]\n`,
      );
    }
  }
  await store.close();
  return 0;
}

async function cmdSessions(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const store = await openStore(repo);
  await requireProject(store, repo);
  const sessions = await store.listSessions();
  if (sessions.length === 0) {
    process.stdout.write("No sessions yet.\n");
  } else {
    process.stdout.write("Sessions:\n");
    for (const s of sessions) {
      process.stdout.write(
        `  ${s.status === "succeeded" ? "✓" : s.status === "failed" ? "✗" : "⟳"} ` +
          `${s.agentId} task:${s.taskId} attempt:${s.attempt} ` +
          `tokens:${s.usage.inputTokens}/${s.usage.outputTokens} ` +
          `tools:${s.usage.toolCalls} $${s.usage.costUsd.toFixed(4)}\n`,
      );
    }
  }
  await store.close();
  return 0;
}

async function cmdWorktrees(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const store = await openStore(repo);
  const project = await requireProject(store, repo);
  const workspaces = await store.listWorkspaces(project.id);
  if (workspaces.length === 0) {
    process.stdout.write("No worktrees tracked.\n");
  } else {
    process.stdout.write("Worktrees:\n");
    for (const w of workspaces) {
      process.stdout.write(`  ${w.branch} -> ${w.path} (task ${w.taskId})\n`);
    }
  }
  await store.close();
  return 0;
}

async function cmdEvents(args: ParsedArgs): Promise<number> {
  const repo = repoOf(args);
  const store = await openStore(repo);
  await requireProject(store, repo);
  const events = await store.listEvents({ taskId: flagString(args, "task") });
  process.stdout.write(`Event log (${events.length} events):\n`);
  for (const e of events) {
    process.stdout.write(`  ${e.at} ${e.type}${e.taskId ? ` task:${e.taskId}` : ""}\n`);
  }
  await store.close();
  return 0;
}

async function cmdAgents(_args: ParsedArgs): Promise<number> {
  const registry = buildDefaultRegistry();
  process.stdout.write("Registered agents:\n");
  for (const a of registry.all()) {
    const roles = a.descriptor.roles.length ? a.descriptor.roles.join(", ") : "any";
    process.stdout.write(`  ${a.descriptor.id} (${a.descriptor.name}) — roles: ${roles}\n`);
  }
  return 0;
}

export type { Task };
