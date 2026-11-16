import { Type } from 'typebox'
import { ConnectorInputError } from '../../domain/connectors'
import type { ConnectorBinding, ConnectorCommandResult } from '../../domain/connectors'
import type { McpRuntime, McpToolResult } from './pi-mcp-client'

export function attachConnectorTools(runtime: McpRuntime, binding: ConnectorBinding | undefined, workspaceDir: string): McpRuntime {
  if (!binding?.commands?.length) return runtime
  const permissions = new Map(runtime.permissions)
  const tools = binding.commands.flatMap(provider => {
    const tool = (kind: 'reference' | 'schema' | 'execute', execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ConnectorCommandResult>) => {
      const name = `${provider.id}_${kind}`
      permissions.set(name, kind === 'execute' ? 'confirm-each' : 'auto-approve')
      const field = kind === 'execute' ? 'args' : 'path'
      return {
        name, label: `${provider.name}：${kind}`, description: provider.instructions[kind], promptSnippet: provider.instructions[kind],
        parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object', properties: { [field]: kind === 'execute'
          ? { type: 'array', minItems: 2, maxItems: 128, items: { type: 'string', maxLength: 64000 } }
          : { type: 'string', maxLength: 256 } }, required: [field], additionalProperties: false }),
        executionMode: 'sequential' as const,
        async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<McpToolResult> {
          try {
            const result = await execute(params, signal)
            return { content: [{ type: 'text', text: result.text }], details: { serverName: provider.id, toolName: name, isError: result.isError, ...(result.executionUncertain ? { executionUncertain: true as const } : {}) } }
          } catch (error) { return { content: [{ type: 'text', text: error instanceof ConnectorInputError ? `调用未执行：${error.message} 这不表示账号已断开。` : `${provider.name}调用未完成，请核对官方说明和连接状态。` }], details: { serverName: provider.id, toolName: name, isError: true } } }
        },
      }
    }
    return [
      tool('reference', async (params, signal) => ({ text: await provider.reference(String(params.path), signal), isError: false })),
      tool('schema', (params, signal) => provider.schema(String(params.path), signal)),
      tool('execute', (params, signal) => provider.execute(params.args as string[], workspaceDir, signal)),
    ]
  })
  return { ...runtime, tools: [...runtime.tools, ...tools], permissions }
}
