import type { Store } from "./store.js";
import type {
  Id,
  Project,
  Session,
  Task,
  Workspace,
} from "./domain.js";
import type { AgentDockEvent } from "./events.js";

/**
 * In-memory store. Useful for tests and ephemeral runs. All data is lost on
 * process exit. Serves as the reference implementation of {@link Store}.
 */
export class MemoryStore implements Store {
  protected projects = new Map<Id, Project>();
  protected tasks = new Map<Id, Task>();
  protected workspaces = new Map<Id, Workspace>();
  protected sessions = new Map<Id, Session>();
  protected events: AgentDockEvent[] = [];

  async createProject(project: Project): Promise<void> {
    this.projects.set(project.id, { ...project });
  }
  async getProject(id: Id): Promise<Project | undefined> {
    const p = this.projects.get(id);
    return p ? { ...p } : undefined;
  }
  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()].map((p) => ({ ...p }));
  }

  async createTask(task: Task): Promise<void> {
    this.tasks.set(task.id, { ...task, dependsOn: [...task.dependsOn] });
  }
  async updateTask(task: Task): Promise<void> {
    this.tasks.set(task.id, { ...task, dependsOn: [...task.dependsOn] });
  }
  async getTask(id: Id): Promise<Task | undefined> {
    const t = this.tasks.get(id);
    return t ? { ...t, dependsOn: [...t.dependsOn] } : undefined;
  }
  async listTasks(projectId?: Id): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((t) => !projectId || t.projectId === projectId)
      .map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));
  }

  async createWorkspace(workspace: Workspace): Promise<void> {
    this.workspaces.set(workspace.id, { ...workspace });
  }
  async getWorkspace(id: Id): Promise<Workspace | undefined> {
    const w = this.workspaces.get(id);
    return w ? { ...w } : undefined;
  }
  async removeWorkspace(id: Id): Promise<void> {
    this.workspaces.delete(id);
  }
  async listWorkspaces(projectId?: Id): Promise<Workspace[]> {
    return [...this.workspaces.values()]
      .filter((w) => !projectId || w.projectId === projectId)
      .map((w) => ({ ...w }));
  }

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session, usage: { ...session.usage } });
  }
  async updateSession(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session, usage: { ...session.usage } });
  }
  async getSession(id: Id): Promise<Session | undefined> {
    const s = this.sessions.get(id);
    return s ? { ...s, usage: { ...s.usage } } : undefined;
  }
  async listSessions(taskId?: Id): Promise<Session[]> {
    return [...this.sessions.values()]
      .filter((s) => !taskId || s.taskId === taskId)
      .map((s) => ({ ...s, usage: { ...s.usage } }));
  }

  async appendEvent(event: AgentDockEvent): Promise<void> {
    this.events.push(event);
  }
  async listEvents(filter?: { taskId?: Id; sessionId?: Id }): Promise<AgentDockEvent[]> {
    return this.events.filter((e) => {
      if (filter?.taskId && e.taskId !== filter.taskId) return false;
      if (filter?.sessionId && e.sessionId !== filter.sessionId) return false;
      return true;
    });
  }

  async flush(): Promise<void> {
    /* nothing to flush */
  }
  async close(): Promise<void> {
    /* nothing to close */
  }
}
