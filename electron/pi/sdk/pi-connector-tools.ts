import { Type } from 'typebox'
import { z } from 'zod'
import { ConnectorInputError } from '../../domain/connectors'
import type { ConnectorBinding, ConnectorCommandResult, ScheduledToolExecution } from '../../domain/connectors'
import { mcpToolName, type McpRuntime, type McpToolResult } from './pi-mcp-client'

const executeInput = z.object({ args: z.array(z.string()).min(2).max(128) }).strict()

export function attachConnectorTools(runtime: McpRuntime, binding: ConnectorBinding | undefined, workspaceDir: string, scheduled?: ScheduledToolExecution): McpRuntime {
  if (!binding) return runtime
  const permissions = new Map(runtime.permissions)
  const scheduledConnectorExecutors = new Set(runtime.scheduledConnectorExecutors)
  const remote = new Map(binding.servers.flatMap(server => server.enabledTools.map(name => [mcpToolName(server.name, name), {
    readOnly: binding.remoteReadOnlyTools?.[server.name]?.includes(name) === true,
  }] as const)))
  const remoteTools = runtime.tools.map(tool => {
    const bound = remote.get(tool.name)
    if (!scheduled || !bound) return tool
    scheduledConnectorExecutors.add(tool.name)
    return { ...tool, async execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
      const result = (value: ConnectorCommandResult): McpToolResult => ({ content: [{ type: 'text', text: value.text }],
        details: { serverName: 'connector', toolName: tool.name, isError: value.isError,
          ...(value.executionUncertain ? { executionUncertain: true as const } : {}) } })
      if (scheduled.isActive && !await scheduled.isActive(signal)) return result({ text: '本次定时任务已停止，未调用连接器。', isError: true })
      if (bound.readOnly) {
        const read = await tool.execute(id, params, signal)
        return { ...read, details: { ...read.details, scheduledReadOnly: true } }
      }
      let raw: McpToolResult | undefined
      const outcome = await scheduled.submit(tool.name, { identity: ['remote', params] }, signal, async () => {
        raw = await tool.execute(id, params, signal)
        return { text: raw.content.map(item => item.text).join('\n'), ...raw.details }
      })
      return raw && !outcome.executionUncertain ? raw : result(outcome)
    } }
  })
  const tools = (binding.commands ?? []).flatMap(provider => {
    const tool = (kind: 'reference' | 'schema' | 'execute', execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ConnectorCommandResult>) => {
      const name = `${provider.id}_${kind}`
      permissions.set(name, kind === 'execute' ? 'confirm-each' : 'auto-approve')
      if (scheduled && kind === 'execute') scheduledConnectorExecutors.add(name)
      const field = kind === 'execute' ? 'args' : 'path'
      return {
        name, label: `${provider.name}：${kind}`, description: provider.instructions[kind], promptSnippet: provider.instructions[kind],
        parameters: Type.Unsafe<Record<string, unknown>>({ type: 'object', properties: { [field]: kind === 'execute'
          ? { type: 'array', minItems: 2, maxItems: 128, items: { type: 'string', maxLength: 64000 } }
          : { type: 'string', maxLength: 256 } }, required: [field], additionalProperties: false }),
        executionMode: 'sequential' as const,
        async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<McpToolResult> {
          let readOnly = false
          const response = (result: ConnectorCommandResult): McpToolResult => ({ content: [{ type: 'text', text: result.text }],
            details: { serverName: provider.id, toolName: name, isError: result.isError,
              ...(readOnly ? { scheduledReadOnly: true } : {}), ...(result.executionUncertain ? { executionUncertain: true } : {}) } })
          try {
            let result: ConnectorCommandResult
            if (scheduled?.isActive && !await scheduled.isActive(signal)) {
              result = { text: '本次定时任务已停止或执行资格已变化，未调用连接器。', isError: true, notExecuted: true, scheduledReason: 'cancelled' }
            } else if (kind === 'execute' && scheduled) {
              const parsed = executeInput.safeParse(params)
              if (!parsed.success) throw new ConnectorInputError('连接器参数不符合工具契约。')
              const { args } = parsed.data
              readOnly = provider.isScheduledReadOnly?.(args) === true || provider.evaluateCommand?.(args)?.kind === 'read'
              if (readOnly) result = await execute(params, signal)
              else {
                const operation = provider.scheduledOperation?.(args) ?? { identity: ['command', args] }
                result = await scheduled.submit(name, operation, signal, () => execute(params, signal))
              }
            } else result = await execute(params, signal)
            return response(result)
          } catch (error) { return response({ text: error instanceof ConnectorInputError ? `调用未执行：${error.message} 这不表示账号已断开。` : `${provider.name}调用未完成，请核对官方说明和连接状态。`, isError: true }) }
        },
      }
    }
    return [
      tool('reference', async (params, signal) => ({ text: await provider.reference(String(params.path), signal), isError: false })),
      tool('schema', (params, signal) => provider.schema(String(params.path), signal)),
      tool('execute', (params, signal) => provider.execute(params.args as string[], workspaceDir, signal)),
    ]
  })
  return { ...runtime, tools: [...remoteTools, ...tools], permissions, scheduledConnectorExecutors, evaluateConnectorCommand(toolName, input) {
    const provider = binding.commands?.find(command => `${command.id}_execute` === toolName)
    const parsed = executeInput.safeParse(input)
    if (parsed.success) return provider?.evaluateCommand?.(parsed.data.args)
  } }
}
