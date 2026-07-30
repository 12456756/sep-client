/**
 * pi-extension/guard.ts — 权限拦截扩展
 *
 * 拦截 high-risk 工具调用，弹窗请求用户审批。
 * 低风险工具（read-only）自动放行。
 */

import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

interface GuardConfig {
  /** 异步工具审批回调 (返回 true = 允许执行, false = 拦截) */
  onToolApprovalRequest: (request: { toolName: string; input: unknown }) => Promise<boolean>;
}

// Low-risk read-only tools — 自动放行，无需审批
const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

// High-risk tools — 需要用户审批
const HIGH_RISK_TOOLS = new Set(['bash', 'write', 'edit']);

/**
 * 构建权限拦截扩展
 *
 * @param config - 包含审批回调的配置
 * @returns ExtensionFactory 传给 DefaultResourceLoader
 */
export function buildPermissionGuard(config: GuardConfig): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event: ToolCallEvent): Promise<ToolCallEventResult> => {
      const toolName = (event as { toolName?: string }).toolName ?? 'unknown';

      // 1. Read-only tools → auto-allow
      if (READ_ONLY_TOOLS.has(toolName)) {
        return { block: false };
      }

      // 2. High-risk tools → request approval
      if (HIGH_RISK_TOOLS.has(toolName)) {
        const approved = await config.onToolApprovalRequest({
          toolName,
          input: (event as Record<string, unknown>).input,
        });

        return approved
          ? { block: false }
          : { block: true, reason: `User denied execution of high-risk tool: ${toolName}` };
      }

      // 3. Unknown tools → default deny (safe default)
      return { block: true, reason: `Unknown tool: ${toolName} — default deny` };
    });
  };
}
