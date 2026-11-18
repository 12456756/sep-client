import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { TaskRunStorePort } from './task-run-store'
import type { TaskOwnerScope } from './scope-path'
import { contextUsageSchema, type ContextUsage } from '../../src/shared/context-usage'

export async function readTaskSessionHistory(store: TaskRunStorePort, scope: TaskOwnerScope, taskId: string): Promise<{ content: string; sessionId: string; usage?: ContextUsage } | null> {
  const runs = await store.list(scope, taskId)
  const run = runs.find(item => item.sessionFile && item.sessionId)
  if (!run?.sessionFile || !run.sessionId) return null
  try {
    const root = await realpath(store.getTaskDir(scope, taskId))
    const file = await realpath(run.sessionFile)
    const inside = relative(root, file)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
    const content = await readFile(file, 'utf8')
    const usage = await latestUsage(store, scope, taskId, run.id)
    return { content, sessionId: run.sessionId, ...(usage?.breakdown ? { usage } : {}) }
  } catch { return null }
}

async function latestUsage(store: TaskRunStorePort, scope: TaskOwnerScope, taskId: string, runId: string): Promise<ContextUsage | undefined> {
  if (!runId) return
  try {
    const events = await store.events.getTimeline(scope, taskId, runId)
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].type !== 'context_usage') continue
      const data = events[index].data
      const parsed = contextUsageSchema.safeParse(restoreRedactedTotal(data))
      return parsed.success ? parsed.data : undefined
    }
  } catch { /* The session can still provide the total. */ }
}

function restoreRedactedTotal(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('tokens' in data) || data.tokens !== '[redacted]' || !('breakdown' in data)) return data
  const breakdown = contextUsageSchema.shape.breakdown.safeParse(data.breakdown)
  if (!breakdown.success || !breakdown.data) return data

  const { system, tools, messages } = breakdown.data
  const tokens = system + tools + messages
  const recovered = contextUsageSchema.safeParse({ ...data, tokens })
  if (!recovered.success || recovered.data.percent === null ||
    Math.abs(tokens / recovered.data.contextWindow * 100 - recovered.data.percent) > 0.000001) return data
  return recovered.data
}
