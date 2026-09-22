/**
 * electron/common/constants.ts — 跨层共享的常量
 *
 * 目前只有一件事：**有副作用的工具清单**。
 * 运行时的 `SIDE_EFFECT_TOOLS`、`task-run-store` 里的内联数组、
 * `pi-extension/guard.ts` 的 `APPROVAL_TOOLS`。
 *
 * 三处语义完全相同——「这个工具会改变外部状态」——但用途不同：
 *   - 审批：调用前必须拿到用户显式批准（项目安全约束）
 *   - 停机：in-flight 的这类调用必须产出 SIDE_EFFECT_UNKNOWN（不变式 I7 / C3）
 *   - 崩溃恢复：重启后为没收到 tool_execution_end 的这类调用补 SIDE_EFFECT_UNKNOWN
 *
 * 少改一处就是一个安全缺口——漏在审批侧意味着未经批准就执行，漏在恢复侧意味着
 * 下次启动无法判定副作用是否已发生。所以只允许有一个定义点。
 */
export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set(['bash', 'write', 'edit'])

/** 保守的副作用分类。MCP 执行权限另由实际注册工具白名单决定。 */
export function hasSideEffects(toolName: string): boolean {
  // External MCP tools are conservatively tracked for interruption/recovery, not permission grants.
  return SIDE_EFFECT_TOOLS.has(toolName) || toolName.startsWith('mcp__')
}


