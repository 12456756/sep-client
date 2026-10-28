import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import * as projection from './arrangement-transcript'
import type { TaskExecutionEvent } from '../../shared/types'
import type { ElectronAPI } from '../../shared/ipc'

const filename = fileURLToPath(new URL('./use-arrangement-transcript.ts', import.meta.url))
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function mount(api: Partial<ElectronAPI>) {
  const oldWindow = Reflect.get(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: api } })
  const cells: unknown[] = []
  let cursor = 0
  let pending: Array<() => void> = []
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  const hooks = {
    useCallback: (callback: unknown) => callback,
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in cells)) cells[index] = initial
      return [cells[index], (value: unknown) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useEffect: (run: () => void | (() => void), deps: unknown[]) => {
      const index = cursor++
      const old = effects.get(index)
      if (old?.deps.every((value, i) => Object.is(value, deps[i]))) return
      pending.push(() => { old?.cleanup?.(); effects.set(index, { deps, cleanup: run() || undefined }) })
    },
  }
  const loaded = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename })(
    (id: string) => id === 'react' ? hooks : projection, loaded.exports, loaded)
  const hook = (loaded.exports as typeof import('./use-arrangement-transcript')).useArrangementTranscript
  return {
    render(taskId = 'task', scope = 'scope-a') {
      cursor = 0; pending = []
      const result = hook(taskId, scope)
      pending.forEach(run => run())
      return result
    },
    dispose() {
      effects.forEach(effect => effect.cleanup?.())
      if (oldWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow })
    },
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 120))
const event = (sequence: number, text: string): TaskExecutionEvent => ({ taskId: 'task', runId: 'parent', subscriptionId: 'owner',
  sequence, type: 'arrangement_node_progress', occurredAt: sequence, data: { eventType: 'text_delta', nodeId: 'a', nodeRunId: 'node-run', text } })

describe('arrangement transcript loading', () => {
  it('subscribes before disk IO and merges late history with live events without duplicates', async () => {
    let listener!: (event: TaskExecutionEvent) => void
    let finish!: (value: { success: true; events: TaskExecutionEvent[] }) => void
    let subscribed = false
    const page = mount({
      onPiEvent(callback) { subscribed = true; listener = callback; return () => {} },
      async listTaskRuns() { assert.ok(subscribed); return { success: true, runs: [{ id: 'parent' }] } as Awaited<ReturnType<ElectronAPI['listTaskRuns']>> },
      getTaskTimeline() { return new Promise(resolve => { finish = resolve }) },
    })
    try {
      page.render(); await Promise.resolve()
      listener(event(2, 'Live'))
      listener({ ...event(3, 'Foreign'), taskId: 'another-task' })
      finish({ success: true, events: [event(1, 'History'), event(2, 'Live'), { ...event(3, ''), runId: 'node-run', type: 'message_end',
        data: { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Historical reasoning' },
          { type: 'toolCall', arguments: { password: 'TOOL SECRET' } }] } } }] })
      await tick()
      const result = page.render()
      assert.equal(result.loading, false)
      assert.deepEqual(result.events.filter(e => e.type === 'arrangement_node_progress').map(e => (e.data as { text: string }).text), ['History', 'Live'])
      assert.deepEqual(result.events.find(e => e.type === 'message_end')?.data, { thinking: 'Historical reasoning' })
      assert.doesNotMatch(JSON.stringify(result.events), /TOOL SECRET|password/)
    } finally { page.dispose() }
  })

  it('discards stale reads when the authenticated scope changes', async () => {
    let finish!: (value: { success: true; events: TaskExecutionEvent[] }) => void
    let reads = 0
    let unsubscriptions = 0
    const page = mount({
      onPiEvent() { return () => { unsubscriptions++ } },
      async listTaskRuns() { return { success: true, runs: [{ id: 'parent' }] } as Awaited<ReturnType<ElectronAPI['listTaskRuns']>> },
      async getTaskTimeline() { if (++reads === 1) return new Promise(resolve => { finish = resolve }); return { success: true, events: [] } },
    })
    try {
      page.render(); await Promise.resolve()
      page.render('task', 'scope-b'); await Promise.resolve()
      finish({ success: true, events: [event(1, 'OLD ACCOUNT CONTENT')] })
      await tick()
      assert.deepEqual(page.render('task', 'scope-b').events, [])
      assert.equal(unsubscriptions, 1)
    } finally { page.dispose() }
  })
})
