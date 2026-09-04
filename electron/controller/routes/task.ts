/**
 * electron/controller/routes/task.routes.ts — 13 条任务路由
 *
 * 每条只做三件事：schema 声明入参、调服务、把成功值组成响应。
 * scope 校验、员工授权、NOT_FOUND / INVALID_STATE 的判定全在 `service/`。
 */
import { z } from 'zod'
import type { TaskRunRecord } from '../../data/task-run-store'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'

/** 任务 ID：非空字符串。原 handler 逐个写的 `typeof x !== 'string' || !x` 就是它。 */
const taskId = z.string().min(1)
const TASK_ID_INVALID = '需要有效的任务 ID。'

/** run 查询的两个 ID。 */
const runIds = z.object({ taskId, runId: z.string().min(1) })
const RUN_IDS_INVALID = '需要有效的任务与执行记录 ID。'

/** 建任务的入参。`task:create` 与 `conversation:create` 共用。 */
export const createTaskInput = z.object({
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  workDir: z.string().trim().min(1).optional(),
  subscriptionId: z.string(),
})
export const CREATE_TASK_INVALID = '任务请求参数不合法。'

/** 渲染进程既可能只传 taskId，也可能传 `{ taskId }`——两种都收，收成同一个形状。 */
const executeInput = z.union([taskId, z.object({ taskId })]).transform(
  value => (typeof value === 'string' ? value : value.taskId),
)

/** run 记录投影：只把渲染进程契约里声明的字段送出去。 */
function toClientTaskRun(record: TaskRunRecord) {
  return {
    id: record.id,
    taskId: record.taskId,
    subscriptionId: record.subscriptionId,
    modelId: record.modelId,
    runtimeKey: record.runtimeKey,
    outcome: record.outcome,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    sessionId: record.sessionId,
    error: record.error,
  }
}

export const taskRoutes = [
  route(INVOKE_CHANNELS.TASK_CREATE, createTaskInput, async (ctx, input) => ({
    success: true,
    // 渲染进程的对话编辑器用的是 task:create，所以这里也按对话任务初始化，
    // 首轮运行才会走任务级共享 Pi 会话。两个 channel 都是同一个服务方法的薄入口。
    task: await ctx.conversations.create(input),
  }), { invalidMessage: CREATE_TASK_INVALID }),

  route(INVOKE_CHANNELS.TASK_EXECUTE, executeInput, async (ctx, id) => {
    await ctx.tasks.execute(id)
    return { success: true }
  }, { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.TASK_RETRY, taskId, async (ctx, id) => {
    await ctx.tasks.retry(id)
    return { success: true }
  }, { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.TASK_PAUSE, taskId, async (ctx, id) => {
    await ctx.tasks.pause(id)
    return { success: true }
  }, { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.TASK_CANCEL, taskId, async (ctx, id) => {
    await ctx.tasks.cancel(id)
    return { success: true }
  }, { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.TASK_DELETE, taskId, async (ctx, id) => {
    await ctx.tasks.delete(id)
    return { success: true }
  }, { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.TASK_GET, taskId, async (ctx, id) => ({
    success: true,
    task: await ctx.tasks.get(id),
  }), { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.TASK_GET_ALL, NO_INPUT, async ctx => ({
    success: true,
    tasks: await ctx.tasks.list(),
  })),

  route(INVOKE_CHANNELS.TASK_GET_STATS, NO_INPUT, async ctx => ({
    success: true,
    stats: await ctx.tasks.stats(),
  })),

  route(INVOKE_CHANNELS.TASK_GET_MESSAGES, taskId, async (ctx, id) => ({
    success: true,
    messages: await ctx.tasks.messages(id),
  }), { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.TASK_LIST_RUNS, taskId, async (ctx, id) => ({
    success: true,
    runs: (await ctx.tasks.listRuns(id)).map(toClientTaskRun),
  }), { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.TASK_GET_RUN, runIds, async (ctx, input) => ({
    success: true,
    run: toClientTaskRun(await ctx.tasks.getRun(input.taskId, input.runId)),
  }), { invalidMessage: RUN_IDS_INVALID }),

  route(INVOKE_CHANNELS.TASK_GET_TIMELINE, runIds, async (ctx, input) => ({
    success: true,
    events: await ctx.tasks.timeline(input.taskId, input.runId),
  }), { invalidMessage: RUN_IDS_INVALID }),
]
