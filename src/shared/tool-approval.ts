export const BROWSER_HANDOFF_TIMEOUT_MS = 180_000

export function isBrowserHandoffRequest(request: { toolName: string; input: unknown }): boolean {
  return request.toolName === 'mcp__playwright__browser_set_mode'
    && typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input)
    && 'operation' in request.input && request.input.operation === 'manual-handoff'
}

export function toolApprovalTimeoutMs(request: { toolName: string; input: unknown }): number {
  return isBrowserHandoffRequest(request) ? BROWSER_HANDOFF_TIMEOUT_MS : 60_000
}
