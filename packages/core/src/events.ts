import type { Id, Timestamp, UsageMetrics } from "./domain.js";

/**
 * AgentDock's observability backbone. Every meaningful state change emits an
 * event. Events are append-only and ordered, enabling session replay, cost
 * accounting, and live monitoring.
 */

export type EventType =
  | "task.created"
  | "task.status_changed"
  | "task.approval_requested"
  | "task.approved"
  | "task.rejected"
  | "task.pr_opened"
  | "task.merged"
  | "workspace.created"
  | "workspace.removed"
  | "session.started"
  | "session.ended"
  | "session.log"
  | "session.tool_call"
  | "session.usage"
  | "diff.captured";

interface BaseEvent {
  id: Id;
  type: EventType;
  at: Timestamp;
  /** Correlates events belonging to the same task. */
  taskId?: Id;
  /** Correlates events belonging to the same session. */
  sessionId?: Id;
}

export interface TaskCreatedEvent extends BaseEvent {
  type: "task.created";
  taskId: Id;
  title: string;
  role: string;
}

export interface TaskStatusChangedEvent extends BaseEvent {
  type: "task.status_changed";
  taskId: Id;
  from: string;
  to: string;
}

export interface TaskApprovalRequestedEvent extends BaseEvent {
  type: "task.approval_requested";
  taskId: Id;
  commitSha?: string;
}

export interface TaskApprovedEvent extends BaseEvent {
  type: "task.approved";
  taskId: Id;
  approvedBy?: string;
}

export interface TaskRejectedEvent extends BaseEvent {
  type: "task.rejected";
  taskId: Id;
  reason?: string;
}

export interface TaskPrOpenedEvent extends BaseEvent {
  type: "task.pr_opened";
  taskId: Id;
  url: string;
  branch: string;
}

export interface TaskMergedEvent extends BaseEvent {
  type: "task.merged";
  taskId: Id;
  branch: string;
  baseBranch: string;
}

export interface WorkspaceCreatedEvent extends BaseEvent {
  type: "workspace.created";
  workspaceId: Id;
  path: string;
  branch: string;
}

export interface WorkspaceRemovedEvent extends BaseEvent {
  type: "workspace.removed";
  workspaceId: Id;
}

export interface SessionStartedEvent extends BaseEvent {
  type: "session.started";
  sessionId: Id;
  agentId: Id;
  attempt: number;
}

export interface SessionEndedEvent extends BaseEvent {
  type: "session.ended";
  sessionId: Id;
  status: string;
  exitCode?: number;
}

export interface SessionLogEvent extends BaseEvent {
  type: "session.log";
  sessionId: Id;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface SessionToolCallEvent extends BaseEvent {
  type: "session.tool_call";
  sessionId: Id;
  tool: string;
  input?: unknown;
}

export interface SessionUsageEvent extends BaseEvent {
  type: "session.usage";
  sessionId: Id;
  usage: UsageMetrics;
}

export interface DiffCapturedEvent extends BaseEvent {
  type: "diff.captured";
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export type AgentDockEvent =
  | TaskCreatedEvent
  | TaskStatusChangedEvent
  | TaskApprovalRequestedEvent
  | TaskApprovedEvent
  | TaskRejectedEvent
  | TaskPrOpenedEvent
  | TaskMergedEvent
  | WorkspaceCreatedEvent
  | WorkspaceRemovedEvent
  | SessionStartedEvent
  | SessionEndedEvent
  | SessionLogEvent
  | SessionToolCallEvent
  | SessionUsageEvent
  | DiffCapturedEvent;
