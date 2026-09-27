import * as path from "node:path";
import { promises as fs } from "node:fs";
import { git } from "./git-runner.js";

export interface WorktreeHandle {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch checked out in the worktree. */
  branch: string;
  /** Ref the branch was created from. */
  baseRef: string;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface FileChange {
  /** Git status code, e.g. "M", "A", "D", "R". */
  status: string;
  path: string;
}

/**
 * Manages git worktrees so each task gets a fully isolated checkout on its own
 * branch. Worktrees live under `<repo>/.worktrees/<name>` by default and share
 * the repo's object store, making creation cheap even for large repos.
 */
export class WorktreeManager {
  constructor(
    private readonly repoPath: string,
    private readonly worktreesDir = path.join(repoPath, ".worktrees"),
  ) {}

  /** Verify the repo path is a git repository. */
  async assertRepo(): Promise<void> {
    await git(this.repoPath, ["rev-parse", "--git-dir"]);
  }

  /** Resolve the current HEAD commit of the base repository. */
  async headRef(): Promise<string> {
    const { stdout } = await git(this.repoPath, ["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  /**
   * Create an isolated worktree on a new branch.
   *
   * @param name    Unique worktree/branch identifier (e.g. "task-231-backend").
   * @param baseRef Ref to branch from. Defaults to current HEAD.
   */
  async create(name: string, baseRef?: string): Promise<WorktreeHandle> {
    await this.assertRepo();
    const base = baseRef ?? (await this.headRef());
    const wtPath = path.join(this.worktreesDir, name);
    const branch = `agentdock/${name}`;

    await fs.mkdir(this.worktreesDir, { recursive: true });
    await git(this.repoPath, [
      "worktree",
      "add",
      "-b",
      branch,
      wtPath,
      base,
    ]);

    return { path: wtPath, branch, baseRef: base };
  }

  /** Remove a worktree. Uses --force to drop uncommitted changes when asked. */
  async remove(wtPath: string, opts: { force?: boolean } = {}): Promise<void> {
    const args = ["worktree", "remove", wtPath];
    if (opts.force) args.push("--force");
    await git(this.repoPath, args, { allowFailure: false });
  }

  /** List worktrees known to git (porcelain-parsed). */
  async list(): Promise<{ path: string; branch?: string; head?: string }[]> {
    const { stdout } = await git(this.repoPath, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const entries: { path: string; branch?: string; head?: string }[] = [];
    let current: { path: string; branch?: string; head?: string } | null = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current) entries.push(current);
        current = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("branch ") && current) {
        current.branch = line.slice("branch ".length);
      } else if (line.startsWith("HEAD ") && current) {
        current.head = line.slice("HEAD ".length);
      }
    }
    if (current) entries.push(current);
    return entries;
  }

  // -------------------------------------------------------------------------
  // Diff tracking
  // -------------------------------------------------------------------------

  /** Numeric diff stat of the worktree against its base ref. */
  async diffStat(wtPath: string, baseRef: string): Promise<DiffStat> {
    // Record untracked files as intent-to-add so `git diff` counts them,
    // without staging their contents. This makes brand-new files appear in
    // the diff against the base ref.
    await git(wtPath, ["add", "-A", "-N"], { allowFailure: true });
    const { stdout } = await git(wtPath, [
      "diff",
      "--numstat",
      baseRef,
    ]);
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [add, del] = line.split("\t");
      filesChanged++;
      // Binary files report "-"; treat as 0.
      insertions += add === "-" ? 0 : Number(add) || 0;
      deletions += del === "-" ? 0 : Number(del) || 0;
    }
    return { filesChanged, insertions, deletions };
  }

  /** Unified diff patch of the worktree against its base ref. */
  async diffPatch(wtPath: string, baseRef: string): Promise<string> {
    const { stdout } = await git(wtPath, ["diff", baseRef]);
    return stdout;
  }

  /** List changed files (working tree vs base) with status codes. */
  async changedFiles(wtPath: string, baseRef: string): Promise<FileChange[]> {
    const { stdout } = await git(wtPath, [
      "diff",
      "--name-status",
      baseRef,
    ]);
    const changes: FileChange[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = parts[0] ?? "";
      const file = parts[parts.length - 1] ?? "";
      changes.push({ status, path: file });
    }
    return changes;
  }

  // -------------------------------------------------------------------------
  // Commit helpers
  // -------------------------------------------------------------------------

  /** Stage all changes and commit. Returns the new commit SHA. */
  async commitAll(wtPath: string, message: string): Promise<string> {
    await git(wtPath, ["add", "-A"]);
    await git(wtPath, ["commit", "-m", message, "--no-verify"], {
      allowFailure: true, // no-op commit when nothing staged
    });
    const { stdout } = await git(wtPath, ["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  /** True if the worktree has uncommitted changes. */
  async isDirty(wtPath: string): Promise<boolean> {
    const { stdout } = await git(wtPath, ["status", "--porcelain"]);
    return stdout.trim().length > 0;
  }
}
