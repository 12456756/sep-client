import { BROWSER_MODE_TOOL } from './pi-browser-runtime'
import { BROWSER_SAVE_ASSETS } from './pi-browser-page-tools'
import type { McpRuntime } from './pi-mcp-client'
import { isRoutineBrowserCall } from './pi-playwright-mcp'

export function allowsScheduledRegisteredTool(runtime: McpRuntime, toolName: string, input: unknown): boolean {
  if (runtime.scheduledConnectorExecutors?.has(toolName)) return true
  if (!runtime.builtinBrowser || !toolName.startsWith('mcp__playwright__')) return runtime.permissions.get(toolName) === 'auto-approve'
  if (toolName === BROWSER_MODE_TOOL || toolName === BROWSER_SAVE_ASSETS) return false
  if (toolName === 'mcp__playwright__browser_navigate' || toolName === 'mcp__playwright__browser_snapshot') return isRoutineBrowserCall(toolName, input)
  return runtime.permissions.has(toolName)
}
