import type { WorkPlan } from '../domain/arrangement-plan'

export interface TaskToolPolicy {
  allowedTools: readonly string[]
  allowedPaths: readonly string[]
  deniedPaths: readonly string[]
  commandPolicy: 'disabled' | 'restricted' | 'confirm-each'
  approvalMode: 'confirm-each' | 'auto-approve'
  workspaceDir: string
}

export interface EmployeeRuntimeConfig {
  subscriptionId: string
  modelId: string
  gatewayUrl: string

  additionalSkillPaths?: string[]
}

export type SessionRecoveryMode = 'strict' | 'confirm_rebuild' | 'auto_rebuild_from_task_history'

export type ControlIntent = 'none' | 'pause' | 'cancel' | 'stop' | 'interrupt'

export interface TaskWorkerPort {
  run(prompt: string): Promise<void>
  abort(): Promise<void>
  dispose(): Promise<void>
}

export interface QueuedRun {
  taskId: string
  runId: string
  subscriptionId: string

  employee: EmployeeRuntimeConfig
  prompt: string
  conversation: boolean
  resumeSessionFile?: string

  workerPrompt?: string
  degradedRecovery?: { originalSessionFile: string; mode: SessionRecoveryMode }
  arrangement?: WorkPlan
}

export interface ActiveRun {
  taskId: string
  runId: string
  subscriptionId: string
  releaseWorkspace: () => void
  worker: TaskWorkerPort
  controlReason?: string
  control: ControlIntent
  completion: Promise<void>
}


