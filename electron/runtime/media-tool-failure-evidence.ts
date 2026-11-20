import { MAX_DIAGNOSTIC_TOOL_FAILURES, type WorkDiagnosticCapture } from '../domain/arrangement-diagnostic'
import { captureDiagnosticException } from '../errors/arrangement-diagnostic'

export function trackMediaToolFailureEvidence() {
  const entries: NonNullable<WorkDiagnosticCapture['mediaToolFailures']>['entries'] = []
  let total = 0
  function add(tool: string, error: unknown): void {
    entries.push({ tool, timestamp: Date.now(), exception: captureDiagnosticException(error) })
    if (entries.length > MAX_DIAGNOSTIC_TOOL_FAILURES) entries.shift()
    total++
  }
  return {
    wrap<Name extends string>(tools: { names: readonly Name[]; execute(name: Name, input: unknown, signal?: AbortSignal): Promise<unknown> } | undefined) {
      if (!tools) return undefined
      return { ...tools, execute: async (name: Name, input: unknown, signal?: AbortSignal) => {
        try {
          const result = await tools.execute(name, input, signal)
          if (result && typeof result === 'object' && 'ok' in result && result.ok === false && 'error' in result) add(name, result.error)
          return result
        } catch (error) {
          add(name, error)
          throw error
        }
      } }
    },
    history: () => total ? { total, entries: [...entries] } : undefined,
  }
}
