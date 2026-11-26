import type { ConnectorCredentials, ConnectorId, ConnectorState } from '../../src/shared/connectors'
import type { ToolApprovalSummary } from '../../src/shared/tool-approval'
import type { TaskOwnerScope } from '../data/scope-path'

export class ConnectorInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ConnectorInputError' }
}

export interface ConnectorBinding {
  revision: string
  servers: readonly { name: string; transport: { type: 'streamable-http'; url: string }; enabledTools: string[] }[]
  remoteReadOnlyTools?: Readonly<Record<string, readonly string[]>>
  fetch: typeof fetch
  commands?: readonly ConnectorCommandBinding[]
}
export interface ConnectorCommandBinding {
  id: ConnectorId
  name: string
  instructions: { reference: string; schema: string; execute: string }
  reference(path: string, signal?: AbortSignal): Promise<string>
  schema(path: string, signal?: AbortSignal): Promise<ConnectorCommandResult>
  evaluateCommand?(args: string[]): ConnectorCommandDecision | undefined
  isScheduledReadOnly?(args: string[]): boolean
  scheduledOperation?(args: string[]): ScheduledExternalOperation | undefined
  execute(args: string[], workspaceDir: string, signal?: AbortSignal): Promise<ConnectorCommandResult>
}
export interface ScheduledExternalOperation {
  identity: readonly unknown[]; target?: string
  dingTalkAction?: import('../../src/shared/scheduled-tasks').ScheduledOperation['dingTalkAction']
}
export interface ScheduledToolExecution {
  isActive?(signal?: AbortSignal): Promise<boolean>
  recordBlocked?(tool: string, reason: NonNullable<import('../../src/shared/scheduled-tasks').ScheduledOperation['reason']>): Promise<void>
  issue(): Promise<import('../../src/shared/scheduled-tasks').ScheduledIssue | undefined>
  submit(tool: string, operation: ScheduledExternalOperation, signal: AbortSignal | undefined,
    invoke: () => Promise<ConnectorCommandResult>): Promise<ConnectorCommandResult>
}
export type BindScheduledTools = (scope: TaskOwnerScope, origin: import('../../src/shared/scheduled-tasks').ScheduledOrigin,
  taskId: string, planHash: string) => ScheduledToolExecution
export type ConnectorCommandDecision = { kind: 'read' } | { kind: 'approval'; summary: ToolApprovalSummary }
export interface ConnectorCommandResult {
  text: string; isError: boolean; executionUncertain?: true; notExecuted?: true
  scheduledReason?: import('../../src/shared/scheduled-tasks').ScheduledOperation['reason']
}
export interface ConnectorRegistryPort {
  provider(id: ConnectorId): Promise<ConnectorRuntimePort>
  binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined>
  cancel(): void
}
export interface ConnectorRuntimePort {
  state(scope: TaskOwnerScope): Promise<ConnectorState>
  connect(scope: TaskOwnerScope, credentials?: ConnectorCredentials): Promise<void>
  disconnect(scope: TaskOwnerScope): Promise<void>
  binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined>
  cancel(): void
}
