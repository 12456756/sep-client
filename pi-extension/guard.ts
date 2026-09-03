/**
 * Provider-neutral tool policy. SDK-specific hooks live in electron/pi/sdk.
 *
 * 副作用工具清单不在这里定义——它有三个用途（审批、停机、崩溃恢复），
 * 唯一定义点是 electron/common/constants.ts（方案第 6 章）。
 * 这个文件只负责"策略"：哪些算只读、哪些需要批准、哪些是未知工具。
 */
import { hasSideEffects } from '../electron/common/constants'

export const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])

export function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(toolName)
}

export function requiresToolApproval(toolName: string): boolean {
  return hasSideEffects(toolName)
}

export function isKnownTool(toolName: string): boolean {
  return isReadOnlyTool(toolName) || requiresToolApproval(toolName)
}
