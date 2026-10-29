import type { WorkPlan } from '../domain/arrangement-plan'
import type { EmployeeProfile } from '../domain/employee-profile'

export interface TaskToolPolicy {
  /** Persisted preset; full-local + auto-approve is the unrestricted mode. */
  preset?: 'read-only' | 'workspace-edit' | 'full-local'
  allowedTools: readonly string[]
  allowedPaths: readonly string[]
  deniedPaths: readonly string[]
  commandPolicy: 'disabled' | 'restricted' | 'confirm-each'
  approvalMode: 'confirm-each' | 'auto-approve'
  workspaceDir: string
  readableDeliveryPaths?: readonly string[]
  /** Exact host-verified attachment snapshots; read-only grants only. */
  readableAttachmentPaths?: readonly string[]
}

export interface EmployeeRuntimeConfig {
  subscriptionId: string
  modelId: string
  gatewayUrl: string

  additionalSkillPaths?: string[]
  systemPrompt?: string
  media?: unknown
  video?: import('../../src/shared/video-media').VideoRuntime
  runtimeSnapshot?: import('../common/platform/employee-runtime-contract').EmployeeRuntimeSnapshot
  employeeProfile?: EmployeeProfile
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
  attachmentRefs?: import('../../src/shared/attachment-contracts').AttachmentRef[]
  knowledge?: import('../../src/shared/knowledge-selection').KnowledgeSelection
}

export interface ActiveRun {
  taskId: string
  runId: string
  subscriptionId: string
  releaseWorkspace: () => void
  worker: TaskWorkerPort
  abortController?: AbortController
  controlReason?: string
  control: ControlIntent
  completion: Promise<void>
}


