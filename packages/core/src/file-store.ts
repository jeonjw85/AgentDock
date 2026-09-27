import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MemoryStore } from "./memory-store.js";
import type { AgentDockEvent } from "./events.js";
import type { Project, Session, Task, Workspace } from "./domain.js";

interface Snapshot {
  version: 1;
  projects: Project[];
  tasks: Task[];
  workspaces: Workspace[];
  sessions: Session[];
  events: AgentDockEvent[];
}

/**
 * Durable, dependency-free store backed by a single JSON file.
 *
 * State is held in memory (via {@link MemoryStore}) for fast reads and written
 * back atomically. This keeps AgentDock installable on any Node version with
 * no native build step. For high-throughput deployments a SQLite/Postgres
 * {@link Store} can be substituted without changing callers.
 */
export class FileStore extends MemoryStore {
  #file: string;
  #dirty = false;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(file: string) {
    super();
    this.#file = file;
  }

  /** Open (or create) a store at the given file path, loading existing data. */
  static async open(file: string): Promise<FileStore> {
    const store = new FileStore(file);
    await store.#load();
    return store;
  }

  async #load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.#file, "utf8");
      const snap = JSON.parse(raw) as Snapshot;
      for (const p of snap.projects ?? []) this.projects.set(p.id, p);
      for (const t of snap.tasks ?? []) this.tasks.set(t.id, t);
      for (const w of snap.workspaces ?? []) this.workspaces.set(w.id, w);
      for (const s of snap.sessions ?? []) this.sessions.set(s.id, s);
      this.events = snap.events ?? [];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Fresh store: nothing to load.
    }
  }

  #snapshot(): Snapshot {
    return {
      version: 1,
      projects: [...this.projects.values()],
      tasks: [...this.tasks.values()],
      workspaces: [...this.workspaces.values()],
      sessions: [...this.sessions.values()],
      events: this.events,
    };
  }

  /** Serialize writes and persist atomically via temp-file + rename. */
  override async flush(): Promise<void> {
    this.#writeChain = this.#writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      const data = JSON.stringify(this.#snapshot(), null, 2);
      await fs.writeFile(tmp, data, "utf8");
      await fs.rename(tmp, this.#file);
      this.#dirty = false;
    });
    return this.#writeChain;
  }

  override async close(): Promise<void> {
    if (this.#dirty) await this.flush();
    else await this.#writeChain;
  }

  // Mark dirty and auto-flush after each mutation. Writes are chained so
  // concurrent mutations never interleave a half-written file.
  #touch(): void {
    this.#dirty = true;
  }

  override async createProject(p: Project): Promise<void> {
    await super.createProject(p);
    this.#touch();
    await this.flush();
  }
  override async createTask(t: Task): Promise<void> {
    await super.createTask(t);
    this.#touch();
    await this.flush();
  }
  override async updateTask(t: Task): Promise<void> {
    await super.updateTask(t);
    this.#touch();
    await this.flush();
  }
  override async createWorkspace(w: Workspace): Promise<void> {
    await super.createWorkspace(w);
    this.#touch();
    await this.flush();
  }
  override async removeWorkspace(id: string): Promise<void> {
    await super.removeWorkspace(id);
    this.#touch();
    await this.flush();
  }
  override async createSession(s: Session): Promise<void> {
    await super.createSession(s);
    this.#touch();
    await this.flush();
  }
  override async updateSession(s: Session): Promise<void> {
    await super.updateSession(s);
    this.#touch();
    await this.flush();
  }
  override async appendEvent(e: AgentDockEvent): Promise<void> {
    await super.appendEvent(e);
    this.#touch();
    await this.flush();
  }
}
