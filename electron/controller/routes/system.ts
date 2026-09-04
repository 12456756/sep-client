/**
 * electron/controller/routes/system.routes.ts — 1 条工具路由 + 1 个单向监听
 *
 * 这两条都不进服务层：目录选择要的是窗口句柄（UI 能力，不是用例），
 * 审批响应是执行层的控制信号，服务层插一层只是转发。
 */
import { dialog } from 'electron'
import { z } from 'zod'
import { appError } from '../../errors/app-error'
import { INVOKE_CHANNELS, SEND_CHANNELS } from '../channels'
import { listener, NO_INPUT, route } from '../router'

/**
 * 审批响应。`requestId` 必填（C5）——缺了就不批，不做任何推断。
 * 原来"恰好一个 pending 就认下"的回退会在 A 超时、B 进来时把批准算到 B 头上，
 * 而 B 可能是一个 bash。
 */
const approvalResponse = z.object({
  requestId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().optional(),
})

export const systemRoutes = [
  route(INVOKE_CHANNELS.UTIL_SELECT_DIRECTORY, NO_INPUT, async ctx => {
    const window = ctx.window()
    if (!window) {
      // 渲染进程本就跑在窗口里，走到这里说明窗口在调用途中被销毁了——
      // 不变式被破坏，按第 5.2 节记 error 级日志，而不是静默失败。
      throw appError('INTERNAL_ERROR', { details: { reason: 'main window unavailable' } })
    }
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择工作目录',
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false, path: null }
    return { success: true, path: result.filePaths[0] }
  }, { errorShape: 'ipc' }),
]

export const systemListeners = [
  listener(SEND_CHANNELS.TOOL_APPROVAL_RESPONSE, approvalResponse, (ctx, input) => {
    // 协调器没加载过就没有待批的调用，直接丢掉；不能因为一条响应而触发加载。
    ctx.backend.peekTaskCoordinator()?.respondToApproval(input)
  }),
]
