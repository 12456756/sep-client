import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { TaskRunStorePort } from './task-run-store'
import type { TaskOwnerScope } from './scope-path'

export async function readTaskSessionHistory(store: TaskRunStorePort, scope: TaskOwnerScope, taskId: string): Promise<{ content: string; sessionId: string } | null> {
  const runs = await store.list(scope, taskId)
  const run = runs.find(item => item.sessionFile && item.sessionId)
  if (!run?.sessionFile || !run.sessionId) return null
  try {
    const root = await realpath(store.getTaskDir(scope, taskId))
    const file = await realpath(run.sessionFile)
    const inside = relative(root, file)
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
    return { content: await readFile(file, 'utf8'), sessionId: run.sessionId }
  } catch { return null }
}
