import { spawn } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Runs a git command as an argv array (never a shell string) to avoid command
 * injection. Rejects on non-zero exit unless `allowFailure` is set.
 */
export async function git(
  cwd: string,
  args: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const result: GitResult = { stdout, stderr, code: code ?? -1 };
      if (code === 0 || opts.allowFailure) {
        resolve(result);
      } else {
        reject(
          new GitError(
            `git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`,
            args,
            result,
          ),
        );
      }
    });
  });
}
