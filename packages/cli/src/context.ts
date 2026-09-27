import * as path from "node:path";
import { promises as fs } from "node:fs";
import {
  FileStore,
  makeProject,
  type Project,
  type Store,
} from "@agentdock/core";

export const AGENTDOCK_DIR = ".agentdock";
export const STORE_FILE = "store.json";

/** Absolute path to the AgentDock data directory for a repo. */
export function dockDir(repoPath: string): string {
  return path.join(repoPath, AGENTDOCK_DIR);
}

export function storePath(repoPath: string): string {
  return path.join(dockDir(repoPath), STORE_FILE);
}

/** Open the file-backed store for a repo. */
export async function openStore(repoPath: string): Promise<Store> {
  return FileStore.open(storePath(repoPath));
}

/** Ensure the repo has been initialized; returns the single project. */
export async function requireProject(
  store: Store,
  repoPath: string,
): Promise<Project> {
  const projects = await store.listProjects();
  const p = projects.find((x) => path.resolve(x.repoPath) === path.resolve(repoPath));
  if (!p) {
    throw new Error(
      `Not an AgentDock project. Run "agentdock init" in the repo first.`,
    );
  }
  return p;
}

/** Initialize AgentDock in a repo: create data dir + project record. */
export async function initProject(
  repoPath: string,
  name?: string,
): Promise<Project> {
  await fs.mkdir(dockDir(repoPath), { recursive: true });
  const store = await openStore(repoPath);
  const existing = (await store.listProjects()).find(
    (x) => path.resolve(x.repoPath) === path.resolve(repoPath),
  );
  if (existing) {
    await store.close();
    return existing;
  }
  const project = makeProject(name ?? path.basename(repoPath), path.resolve(repoPath));
  await store.createProject(project);
  await store.close();
  return project;
}
