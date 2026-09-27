import { nanoid } from "nanoid";
import {
  emptyUsage,
  type Project,
  type Session,
  type Task,
  type TaskInput,
  type Workspace,
} from "./domain.js";

const now = (): string => new Date().toISOString();

export function makeProject(name: string, repoPath: string): Project {
  return { id: nanoid(), name, repoPath, createdAt: now() };
}

export function makeTask(input: TaskInput): Task {
  const ts = now();
  return {
    id: nanoid(),
    projectId: input.projectId,
    parentId: input.parentId,
    role: input.role,
    title: input.title,
    prompt: input.prompt,
    status: (input.dependsOn?.length ?? 0) > 0 ? "blocked" : "ready",
    dependsOn: input.dependsOn ? [...input.dependsOn] : [],
    agentId: input.agentId,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 1,
    approvalRequired: input.approvalRequired ?? false,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function makeWorkspace(args: {
  projectId: string;
  taskId: string;
  path: string;
  branch: string;
  baseRef: string;
}): Workspace {
  return {
    id: nanoid(),
    projectId: args.projectId,
    taskId: args.taskId,
    path: args.path,
    branch: args.branch,
    baseRef: args.baseRef,
    createdAt: now(),
  };
}

export function makeSession(args: {
  taskId: string;
  workspaceId: string;
  agentId: string;
  attempt: number;
}): Session {
  return {
    id: nanoid(),
    taskId: args.taskId,
    workspaceId: args.workspaceId,
    agentId: args.agentId,
    attempt: args.attempt,
    status: "running",
    startedAt: now(),
    usage: emptyUsage(),
  };
}
