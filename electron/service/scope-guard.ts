/**
 * electron/service/scope-guard.ts — 唯一的 scope 校验点
 *
 * 服务层统一在这里读取当前认证作用域，并通过 AppError 报告未登录或清理中的状态。
 * 控制层只负责把错误映射成 IPC 返回值，业务用例不需要重复拼装失败信封。
 *
 * "认证失效清理进行中"的判断在 `currentScope()` 里面（C7）：那是个半清理状态
 * ——token 已作废、scope 还没清掉——任何需要 scope 的用例都必须直接拒掉。
 */
import type { TaskOwnerScope } from '../data/scope-path'
import { AppError } from '../errors/app-error'

/** 提供当前 scope 的一方。实现是 bootstrap/build-backend.ts 的 Backend。 */
export interface ScopeSource {
  /** 当前 scope；未登录或正在清理时为 null。 */
  currentScope(): TaskOwnerScope | null
}

/** 取当前 scope，没有就以 AUTH_REQUIRED 失败。服务层的唯一入口。 */
export function requireScope(source: ScopeSource): TaskOwnerScope {
  const scope = source.currentScope()
  if (!scope) throw new AppError('AUTH_REQUIRED')
  return scope
}


