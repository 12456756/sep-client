export type ConversationArtifactDirectory =
  | { status: 'ready'; relativePath: string }
  | { status: 'retry-in-prompt' | 'unsafe'; relativePath: string }

export interface ConversationArtifactStorePort {
  prepare(workspace: string, taskId: string): Promise<ConversationArtifactDirectory>
  scan(workspace: string, taskId: string): Promise<string[]>
}
