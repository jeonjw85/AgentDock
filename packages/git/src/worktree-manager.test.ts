import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "./git-runner.js";
import { WorktreeManager } from "./worktree-manager.js";

let repo: string;

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdock-git-"));
  await git(dir, ["init", "-q"]);
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

describe("WorktreeManager", () => {
  it("creates an isolated worktree on a new branch", async () => {
    const wt = new WorktreeManager(repo);
    const handle = await wt.create("task-1");
    expect(handle.branch).toBe("agentdock/task-1");
    const stat = await fs.stat(handle.path);
    expect(stat.isDirectory()).toBe(true);
    const list = await wt.list();
    // git canonicalizes paths (e.g. /var -> /private/var on macOS); compare
    // by basename to stay robust across platforms.
    expect(list.some((w) => path.basename(w.path) === path.basename(handle.path))).toBe(true);
  });

  it("tracks diff stats for new files (via intent-to-add)", async () => {
    const wt = new WorktreeManager(repo);
    const handle = await wt.create("task-2");
    await fs.writeFile(path.join(handle.path, "feature.ts"), "export const x = 1;\n");
    const stat = await wt.diffStat(handle.path, handle.baseRef);
    expect(stat.filesChanged).toBe(1);
    expect(stat.insertions).toBe(1);
  });

  it("commits work and reports clean afterwards", async () => {
    const wt = new WorktreeManager(repo);
    const handle = await wt.create("task-3");
    await fs.writeFile(path.join(handle.path, "a.txt"), "hello\n");
    expect(await wt.isDirty(handle.path)).toBe(true);
    const sha = await wt.commitAll(handle.path, "add a.txt");
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await wt.isDirty(handle.path)).toBe(false);
  });

  it("removes a worktree", async () => {
    const wt = new WorktreeManager(repo);
    const handle = await wt.create("task-4");
    await wt.remove(handle.path, { force: true });
    const list = await wt.list();
    expect(list.some((w) => w.path === handle.path)).toBe(false);
  });
});
