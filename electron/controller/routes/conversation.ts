/**
 * electron/controller/routes/conversation.routes.ts — 3 条对话路由
 *
 * `conversation:create` 与 `task:create` 是同一个服务方法的两个薄入口
 * （渲染进程两个都在用：useWorkspaceDemo 用后者、useEnterpriseWorkspace 用前者）。
 */
import { z } from 'zod'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'
import { CREATE_TASK_INVALID, createTaskInput } from './task'

/** 三种会话恢复模式，与服务层的 SessionRecoveryMode 同集合。 */
const recoveryMode = z.enum(['strict', 'confirm_rebuild', 'auto_rebuild_from_task_history'])

const continueInput = z.object({
  taskId: z.string().min(1),
  prompt: z.string().trim().min(1),
  recoveryMode: recoveryMode.optional(),
  confirmRecovery: z.boolean().optional(),
})

const switchEmployeeInput = z.object({
  taskId: z.string().min(1),
  subscriptionId: z.string().min(1),
})

export const conversationRoutes = [
  route(INVOKE_CHANNELS.CONVERSATION_CREATE, createTaskInput, async (ctx, input) => ({
    success: true,
    task: await ctx.conversations.create(input),
  }), { invalidMessage: CREATE_TASK_INVALID }),

  route(INVOKE_CHANNELS.TASK_CONTINUE, continueInput, async (ctx, input) => {
    await ctx.conversations.continue({
      taskId: input.taskId,
      prompt: input.prompt,
      recoveryMode: input.recoveryMode,
      confirmRecovery: input.confirmRecovery === true,
    })
    return { success: true }
  }, { invalidMessage: '需要有效的任务与消息内容。' }),

  route(INVOKE_CHANNELS.TASK_SWITCH_EMPLOYEE, switchEmployeeInput, async (ctx, input) => {
    await ctx.conversations.switchEmployee(input.taskId, input.subscriptionId)
    return { success: true }
  }, { invalidMessage: '需要有效的任务与硅基员工。' }),
]
