# Changelog

All notable changes to AgentDock are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-27

The first release of AgentDock, an open-source runtime for orchestrating
multiple AI coding agents across isolated git worktrees.

### Added

**Core engine**
- `@agentdock/core`: serializable domain models (Project, Task, Workspace,
  Session, Event), a synchronous `EventBus`, and a pluggable `Store` with a
  dependency-free JSON `FileStore` (plus `MemoryStore` for tests).
- `@agentdock/git`: `WorktreeManager` for per-task isolated git worktrees with
  branch isolation, diff tracking (stat/patch/name-status, untracked files via
  intent-to-add), and commit helpers.
- `@agentdock/adapters`: the `AgentAdapter` contract, an `AdapterRegistry` with
  role-based selection, a deterministic `MockAdapter`, and a generic
  `CliAdapter` for wrapping any command-line agent.
- `@agentdock/runtime`: `LocalRuntime` and a sandboxed `DockerRuntime`.
- `@agentdock/orchestrator`: a pure DAG `Scheduler` (cycle detection, runnable
  waves, status reconciliation), a `Planner` (default backend/frontend/review
  decomposition + single-task), and the `Orchestrator` engine with
  concurrency, retries, session recording, and diff capture.
- `@agentdock/cli`: the `agentdock` command.

**Real agent integration**
- `ClaudeCodeAdapter` driving Anthropic's Claude Code CLI, with a pure
  `ClaudeStreamParser` for its `stream-json` output (tool calls, token usage,
  cost). Registerable via `--agent claude-code` or
  `AGENTDOCK_DEFAULT_AGENT=claude-code`.

**Human-in-the-loop workflow**
- Approval gates: tasks can require human approval. A gated task that produces
  a commit is parked in a new `awaiting_approval` status until approved;
  dependents stay blocked until then.
- `RemoteOps`: push task branches, open pull requests via the GitHub CLI
  (`gh`) with graceful fallback when no remote/`gh` is present, and merge task
  branches into the base branch (`--no-ff`).
- Orchestrator methods: `pendingApprovals`, `approveTask`, `rejectTask`,
  `openPullRequest`, `mergeTask`.
- CLI commands: `approve`, `reject`, `pr`, `merge`; `plan --gate <role>`,
  `add --approve`; approval/PR/merge markers in `status`; approval pause and
  resume hints in `run`.
- New events: `task.approval_requested`, `task.approved`, `task.rejected`,
  `task.pr_opened`, `task.merged`.

**Observability**
- Every state change flows through the event bus and is persisted for replay
  via `agentdock events`; `agentdock sessions` reports per-session token usage
  and cost.

### Fixed
- Diff capture now counts brand-new (untracked) files by using git
  intent-to-add before diffing.
- A successful task that produced no commit is no longer parked awaiting
  approval (there is nothing to review); it completes immediately.
- `RemoteOps.openPullRequest` degrades gracefully instead of throwing when the
  GitHub CLI exists but fails (e.g. auth), preserving the "never throw" contract.
- `Orchestrator` selects a task's latest workspace deterministically when
  timestamps collide.

### Notes
- Ships with mock adapters so the full pipeline runs offline with no external
  agent installed.
- Requires Node.js 22.13 or newer and git. Optional: Docker (sandbox runtime),
  GitHub CLI `gh` (pull requests).

[0.1.0]: https://github.com/your-org/agentdock/releases/tag/v0.1.0
