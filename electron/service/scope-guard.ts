/**
 * electron/service/scope-guard.ts — 唯一的 scope 校验点
 *
 * main.ts 原来有 12 处逐字复制的守卫（方案 0.1 节原则 3、第 6 章）。Phase 1 把它们
 * 收成 main.ts 里的一个 `requireScope()`，这里是最终落点。
 *
 * 与那一版的差别：**不再返回信封，而是抛 AppError**。返回信封会让每个调用点
 * 都要写一遍 `if (!guard.ok) return guard.failure`，而控制层的 catch 本来就会把
 * AppError 交给 `error-mapper`（唯一映射点，方案 4.2 节）。抛出之后，
 * 服务层内部取 scope 是一行，控制层一行都不用写。
 *
 * "认证失效清理进行中"的判断在 `currentScope()` 里面（C7）：那是个半清理状态
 * ——token 已作废、scope 还没清掉——任何需要 scope 的用例都必须直接拒掉。
 */
import type { TaskOwnerScope } from '../data/scope-path'
import { AppError } from '../errors/app-error'

/** 提供当前 scope 的一方。实现是 bootstrap/composition-root.ts 的 Backend。 */
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
