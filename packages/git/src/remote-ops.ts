import { spawn } from "node:child_process";
import { git } from "./git-runner.js";

/** Result of opening a pull request. */
export interface PrResult {
  /** Whether a PR was actually created via the platform CLI (e.g. gh). */
  created: boolean;
  /** PR URL when created; otherwise a message explaining the fallback. */
  url?: string;
  /** Human-readable detail (e.g. why gh was unavailable). */
  detail?: string;
}

/** Whether a command exists on PATH. */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Git operations that touch the base repository and remotes: pushing task
 * branches, opening pull requests (via the GitHub CLI `gh`), and merging.
 *
 * Everything degrades gracefully: if there is no remote or `gh` is not
 * installed/authenticated, methods report what happened instead of throwing,
 * so a fully local workflow still works end to end.
 */
export class RemoteOps {
  constructor(private readonly repoPath: string) {}

  /** Name of the repo's default/base branch (e.g. "main"). */
  async baseBranch(): Promise<string> {
    // Prefer the symbolic ref of origin/HEAD; fall back to current branch.
    const originHead = await git(
      this.repoPath,
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { allowFailure: true },
    );
    const ref = originHead.stdout.trim();
    if (ref) {
      const parts = ref.split("/");
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    const cur = await git(this.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return cur.stdout.trim() || "main";
  }

  /** True if the repo has at least one remote named `origin`. */
  async hasRemote(name = "origin"): Promise<boolean> {
    const res = await git(this.repoPath, ["remote"], { allowFailure: true });
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .includes(name);
  }

  /** Push a branch to origin, setting upstream. No-op-safe when no remote. */
  async pushBranch(branch: string, remote = "origin"): Promise<boolean> {
    if (!(await this.hasRemote(remote))) return false;
    await git(this.repoPath, ["push", "-u", remote, branch]);
    return true;
  }

  /**
   * Open a pull request for `branch` into `base` using the GitHub CLI.
   * Falls back gracefully (created:false) when there's no remote or gh.
   */
  async openPullRequest(args: {
    branch: string;
    base: string;
    title: string;
    body?: string;
  }): Promise<PrResult> {
    if (!(await this.hasRemote())) {
      return { created: false, detail: "no 'origin' remote configured" };
    }
    if (!(await commandExists("gh"))) {
      return {
        created: false,
        detail: "GitHub CLI 'gh' not found; push succeeded, open the PR manually",
      };
    }
    const ghArgs = [
      "pr",
      "create",
      "--head",
      args.branch,
      "--base",
      args.base,
      "--title",
      args.title,
      "--body",
      args.body ?? args.title,
    ];
    // Never throw on a gh failure: honor the "degrade gracefully" contract and
    // report it as a non-created PrResult so callers can guide the user.
    return new Promise<PrResult>((resolve) => {
      const child = spawn("gh", ghArgs, { cwd: this.repoPath });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) =>
        resolve({ created: false, detail: `gh failed to spawn: ${e.message}` }),
      );
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ created: true, url: out.trim() });
        } else {
          resolve({
            created: false,
            detail: `gh pr create failed (exit ${code}); branch pushed, open the PR manually: ${
              err.trim() || out.trim()
            }`,
          });
        }
      });
    });
  }

  /**
   * Merge `branch` into `base` in the base repository using a non-fast-forward
   * merge, then return the resulting base HEAD SHA. Runs entirely locally.
   *
   * The caller is responsible for ensuring no worktree currently holds `base`
   * checked out in a conflicting state.
   */
  async mergeBranch(args: {
    branch: string;
    base: string;
    message?: string;
  }): Promise<string> {
    // Remember current branch to restore afterwards.
    const cur = (
      await git(this.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();

    await git(this.repoPath, ["checkout", args.base]);
    try {
      await git(this.repoPath, [
        "merge",
        "--no-ff",
        "-m",
        args.message ?? `agentdock: merge ${args.branch} into ${args.base}`,
        args.branch,
      ]);
      const sha = (await git(this.repoPath, ["rev-parse", "HEAD"])).stdout.trim();
      return sha;
    } catch (err) {
      // A conflicting merge leaves MERGE_HEAD and a conflicted index behind,
      // which blocks any later checkout/operation. Abort it so the base repo
      // is returned to a clean state before we rethrow and restore the branch.
      await git(this.repoPath, ["merge", "--abort"], { allowFailure: true });
      throw err;
    } finally {
      // Restore prior branch when it differs and still exists.
      if (cur && cur !== args.base && cur !== "HEAD") {
        await git(this.repoPath, ["checkout", cur], { allowFailure: true });
      }
    }
  }
}
