/**
 * electron/controller/routes/index.ts — 路由表总装
 *
 * 33 个通道的注册表就是这两个数组。`ipc-contract.test.ts` 按源码断言
 * 「每个 INVOKE / SEND 通道恰有一条 route」，所以漏填一条会在测试里立刻暴露。
 */
import type { Listener, Route } from '../router'
import { authRoutes } from './auth'
import { conversationRoutes } from './conversation'
import { systemListeners, systemRoutes } from './system'
import { taskRoutes } from './task'
import { workflowRoutes } from './workflow'

export const routes: readonly Route[] = [
  ...authRoutes,
  ...taskRoutes,
  ...conversationRoutes,
  ...workflowRoutes,
  ...systemRoutes,
]

export const listeners: readonly Listener[] = [...systemListeners]
