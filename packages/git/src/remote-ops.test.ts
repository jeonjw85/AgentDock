import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "./git-runner.js";
import { WorktreeManager } from "./worktree-manager.js";
import { RemoteOps } from "./remote-ops.js";

let repo: string;

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdock-remote-"));
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

describe("RemoteOps", () => {
  it("reports the base branch", async () => {
    const remote = new RemoteOps(repo);
    expect(await remote.baseBranch()).toBe("main");
  });

  it("reports no remote and does not push when origin is absent", async () => {
    const remote = new RemoteOps(repo);
    expect(await remote.hasRemote()).toBe(false);
    expect(await remote.pushBranch("agentdock/x")).toBe(false);
  });

  it("openPullRequest degrades gracefully with no remote", async () => {
    const remote = new RemoteOps(repo);
    const pr = await remote.openPullRequest({
      branch: "agentdock/x",
      base: "main",
      title: "t",
    });
    expect(pr.created).toBe(false);
    expect(pr.detail).toMatch(/remote/i);
  });

  it("merges a task branch into base with a real commit", async () => {
    const wt = new WorktreeManager(repo);
    const handle = await wt.create("task-merge");
    await fs.writeFile(path.join(handle.path, "feature.txt"), "new feature\n");
    await wt.commitAll(handle.path, "add feature");

    // Free the branch by removing the worktree before merge.
    await wt.remove(handle.path, { force: true });

    const remote = new RemoteOps(repo);
    const sha = await remote.mergeBranch({ branch: handle.branch, base: "main" });
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);

    // The merged file must now exist on main.
    const onMain = await git(repo, ["show", "main:feature.txt"]);
    expect(onMain.stdout).toContain("new feature");

    // A merge commit was created (--no-ff).
    const log = await git(repo, ["log", "--oneline", "--merges", "-1"]);
    expect(log.stdout.trim()).not.toBe("");
  });

  it("restores the original branch after merge", async () => {
    const wt = new WorktreeManager(repo);
    const handle = await wt.create("task-restore");
    await fs.writeFile(path.join(handle.path, "a.txt"), "x\n");
    await wt.commitAll(handle.path, "add a");
    await wt.remove(handle.path, { force: true });

    const before = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const remote = new RemoteOps(repo);
    await remote.mergeBranch({ branch: handle.branch, base: "main" });
    const after = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    expect(after).toBe(before);
  });
});
