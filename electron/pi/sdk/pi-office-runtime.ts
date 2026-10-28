import type { PiAgentSessionConfig, McpServerConfig } from './pi-agent-runtime'
import type { CommonSkillsResult } from './common-skills'
import { createMcpRuntime, type McpRuntime } from './pi-mcp-client'
import { evaluateOfficeCommand, OFFICE_TOOL_NAME } from './pi-office-policy'
import type { ToolPolicy } from '../../../pi-extension/guard'

// Shared across employee sessions; independent files can still proceed concurrently.
const fileTails = new Map<string, Promise<void>>()
export async function withOfficeFileLock<T>(key: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  if (!key) return run()
  const previous = fileTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>(done => { release = done })
  const tail = previous.then(() => held)
  fileTails.set(key, tail)
  let onAbort: (() => void) | undefined
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal?.reason ?? new Error('Office command cancelled.'))
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    await Promise.race([previous, cancelled])
    signal?.throwIfAborted()
    return await run()
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    release()
    // A cancelled waiter cannot release another session's still-running write.
    void tail.then(() => { if (fileTails.get(key) === tail) fileTails.delete(key) })
  }
}

function normalizedLockPaths(paths: string[]): string[] {
  return [...new Set(paths.map(path => process.platform === 'win32' ? path.toLowerCase() : path))].sort()
}

export async function withOfficeFileLocks<T>(
  paths: string[], signal: AbortSignal | undefined, run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted()
  const keys = normalizedLockPaths(paths)
  const acquire = (index: number): Promise<T> => index === keys.length ? run()
    : withOfficeFileLock(keys[index], signal, () => acquire(index + 1))
  return acquire(0)
}

function sameLockPaths(left: string[], right: string[]): boolean {
  const a = normalizedLockPaths(left)
  const b = normalizedLockPaths(right)
  return a.length === b.length && a.every((path, index) => path === b[index])
}

export function officeTaskPolicy(config: Pick<PiAgentSessionConfig, 'toolPolicy' | 'workspaceDir'>): ToolPolicy {
  return config.toolPolicy ?? { allowedTools: ['read', 'write', 'edit'], allowedPaths: [config.workspaceDir],
    deniedPaths: [], commandPolicy: 'disabled', approvalMode: 'confirm-each', workspaceDir: config.workspaceDir }
}

export function officeMcpServer(executable: string): McpServerConfig {
  return { name: 'officecli', transport: { type: 'stdio', command: executable, args: ['mcp'],
    env: { OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_RESIDENT_FLUSH: 'each' } },
    enabledTools: ['officecli'], autoApproveTools: [], timeoutMs: 120_000 }
}

/** Optional Office startup cannot take down unrelated tools or employee tasks. */
export async function attachOfficeRuntime(
  base: McpRuntime, common: CommonSkillsResult, config: PiAgentSessionConfig,
): Promise<{ runtime: McpRuntime; enabled: boolean }> {
  if (!common.office) return { runtime: base, enabled: false }
  let office: McpRuntime
  try { office = await createMcpRuntime([officeMcpServer(common.office.executable)], config.workspaceDir) }
  catch {
    await config.reportPolicyEvent?.('common_skill_unavailable', { skillId: 'officecli', reason: 'Office MCP startup failed.' })
    return { runtime: base, enabled: false }
  }
  let interrupted = false
  let officeClosing: Promise<void> | undefined
  const closeOffice = (): Promise<void> => officeClosing ??= office.dispose()
  const tools = office.tools.map(tool => ({
    ...tool,
    async execute(...args: Parameters<typeof tool.execute>) {
      let decision = evaluateOfficeCommand(args[1], officeTaskPolicy(config))
      if (!decision.allowed) return { content: [{ type: 'text' as const, text: decision.reason ?? 'Office command denied.' }],
        details: { serverName: 'officecli', toolName: 'officecli', isError: true } }
      for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = await withOfficeFileLocks(decision.lockPaths, args[2], async () => {
          if (interrupted) return { result: { content: [{ type: 'text' as const,
            text: 'Office connection was closed after an interrupted call. Check the file before continuing in a new session.' }],
            details: { serverName: 'officecli', toolName: 'officecli', isError: true } } }
          // Recheck the original request after waiting; files or symlinks might have changed during approval/queuing.
          const current = evaluateOfficeCommand(args[1], officeTaskPolicy(config))
          if (!current.allowed) throw new Error(current.reason)
          if (!sameLockPaths(decision.lockPaths, current.lockPaths)) return { retry: current }
          const result = await tool.execute(args[0], { command: current.args }, args[2])
          if (result.details.executionUncertain) {
            interrupted = true
            // A cancellation response is not proof that the upstream write has stopped.
            await closeOffice()
            result.content.push({ type: 'text', text: 'Office connection closed. The write may have completed; verify the file before any retry.' })
          }
          return { result }
        })
        if (outcome.result) return outcome.result
        if (!outcome.retry) throw new Error('Office command lock validation failed.')
        decision = outcome.retry
      }
      throw new Error('Office command paths changed repeatedly while waiting for the file lock.')
    },
  }))
  let closing: Promise<void> | undefined
  return { enabled: true, runtime: { builtinOffice: true, tools: [...base.tools, ...tools],
    permissions: new Map([...base.permissions, [OFFICE_TOOL_NAME, 'confirm-each' as const]]),
    dispose: () => closing ??= Promise.all([base.dispose(), closeOffice()]).then(() => undefined) } }
}
