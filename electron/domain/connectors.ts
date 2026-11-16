import type { ConnectorId, ConnectorState, QQMailCredentials } from '../../src/shared/connectors'
import type { TaskOwnerScope } from '../data/scope-path'

export class ConnectorInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ConnectorInputError' }
}

export interface ConnectorBinding {
  revision: string
  servers: readonly { name: string; transport: { type: 'streamable-http'; url: string }; enabledTools: string[] }[]
  fetch: typeof fetch
  commands?: readonly ConnectorCommandBinding[]
}
export interface ConnectorCommandBinding {
  id: ConnectorId
  name: string
  instructions: { reference: string; schema: string; execute: string }
  reference(path: string, signal?: AbortSignal): Promise<string>
  schema(path: string, signal?: AbortSignal): Promise<ConnectorCommandResult>
  execute(args: string[], workspaceDir: string, signal?: AbortSignal): Promise<ConnectorCommandResult>
}
export interface ConnectorCommandResult { text: string; isError: boolean; executionUncertain?: true }
export interface ConnectorRegistryPort {
  provider(id: ConnectorId): Promise<ConnectorRuntimePort>
  binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined>
  cancel(): void
}
export interface ConnectorRuntimePort {
  state(scope: TaskOwnerScope): Promise<ConnectorState>
  connect(scope: TaskOwnerScope, credentials?: QQMailCredentials): Promise<void>
  disconnect(scope: TaskOwnerScope): Promise<void>
  binding(scope: TaskOwnerScope): Promise<ConnectorBinding | undefined>
  cancel(): void
}
