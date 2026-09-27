import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileStore } from "./file-store.js";
import { makeProject, makeTask } from "./factory.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentdock-store-"));
  file = path.join(dir, "store.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("FileStore", () => {
  it("persists and reloads projects and tasks", async () => {
    const store = await FileStore.open(file);
    const project = makeProject("demo", "/tmp/repo");
    await store.createProject(project);
    const task = makeTask({ projectId: project.id, role: "work", title: "t", prompt: "p" });
    await store.createTask(task);
    await store.close();

    const reopened = await FileStore.open(file);
    const projects = await reopened.listProjects();
    const tasks = await reopened.listTasks(project.id);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("demo");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("t");
    await reopened.close();
  });

  it("appends and filters events", async () => {
    const store = await FileStore.open(file);
    await store.appendEvent({
      id: "e1",
      type: "task.created",
      at: new Date().toISOString(),
      taskId: "t1",
      title: "x",
      role: "work",
    });
    await store.appendEvent({
      id: "e2",
      type: "task.created",
      at: new Date().toISOString(),
      taskId: "t2",
      title: "y",
      role: "work",
    });
    const forT1 = await store.listEvents({ taskId: "t1" });
    expect(forT1).toHaveLength(1);
    expect(forT1[0]!.id).toBe("e1");
    await store.close();
  });

  it("writes valid JSON to disk", async () => {
    const store = await FileStore.open(file);
    await store.createProject(makeProject("demo", "/tmp/repo"));
    await store.flush();
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.projects).toHaveLength(1);
    await store.close();
  });
});
