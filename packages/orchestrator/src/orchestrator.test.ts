import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore, makeProject } from "@agentdock/core";
import { AdapterRegistry, MockAdapter } from "@agentdock/adapters";
import { git } from "@agentdock/git";
import { Orchestrator } from "./orchestrator.js";
import { DefaultPlanner } from "./planner.js";

let repo: string;

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdock-orch-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@test.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(dir, "README.md"), "# demo\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "init"]);
  return dir;
}

beforeEach(async () => {
  repo = await initRepo();
});
afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

function registry(): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register(new MockAdapter({ id: "worker", roles: ["work"] }));
  r.register(new MockAdapter({ id: "reviewer", roles: ["review", "plan"] }));
  return r;
}

describe("Orchestrator (integration)", () => {
  it("runs a decomposed plan to completion respecting dependencies", async () => {
    const store = new MemoryStore();
    const project = makeProject("demo", repo);
    await store.createProject(project);

    const orch = new Orchestrator({ store, registry: registry(), planner: new DefaultPlanner() });
    const tasks = await orch.planAndCreate({
      projectId: project.id,
      title: "OAuth login",
      description: "implement it",
    });
    expect(tasks).toHaveLength(3);

    const report = await orch.run(project.id);
    expect(report.succeeded).toBe(true);
    expect(report.tasks.every((t) => t.status === "succeeded")).toBe(true);

    // Reviewer must have started after both workers succeeded.
    const review = report.tasks.find((t) => t.role === "review")!;
    const reviewSession = report.sessions.find((s) => s.taskId === review.id)!;
    const workerSessions = report.sessions.filter((s) => s.taskId !== review.id);
    for (const ws of workerSessions) {
      expect(new Date(reviewSession.startedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(ws.endedAt!).getTime(),
      );
    }

    // Usage aggregated across 3 sessions.
    expect(report.totalUsage.toolCalls).toBe(3);
    expect(report.sessions).toHaveLength(3);
  });

  it("captures a real diff produced by the agent", async () => {
    const store = new MemoryStore();
    const project = makeProject("demo", repo);
    await store.createProject(project);

    const r = new AdapterRegistry();
    r.register(
      new MockAdapter({
        id: "writer",
        roles: ["work"],
        effect: async (wsPath) => {
          await fs.writeFile(path.join(wsPath, "new-feature.ts"), "export const feature = true;\n");
        },
      }),
    );

    const orch = new Orchestrator({ store, registry: r });
    const task = await orch.addTask({
      projectId: project.id,
      role: "work",
      title: "build feature",
      prompt: "do it",
    });
    await orch.run(project.id);

    const events = await store.listEvents({ taskId: task.id });
    const diff = events.find((e) => e.type === "diff.captured");
    expect(diff).toBeDefined();
    if (diff && diff.type === "diff.captured") {
      expect(diff.filesChanged).toBe(1);
      expect(diff.insertions).toBe(1);
    }
  });

  it("retries a failing task up to maxAttempts then marks failed", async () => {
    const store = new MemoryStore();
    const project = makeProject("demo", repo);
    await store.createProject(project);

    const r = new AdapterRegistry();
    r.register(new MockAdapter({ id: "flaky", roles: ["work"], fail: true }));

    const orch = new Orchestrator({ store, registry: r });
    const task = await orch.addTask({
      projectId: project.id,
      role: "work",
      title: "flaky",
      prompt: "x",
      maxAttempts: 3,
    });
    const report = await orch.run(project.id);

    expect(report.succeeded).toBe(false);
    const final = report.tasks.find((t) => t.id === task.id)!;
    expect(final.status).toBe("failed");
    expect(final.attempts).toBe(3);
    // One session per attempt.
    expect(report.sessions.filter((s) => s.taskId === task.id)).toHaveLength(3);
  });

  it("rejects a plan containing a dependency cycle", async () => {
    const store = new MemoryStore();
    const project = makeProject("demo", repo);
    await store.createProject(project);

    const orch = new Orchestrator({ store, registry: registry() });
    const a = await orch.addTask({ projectId: project.id, role: "work", title: "a", prompt: "" });
    const b = await orch.addTask({
      projectId: project.id,
      role: "work",
      title: "b",
      prompt: "",
      dependsOn: [a.id],
    });
    // Introduce a cycle: a depends on b.
    a.dependsOn = [b.id];
    await store.updateTask(a);

    await expect(orch.run(project.id)).rejects.toThrow(/cycle/i);
  });
});

describe("Orchestrator approval + merge (integration)", () => {
  function writerRegistry(): AdapterRegistry {
    const r = new AdapterRegistry();
    r.register(
      new MockAdapter({
        id: "writer",
        roles: ["work", "review"],
        effect: async (wsPath) => {
          await fs.writeFile(path.join(wsPath, "out.txt"), "content\n");
        },
      }),
    );
    return r;
  }

  it("parks a gated task in awaiting_approval, then completes after approval", async () => {
    const store = new MemoryStore();
    const project = makeProject("demo", repo);
    await store.createProject(project);

    const orch = new Orchestrator({ store, registry: writerRegistry() });
    const task = await orch.addTask({
      projectId: project.id,
      role: "work",
      title: "gated",
      prompt: "do it",
      approvalRequired: true,
    });

    const report = await orch.run(project.id);
    expect(report.waitingForApproval).toBe(true);
    expect(report.succeeded).toBe(false);

    const pending = await orch.pendingApprovals(project.id);
    expect(pending.map((t) => t.id)).toEqual([task.id]);
    expect(pending[0]!.commitSha).toBeTruthy();

    const approved = await orch.approveTask(task.id, "alice");
    expect(approved.status).toBe("succeeded");
    expect(approved.approvedBy).toBe("alice");

    const report2 = await orch.run(project.id);
    expect(report2.succeeded).toBe(true);
  });

  it("does NOT gate a successful task that produced no commit (Bug #1)", async () => {
    const store = new MemoryStore();
    const project = makeProject("demo", repo);
    await store.createProject(project);

    // Default MockAdapter with no effect writes a marker file, so force a
    // truly no-op agent to exercise the empty-change path.
    const r = new AdapterRegistry();
    r.register(
      new MockAdapter({
        id: "noop",
        roles: ["work"],
        effect: async () => {
          /* writes nothing */
        },
      }),
    );

    const orch = new Orchestrator({ store, registry: r });
    const task = await orch.addTask({
      projectId: project.id,
      role: "work",
      title: "empty",
      prompt: "do nothing",
      approvalRequired: true,
    });

    const report = await orch.run(project.id);
    // No commit → no gate → immediately succeeded, not awaiting_approval.
    expect(report.waitingForApproval).toBe(false);
    const final = report.tasks.find((t) => t.id === task.id)!;
    expect(final.status).toBe("succeeded");
    expect(final.commitSha).toBeUndefined();
  });

  it("rejection marks the task failed and blocks dependents", async () => {
    const store = new MemoryStore();
    const project = makeProject("demo", repo);
    await store.createProject(project);

    const orch = new Orchestrator({ store, registry: writerRegistry() });
    const work = await orch.addTask({
      projectId: project.id,
      role: "work",
      title: "work",
      prompt: "x",
      approvalRequired: true,
    });
    const review = await orch.addTask({
      projectId: project.id,
      role: "review",
      title: "review",
      prompt: "y",
      dependsOn: [work.id],
    });

    await orch.run(project.id);
    const rejected = await orch.rejectTask(work.id, "not good enough");
    expect(rejected.status).toBe("failed");
    expect(rejected.rejectionReason).toBe("not good enough");

    const report = await orch.run(project.id);
    expect(report.succeeded).toBe(false);
    const rev = report.tasks.find((t) => t.id === review.id)!;
    expect(rev.status).toBe("blocked");
  });

  it("merges an approved task's branch into the base branch", async () => {
    const store = new MemoryStore();
    const project = makeProject("demo", repo);
    await store.createProject(project);

    const orch = new Orchestrator({ store, registry: writerRegistry() });
    const task = await orch.addTask({
      projectId: project.id,
      role: "work",
      title: "mergeable",
      prompt: "x",
    });
    await orch.run(project.id);

    const sha = await orch.mergeTask(task.id);
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    const merged = await store.getTask(task.id);
    expect(merged!.merged).toBe(true);

    // File exists on the base branch now.
    const onBase = await git(repo, ["show", "main:out.txt"]);
    expect(onBase.stdout).toContain("content");
  });
});
