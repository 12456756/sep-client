/** Provider-neutral tool policy. SDK-specific hooks live in electron/pi/sdk. */

export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
export const APPROVAL_TOOLS = new Set(['bash', 'write', 'edit'])

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName)
}

export function requiresToolApproval(toolName: string): boolean {
  return APPROVAL_TOOLS.has(toolName)
}

export function isKnownTool(toolName: string): boolean {
  return isReadOnlyTool(toolName) || requiresToolApproval(toolName)
}
