/**
 * Task management types shared between main and renderer
 */

export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  WAITING_APPROVAL = 'waiting_approval',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum TaskLogLevel {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  SUCCESS = 'success',
}

export interface TaskLog {
  timestamp: Date;
  level: TaskLogLevel;
  message: string;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  workDir: string;
  status: TaskStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  logs: TaskLog[];
  files: string[];
  error?: string;
}

export interface TaskStats {
  total: number;
  pending: number;
  running: number;
  waiting_approval: number;
  paused: number;
  completed: number;
  failed: number;
}

export interface ToolApprovalRequest {
  taskId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: Date;
}
