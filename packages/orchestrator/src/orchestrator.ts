import {
  EventBus,
  makeSession,
  makeTask,
  makeWorkspace,
  type Id,
  type Project,
  type Session,
  type Store,
  type Task,
  type TaskInput,
  type UsageMetrics,
} from "@agentdock/core";
import { AdapterRegistry } from "@agentdock/adapters";
import { WorktreeManager, RemoteOps, type PrResult } from "@agentdock/git";
import { LocalRuntime, type Runtime } from "@agentdock/runtime";
import { Scheduler } from "./scheduler.js";
import type { Plan, PlanRequest, Planner } from "./planner.js";
import { DefaultPlanner } from "./planner.js";

export interface OrchestratorOptions {
  store: Store;
  registry: AdapterRegistry;
  bus?: EventBus;
  runtime?: Runtime;
  planner?: Planner;
  /** Max tasks to execute concurrently. Default 4. */
  concurrency?: number;
}

/** Result of running a project's task graph to completion. */
export interface RunReport {
  projectId: Id;
  tasks: Task[];
  sessions: Session[];
  totalUsage: UsageMetrics;
  succeeded: boolean;
  /** True when the run stopped because tasks are parked awaiting approval. */
  waitingForApproval: boolean;
}

/**
 * The orchestration engine. Owns the task lifecycle:
 *   plan → materialize tasks → schedule ready tasks → per task: create
 *   worktree, run agent via runtime, record session + events, capture diff,
 *   commit → retry on failure → repeat until the graph is terminal.
 */
export class Orchestrator {
  #store: Store;
  #registry: AdapterRegistry;
  #bus: EventBus;
  #runtime: Runtime;
  #planner: Planner;
  #concurrency: number;

  constructor(opts: OrchestratorOptions) {
    this.#store = opts.store;
    this.#registry = opts.registry;
    this.#bus = opts.bus ?? new EventBus();
    this.#runtime = opts.runtime ?? new LocalRuntime();
    this.#planner = opts.planner ?? new DefaultPlanner();
    this.#concurrency = opts.concurrency ?? 4;
    // Persist every event for replay/observability.
    this.#bus.on((e) => void this.#store.appendEvent(e));
  }

  get bus(): EventBus {
    return this.#bus;
  }

  /** Decompose a request and persist the resulting tasks. Returns task ids. */
  async planAndCreate(req: PlanRequest): Promise<Task[]> {
    const plan: Plan = await this.#planner.plan(req);
    const keyToId = new Map<string, Id>();
    const created: Task[] = [];

    // First pass: allocate ids.
    for (const pt of plan.tasks) {
      keyToId.set(pt.key, ""); // placeholder; real id assigned below
    }

    for (const pt of plan.tasks) {
      const input: TaskInput = {
        projectId: req.projectId,
        role: pt.role,
        title: pt.title,
        prompt: pt.prompt,
        agentId: pt.agentId,
        maxAttempts: pt.maxAttempts,
        approvalRequired:
          pt.approvalRequired ?? req.gateRoles?.includes(pt.role) ?? false,
        dependsOn: (pt.dependsOnKeys ?? [])
          .map((k) => keyToId.get(k))
          .filter((v): v is Id => Boolean(v)),
      };
      const task = makeTask(input);
      keyToId.set(pt.key, task.id);
      await this.#store.createTask(task);
      this.#bus.emit({
        type: "task.created",
        taskId: task.id,
        title: task.title,
        role: task.role,
      });
      created.push(task);
    }
    return created;
  }

  /** Add a single ad-hoc task. */
  async addTask(input: TaskInput): Promise<Task> {
    const task = makeTask(input);
    await this.#store.createTask(task);
    this.#bus.emit({
      type: "task.created",
      taskId: task.id,
      title: task.title,
      role: task.role,
    });
    return task;
  }

  /**
   * Run all tasks for a project to completion. Concurrency-limited waves of
   * runnable tasks. Returns a full report.
   */
  async run(projectId: Id, signal?: AbortSignal): Promise<RunReport> {
    const project = await this.#store.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);

    // Validate the graph up front.
    const initial = await this.#store.listTasks(projectId);
    const cycle = Scheduler.findCycle(initial);
    if (cycle) {
      throw new Error(`Task dependency cycle detected: ${cycle.join(" -> ")}`);
    }

    await this.#reconcile(projectId);

    while (true) {
      if (signal?.aborted) break;
      const tasks = await this.#store.listTasks(projectId);
      if (Scheduler.isComplete(tasks)) break;

      const runnable = Scheduler.runnable(tasks);
      if (runnable.length === 0) {
        // Nothing runnable but not complete → either blocked by a failed
        // dependency, or parked awaiting human approval. Either way the
        // automated loop cannot make progress, so stop.
        break;
      }

      const wave = runnable.slice(0, this.#concurrency);
      await Promise.all(wave.map((t) => this.#runTask(project, t, signal)));
      await this.#reconcile(projectId);
    }

    const tasks = await this.#store.listTasks(projectId);
    const sessions = await this.#store.listSessions();
    const totalUsage = sessions
      .filter((s) => tasks.some((t) => t.id === s.taskId))
      .reduce<UsageMetrics>(
        (acc, s) => ({
          inputTokens: acc.inputTokens + s.usage.inputTokens,
          outputTokens: acc.outputTokens + s.usage.outputTokens,
          costUsd: acc.costUsd + s.usage.costUsd,
          toolCalls: acc.toolCalls + s.usage.toolCalls,
        }),
        { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0 },
      );

    return {
      projectId,
      tasks,
      sessions: sessions.filter((s) => tasks.some((t) => t.id === s.taskId)),
      totalUsage,
      succeeded: tasks.every((t) => t.status === "succeeded"),
      waitingForApproval: Scheduler.isWaitingForApproval(tasks),
    };
  }

  // -------------------------------------------------------------------------
  // Human approval, PR, and merge
  // -------------------------------------------------------------------------

  /** Tasks currently parked awaiting human approval for a project. */
  async pendingApprovals(projectId: Id): Promise<Task[]> {
    const tasks = await this.#store.listTasks(projectId);
    return tasks.filter((t) => t.status === "awaiting_approval");
  }

  /**
   * Approve a gated task: transitions `awaiting_approval` → `succeeded`, which
   * unblocks dependents on the next reconcile/run.
   */
  async approveTask(taskId: Id, approvedBy?: string): Promise<Task> {
    const task = await this.#store.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.status !== "awaiting_approval") {
      throw new Error(
        `Task ${taskId} is not awaiting approval (status: ${task.status})`,
      );
    }
    task.approvedAt = new Date().toISOString();
    task.approvedBy = approvedBy;
    task.updatedAt = task.approvedAt;
    await this.#store.updateTask(task);
    this.#bus.emit({ type: "task.approved", taskId, approvedBy });
    await this.#setStatus(task, "succeeded");
    return (await this.#store.getTask(taskId))!;
  }

  /**
   * Reject a gated task: transitions `awaiting_approval` → `failed`, leaving
   * dependents blocked. Records the reason.
   */
  async rejectTask(taskId: Id, reason?: string): Promise<Task> {
    const task = await this.#store.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.status !== "awaiting_approval") {
      throw new Error(
        `Task ${taskId} is not awaiting approval (status: ${task.status})`,
      );
    }
    task.rejectedAt = new Date().toISOString();
    task.rejectionReason = reason;
    // A rejection is final regardless of remaining attempts.
    task.attempts = task.maxAttempts;
    task.updatedAt = task.rejectedAt;
    await this.#store.updateTask(task);
    this.#bus.emit({ type: "task.rejected", taskId, reason });
    await this.#setStatus(task, "failed");
    return (await this.#store.getTask(taskId))!;
  }

  /**
   * Push a task's branch and open a pull request for it. Requires the task to
   * have produced a commit. Degrades gracefully without a remote or `gh`.
   */
  async openPullRequest(taskId: Id, body?: string): Promise<PrResult> {
    const task = await this.#store.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const project = await this.#store.getProject(task.projectId);
    if (!project) throw new Error(`Unknown project: ${task.projectId}`);
    const ws = await this.#latestWorkspace(taskId);
    if (!ws) throw new Error(`No workspace found for task ${taskId}`);

    const remote = new RemoteOps(project.repoPath);
    const base = await remote.baseBranch();
    const pushed = await remote.pushBranch(ws.branch);
    if (!pushed) {
      return { created: false, detail: "no 'origin' remote; nothing pushed" };
    }
    const pr = await remote.openPullRequest({
      branch: ws.branch,
      base,
      title: task.title,
      body: body ?? task.prompt,
    });
    if (pr.created && pr.url) {
      task.prUrl = pr.url;
      task.updatedAt = new Date().toISOString();
      await this.#store.updateTask(task);
      this.#bus.emit({
        type: "task.pr_opened",
        taskId,
        url: pr.url,
        branch: ws.branch,
      });
    }
    return pr;
  }

  /**
   * Merge a task's branch into the repo's base branch locally. The task's
   * worktree is removed first so git will allow checking out the base branch.
   */
  async mergeTask(taskId: Id): Promise<string> {
    const task = await this.#store.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.status !== "succeeded") {
      throw new Error(
        `Task ${taskId} must be succeeded before merge (status: ${task.status})`,
      );
    }
    const project = await this.#store.getProject(task.projectId);
    if (!project) throw new Error(`Unknown project: ${task.projectId}`);
    const ws = await this.#latestWorkspace(taskId);
    if (!ws) throw new Error(`No workspace found for task ${taskId}`);

    // Remove the worktree so the branch is free to be merged/checked out.
    const wt = new WorktreeManager(project.repoPath);
    await wt.remove(ws.path, { force: true }).catch(() => undefined);
    await this.#store.removeWorkspace(ws.id);
    this.#bus.emit({ type: "workspace.removed", taskId, workspaceId: ws.id });

    const remote = new RemoteOps(project.repoPath);
    const base = await remote.baseBranch();
    const sha = await remote.mergeBranch({ branch: ws.branch, base });

    task.merged = true;
    task.updatedAt = new Date().toISOString();
    await this.#store.updateTask(task);
    this.#bus.emit({
      type: "task.merged",
      taskId,
      branch: ws.branch,
      baseBranch: base,
    });
    return sha;
  }

  /** Most recent workspace created for a task (by createdAt, id as tiebreak). */
  async #latestWorkspace(taskId: Id) {
    const all = await this.#store.listWorkspaces();
    const forTask = all
      .filter((w) => w.taskId === taskId)
      .sort((a, b) => {
        const byTime = b.createdAt.localeCompare(a.createdAt);
        // Deterministic tiebreak when timestamps collide (same millisecond).
        return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
      });
    return forTask[0];
  }

  /** Execute one task: worktree → agent → diff → commit, with status/events. */
  async #runTask(project: Project, task: Task, signal?: AbortSignal): Promise<void> {
    const adapter = task.agentId
      ? this.#registry.get(task.agentId)
      : this.#registry.pickForRole(task.role);
    if (!adapter) {
      // No agent can serve this role; mark failed. The status_changed event
      // (emitted by #setStatus) is the observable signal.
      await this.#setStatus(task, "failed");
      return;
    }

    await this.#setStatus(task, "running");
    const attempt = task.attempts + 1;

    const wt = new WorktreeManager(project.repoPath);
    const name = `task-${task.id}-a${attempt}`;
    let workspacePath = "";
    let branch = "";
    let baseRef = "";
    let workspaceId = "";

    try {
      const handle = await wt.create(name);
      workspacePath = handle.path;
      branch = handle.branch;
      baseRef = handle.baseRef;

      const workspace = makeWorkspace({
        projectId: project.id,
        taskId: task.id,
        path: workspacePath,
        branch,
        baseRef,
      });
      workspaceId = workspace.id;
      await this.#store.createWorkspace(workspace);
      this.#bus.emit({
        type: "workspace.created",
        taskId: task.id,
        workspaceId,
        path: workspacePath,
        branch,
      });
    } catch (err) {
      await this.#recordAttemptFailure(task, `worktree creation failed: ${String(err)}`);
      return;
    }

    const session = makeSession({
      taskId: task.id,
      workspaceId,
      agentId: adapter.descriptor.id,
      attempt,
    });
    await this.#store.createSession(session);
    this.#bus.emit({
      type: "session.started",
      taskId: task.id,
      sessionId: session.id,
      agentId: adapter.descriptor.id,
      attempt,
    });

    const localSignal = signal ?? new AbortController().signal;

    try {
      const result = await this.#runtime.execute({
        adapter,
        prompt: task.prompt,
        title: task.title,
        role: task.role,
        workspacePath,
        branch,
        baseRef,
        signal: localSignal,
        onLog: (stream, chunk) =>
          this.#bus.emit({
            type: "session.log",
            taskId: task.id,
            sessionId: session.id,
            stream,
            chunk,
          }),
        onToolCall: (tool, input) =>
          this.#bus.emit({
            type: "session.tool_call",
            taskId: task.id,
            sessionId: session.id,
            tool,
            input,
          }),
        onUsage: (usage) => {
          session.usage.inputTokens += usage.inputTokens ?? 0;
          session.usage.outputTokens += usage.outputTokens ?? 0;
          session.usage.costUsd += usage.costUsd ?? 0;
          session.usage.toolCalls += usage.toolCalls ?? 0;
          this.#bus.emit({
            type: "session.usage",
            taskId: task.id,
            sessionId: session.id,
            usage: { ...session.usage },
          });
        },
      });

      // Capture the diff produced in the worktree.
      const stat = await wt.diffStat(workspacePath, baseRef).catch(() => null);
      if (stat) {
        this.#bus.emit({
          type: "diff.captured",
          taskId: task.id,
          sessionId: session.id,
          filesChanged: stat.filesChanged,
          insertions: stat.insertions,
          deletions: stat.deletions,
        });
      }

      // Commit successful work so it is preserved on the task branch.
      let commitSha: string | undefined;
      if (result.success && (await wt.isDirty(workspacePath))) {
        commitSha = await wt.commitAll(
          workspacePath,
          `agentdock: ${task.title} (${task.role})`,
        );
      }

      session.status = result.success ? "succeeded" : "failed";
      session.exitCode = result.exitCode;
      session.summary = result.summary;
      session.usage = result.usage ?? session.usage;
      session.endedAt = new Date().toISOString();
      await this.#store.updateSession(session);
      this.#bus.emit({
        type: "session.ended",
        taskId: task.id,
        sessionId: session.id,
        status: session.status,
        exitCode: session.exitCode,
      });

      if (result.success) {
        const updated = await this.#store.getTask(task.id);
        if (updated) {
          updated.attempts = attempt;
          updated.commitSha = commitSha;
          updated.updatedAt = new Date().toISOString();
          await this.#store.updateTask(updated);
          // Only gate on approval when the agent actually produced a commit;
          // there is nothing to review/PR/merge for an empty change, so such
          // a task completes immediately.
          if (updated.approvalRequired && commitSha) {
            // Work is committed on the branch but gated: hand off to a human.
            await this.#setStatus(updated, "awaiting_approval");
            this.#bus.emit({
              type: "task.approval_requested",
              taskId: updated.id,
              commitSha,
            });
          } else {
            await this.#setStatus(updated, "succeeded");
          }
        }
      } else {
        await this.#recordAttemptFailure(task, result.summary ?? "agent reported failure");
      }
    } catch (err) {
      session.status = "failed";
      session.endedAt = new Date().toISOString();
      await this.#store.updateSession(session);
      this.#bus.emit({
        type: "session.ended",
        taskId: task.id,
        sessionId: session.id,
        status: "failed",
      });
      await this.#recordAttemptFailure(task, String(err));
    }
  }

  /** Mark an attempt failed; retry (back to ready) if attempts remain. */
  async #recordAttemptFailure(task: Task, _reason: string): Promise<void> {
    const t = await this.#store.getTask(task.id);
    if (!t) return;
    t.attempts += 1;
    t.updatedAt = new Date().toISOString();
    if (t.attempts < t.maxAttempts) {
      await this.#store.updateTask(t);
      await this.#setStatus(t, "ready"); // eligible to run again
    } else {
      await this.#store.updateTask(t);
      await this.#setStatus(t, "failed");
    }
  }

  async #setStatus(task: Task, status: Task["status"]): Promise<void> {
    const t = await this.#store.getTask(task.id);
    if (!t) return;
    const from = t.status;
    if (from === status) return;
    t.status = status;
    t.updatedAt = new Date().toISOString();
    await this.#store.updateTask(t);
    this.#bus.emit({
      type: "task.status_changed",
      taskId: t.id,
      from,
      to: status,
    });
  }

  /** Recompute blocked/ready statuses from dependency completion. */
  async #reconcile(projectId: Id): Promise<void> {
    const tasks = await this.#store.listTasks(projectId);
    const updates = Scheduler.reconcileStatuses(tasks);
    for (const [id, status] of updates) {
      const t = await this.#store.getTask(id);
      if (t) await this.#setStatus(t, status);
    }
  }
}
