/**
 * electron/controller/routes/workflow.routes.ts — 4 条工作流路由
 *
 * 图的合法性判定是纯逻辑，归 `domain/workflow-graph.ts`；这里的 schema 只保证
 * "有标题、nodes 是个数组"，具体节点形状交给 `createWorkflowGraph` 判——
 * 它抛的 `WorkflowGraphError` 由 error-mapper 映射为 INVALID_ARGUMENT。
 */
import { z } from 'zod'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

const taskId = z.string().min(1)
const TASK_ID_INVALID = '需要有效的任务 ID。'

const validateInput = z.object({ nodes: z.array(z.unknown()) })

const createInput = z.object({
  title: z.string().trim().min(1),
  nodes: z.array(z.unknown()),
  prompt: z.string().optional(),
  workDir: z.string().optional(),
})

export const workflowRoutes = [
  route(INVOKE_CHANNELS.WORKFLOW_VALIDATE, validateInput, (ctx, input) => ({
    success: true,
    graph: ctx.workflows.validate(input.nodes),
  }), { invalidMessage: '需要提供工作流节点。' }),

  route(INVOKE_CHANNELS.WORKFLOW_CREATE, createInput, async (ctx, input) => ({
    success: true,
    ...await ctx.workflows.create({
      title: input.title,
      nodes: input.nodes,
      prompt: input.prompt,
      workDir: input.workDir,
    }),
  }), { invalidMessage: '需要提供标题与工作流节点。' }),

  route(INVOKE_CHANNELS.WORKFLOW_GET, taskId, async (ctx, id) => ({
    success: true,
    graph: await ctx.workflows.get(id),
  }), { invalidMessage: TASK_ID_INVALID }),

  route(INVOKE_CHANNELS.WORKFLOW_START, taskId, async (ctx, id) => {
    await ctx.workflows.start(id)
    return { success: true }
  }, { invalidMessage: TASK_ID_INVALID }),
]
