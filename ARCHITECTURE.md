# Architecture

AgentDock is a layered monorepo. Each package has one responsibility and depends
only on the layers beneath it, so any layer can be replaced without rewriting the
others.

```
                       ┌───────────────────────┐
                       │   @agentdock/cli       │  agentdock command
                       └───────────┬───────────┘
                                   │
                       ┌───────────▼───────────┐
                       │ @agentdock/orchestrator│  DAG scheduler, planner, engine
                       └───┬─────────┬─────────┬┘
              ┌────────────┘         │         └────────────┐
   ┌──────────▼─────────┐ ┌──────────▼───────┐ ┌────────────▼───────┐
   │  @agentdock/git     │ │ @agentdock/runtime│ │ @agentdock/adapters │
   │  worktrees + diffs  │ │ local | docker    │ │ AgentAdapter + reg. │
   └──────────┬─────────┘ └──────────┬───────┘ └────────────┬───────┘
              └───────────────┬──────┴──────────────────────┘
                       ┌───────▼────────┐
                       │ @agentdock/core │  domain models, event bus, Store
                       └────────────────┘
```

## Design principles

1. **Serializable domain, everywhere.** Tasks, sessions, workspaces, and events
   are plain data (`packages/core/src/domain.ts`). That makes them trivial to
   persist, transmit, and replay.
2. **One event bus for all observability.** Every state change is emitted through
   `EventBus`. The orchestrator subscribes a persistence sink; a TUI or web
   dashboard can subscribe the same stream. Nothing is observed by polling.
3. **Isolation is structural, not advisory.** Each task attempt gets a fresh git
   worktree on its own branch. Agents cannot see or clobber each other because
   they are literally in different directories on different branches.
4. **Adapters over integrations.** AgentDock never hardcodes a specific agent.
   Any CLI agent implements one small interface (`AgentAdapter`) and is
   orchestrated identically to every other.
5. **Pluggable seams.** `Store`, `Runtime`, `Planner`, and `AgentAdapter` are all
   interfaces with a default implementation. You can swap SQLite for the file
   store, Docker for local, or an LLM planner for the rule-based one without
   touching the engine.

## Data model

- **Project.** A repository AgentDock operates on.
- **Task.** A unit of work with a `role` (`plan`, `work`, or `review`), a prompt,
  a status, and `dependsOn` edges forming a DAG. Carries `attempts` and
  `maxAttempts` for retries.
- **Workspace.** An isolated git worktree created for a single task attempt.
- **Session.** One execution of an agent against a task inside a workspace.
  Accumulates `UsageMetrics` (tokens, cost, tool calls).
- **Event.** An append-only record of everything that happened, which enables replay.

## Execution lifecycle

```
plan/add ──► Task(s) persisted, status computed (ready|blocked)
                │
run ──► validate DAG (no cycles)
                │
                ▼   loop until all tasks terminal
        ┌───────────────────────────────────────────────┐
        │ Scheduler.runnable(tasks)  → wave (≤ concurrency)│
        │   for each task in wave, in parallel:            │
        │     1. pick adapter by agentId or role           │
        │     2. WorktreeManager.create() → isolated branch│
        │     3. Runtime.execute(adapter, ctx)             │
        │        streams logs / tool calls / usage → bus   │
        │     4. capture diff stat → bus                   │
        │     5. commit work on success                    │
        │     6. update session + task status              │
        │        └ failure & attempts<max → back to ready  │
        │ reconcile blocked→ready as deps complete         │
        └───────────────────────────────────────────────┘
```

The scheduler (`packages/orchestrator/src/scheduler.ts`) is pure and stateless:
given the current task list it answers *what can run now*, *is there a cycle*, and
*is the graph complete*. All mutation and I/O lives in the `Orchestrator`.

## Concurrency & isolation

- Runnable tasks execute in waves capped by `concurrency`.
- Each attempt gets a uniquely named worktree (`task-<id>-a<attempt>`), so retries
  never reuse dirty state.
- Worktrees share the base repo's object store, so creation is cheap even on large
  repos.

## Runtimes

- **LocalRuntime.** Runs the adapter in-process, operating on the worktree
  directory. Fast, with no isolation beyond the worktree.
- **DockerRuntime.** Runs the agent inside a container with the worktree
  bind-mounted, isolating filesystem and network from the host. Recommended for
  autonomous or untrusted agents.

Both satisfy the `Runtime` interface, and the orchestrator is agnostic to which
one is in use.

## Persistence

The default `FileStore` writes a single JSON snapshot atomically (temp file plus
rename) after every mutation, with writes serialized through a promise chain so
concurrent mutations never interleave a half-written file. It has zero native
dependencies, so AgentDock installs on any Node 22.13 or newer without a build
step.
For larger deployments, implement `Store` against SQLite or Postgres. The
interface is small and the orchestrator depends only on it.

## Extending AgentDock

| Want to | Implement or swap |
|---|---|
| Integrate a new agent | `AgentAdapter` (see docs/adapters.md) |
| Change how tasks decompose | `Planner` |
| Sandbox execution differently | `Runtime` |
| Store state in a database | `Store` |
| Build a live dashboard | subscribe to `EventBus` |
