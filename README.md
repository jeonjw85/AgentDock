# AgentDock

[![CI](https://github.com/jeonjw85/AgentDock/actions/workflows/ci.yml/badge.svg)](https://github.com/jeonjw85/AgentDock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An open-source runtime for orchestrating multiple AI coding agents across isolated git worktrees.

[한국어 문서](README.ko.md)

AgentDock does not replace Claude Code, Codex, Kiro, OpenCode, or Gemini. It runs on top of them. You get a single place to break a task down, hand the pieces to several agents at once, keep each agent in its own git worktree so they never step on each other, and watch cost, tool calls, and diffs across the whole run.

```
                        AgentDock
                            |
        +-------------------+-------------------+
        v                   v                   v
    Claude Code           Codex             OpenCode        (via adapters)
        |                   |                   |
        +-------------------+-------------------+
                            |
                    Workspace Runtime  (local or docker)
                            |
        +-------------------+-------------------+
        v                   v                   v
    Git Worktree         Sandbox             Diff Tracking
        |
        v
       Repo
```

## Why

Most developers now use coding agents daily, and often more than one at a time. The problem is that each agent manages its own git, terminal, context, tasks, and permissions on its own. There is no shared control plane. AgentDock is that control plane:

- One task graph, split across many agents (planner, workers, reviewer).
- Isolation by default. Every task runs on its own branch in its own git worktree, so agents never overwrite each other's work.
- One place to observe everything. Sessions, token usage, cost, tool calls, and diffs all flow through a single event bus.
- Extensible through adapters. Any CLI coding agent plugs in by implementing one small interface.

## Quickstart

You need Node.js 20 or newer and git.

```bash
# from the AgentDock repo
pnpm install
pnpm build

# in your own project repo
node /path/to/AgentDock/packages/cli/dist/bin.js init --name my-project

# break an issue into a backend/frontend/review task graph
agentdock plan "OAuth login" --desc "Implement OAuth login end to end"

# run all tasks to completion
agentdock run

# inspect
agentdock status
agentdock sessions      # token usage and cost per session
agentdock worktrees     # isolated checkouts created per task
agentdock events        # full event log (session replay)
```

AgentDock ships with mock adapters, so the whole pipeline runs offline with no external agent installed. To wire in a real agent such as Claude Code, Codex, or OpenCode, see [docs/adapters.md](docs/adapters.md).

## Example flow

```
Issue: "OAuth login"
   |
   v  Planner breaks it down
   |- work:   OAuth login - backend    (run in parallel,
   |- work:   OAuth login - frontend    each in its own worktree)
   |- review: OAuth login - review     (waits for both, then reviews)

repo/
+-- .worktrees/
    |-- task-<id>-a1/   (agentdock/task-<id>-a1 branch)   backend
    |-- task-<id>-a1/   (agentdock/task-<id>-a1 branch)   frontend
    +-- task-<id>-a1/   (agentdock/task-<id>-a1 branch)   review
```

Work that succeeds is committed to the task branch automatically.

## Packages

| Package | Responsibility |
|---|---|
| `@agentdock/core` | Domain models, event bus, pluggable persistence (`Store`). |
| `@agentdock/git` | Worktree lifecycle, diff tracking, commit helpers. |
| `@agentdock/adapters` | The `AgentAdapter` contract, registry, and built-in mock and generic CLI adapters. |
| `@agentdock/runtime` | Execution backends: `LocalRuntime` and `DockerRuntime` (sandbox). |
| `@agentdock/orchestrator` | DAG scheduler, planner, retries, and the orchestration engine. |
| `@agentdock/cli` | The `agentdock` command. |

## Commands

```
agentdock init [--name <name>]                 Initialize AgentDock in a repo
agentdock plan <title> [--desc <text>]         Break work into a task graph
             [--planner default|single] [--gate review|work|plan]
agentdock add <title> [--role work|review|plan]  Add a single task
             [--agent <id>] [--max-attempts <n>] [--desc <text>] [--approve]
agentdock run [--concurrency <n>]              Run pending tasks to completion
agentdock approve <taskId> [--by <name>]       Approve a task waiting for approval
agentdock reject <taskId> [--reason <text>]    Reject a task waiting for approval
agentdock pr <taskId> [--body <text>]          Push the branch and open a PR (via gh)
agentdock merge <taskId>                       Merge a succeeded task into the base
agentdock status                               Task graph status
agentdock sessions                             Sessions with usage and cost
agentdock worktrees                            Tracked worktrees
agentdock events [--task <id>]                 Event log and session replay
agentdock agents                               Registered adapters
```

## Human-in-the-loop workflow

You can gate a stage behind human approval, then push a PR and merge:

```bash
# require approval on the review stage
agentdock plan "OAuth login" --desc "..." --gate review
agentdock run                     # runs the workers, then pauses at the gated review
agentdock status                  # the task shows a lock, waiting for approval
agentdock approve <taskId> --by me
agentdock run                     # continues now that it is approved

# open a pull request for a task's branch (needs a remote and gh)
agentdock pr <taskId>

# or merge the task branch into the base branch locally
agentdock merge <taskId>
```

If there is no `origin` remote or the GitHub CLI is not installed, `pr` falls back gracefully and tells you to open the PR yourself. The local flow still works.

## Development

```bash
pnpm install
pnpm build       # tsc project references across all packages
pnpm test        # vitest (unit and integration)
pnpm typecheck
```

## Design docs

- [ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.
- [docs/adapters.md](docs/adapters.md) walks through writing an adapter for your agent.

## Status and roadmap

AgentDock is an early foundation. What works today: task decomposition, DAG scheduling with retries, worktree isolation, diff capture, session and cost observability, local and Docker runtimes, a pluggable adapter layer, a real Claude Code adapter, and a human-in-the-loop workflow (approval gates, PR creation through `gh`, and branch merge).

On the roadmap:

- First-class adapters for Codex, OpenCode, and Gemini.
- A live TUI or web dashboard that reads the event bus.
- SQLite and Postgres `Store` backends for larger setups.
- Checkpoints and resumable runs.
- MCP tool support.

## License

MIT
