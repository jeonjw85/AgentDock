import type {
  AgentDockEvent,
} from "./events.js";
import type {
  Id,
  Project,
  Session,
  Task,
  Workspace,
} from "./domain.js";

/**
 * Persistence contract for AgentDock. Kept deliberately small so alternative
 * backends (SQLite, Postgres, in-memory) can be dropped in without touching
 * the orchestrator.
 *
 * All methods are async to accommodate remote/DB-backed implementations even
 * though the default file store resolves synchronously.
 */
export interface Store {
  // Projects
  createProject(project: Project): Promise<void>;
  getProject(id: Id): Promise<Project | undefined>;
  listProjects(): Promise<Project[]>;

  // Tasks
  createTask(task: Task): Promise<void>;
  updateTask(task: Task): Promise<void>;
  getTask(id: Id): Promise<Task | undefined>;
  listTasks(projectId?: Id): Promise<Task[]>;

  // Workspaces
  createWorkspace(workspace: Workspace): Promise<void>;
  getWorkspace(id: Id): Promise<Workspace | undefined>;
  removeWorkspace(id: Id): Promise<void>;
  listWorkspaces(projectId?: Id): Promise<Workspace[]>;

  // Sessions
  createSession(session: Session): Promise<void>;
  updateSession(session: Session): Promise<void>;
  getSession(id: Id): Promise<Session | undefined>;
  listSessions(taskId?: Id): Promise<Session[]>;

  // Events (append-only observability log)
  appendEvent(event: AgentDockEvent): Promise<void>;
  listEvents(filter?: { taskId?: Id; sessionId?: Id }): Promise<AgentDockEvent[]>;

  /** Flush any buffered state to durable storage. */
  flush(): Promise<void>;
  /** Release resources (file handles, DB connections). */
  close(): Promise<void>;
}
