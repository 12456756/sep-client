import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { FeedbackController } from '../../shared/feedback-controller'
import { feedbackMessage, responseError } from '../../shared/arrangement-feedback'
import { conversationQueueViewSchema, type ConversationQueueInput } from '../../shared/conversation-queue'

function mountQueue() {
  const feedback = new FeedbackController()
  const requests: ConversationQueueInput[] = []
  let current = true, cursor = 0
  const cells: unknown[] = []
  const cell = (initial: unknown) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = initial
    return index
  }
  const filename = fileURLToPath(new URL('./use-conversation-queue.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const imports = {
    react: {
      useState(initial: unknown) { const index = cell(initial); return [cells[index], (value: unknown) => { cells[index] = value }] },
      useRef(initial: unknown) { return cells[cell({ current: initial })] },
      useCallback: (value: unknown) => value, useEffect() {},
    },
    '../../shared/conversation-queue': { conversationQueueViewSchema },
    '../../shared/arrangement-feedback': { feedbackMessage, responseError },
    '../../components/feedback/use-operation-feedback': { useOperationFeedback: () => ({ capture: () => ({ isCurrent: () => current, fail() {} }) }) },
    '../../components/feedback/FeedbackProvider': { useFeedback: () => feedback },
  }
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module', 'window'], { filename })(
    (id: string) => { assert.ok(Object.hasOwn(imports, id)); return Reflect.get(imports, id) }, module.exports, module,
    { electronAPI: { async conversationQueue(input: ConversationQueueInput) {
      requests.push(input)
      return { success: true, queue: input.action === 'get'
        ? { paused: true, items: [], failed: { id: 'failed', prompt: '待恢复', createdAt: 1, attachmentNames: [], recoveryConfirmationRequired: true } }
        : { paused: false, items: [], failed: null } }
    } } },
  )
  const hook = (module.exports as typeof import('./use-conversation-queue')).useConversationQueue
  const render = () => { cursor = 0; return hook('task', 'account') }
  return { feedback, requests, render, invalidate: () => { current = false } }
}

test('rebuilding a failed queue message sends explicit confirmation only after the user accepts', async () => {
  const ui = mountQueue()
  await ui.render().refresh()
  const pending = ui.render().recover()
  assert.equal(ui.requests.length, 1)
  assert.match(ui.feedback.getSnapshot()!.message, /部分上下文可能无法还原/)
  await ui.feedback.accept(ui.feedback.getSnapshot()!.id)
  await pending
  assert.deepEqual(ui.requests[1], { taskId: 'task', action: 'recover', messageId: 'failed', confirmRecovery: true })
  assert.equal(ui.render().queue.failed, null)
})

test('cancelled or stale recovery confirmation cannot send a reconstruction request', async () => {
  for (const stale of [false, true]) {
    const ui = mountQueue()
    await ui.render().refresh()
    const pending = ui.render().recover()
    const dialog = ui.feedback.getSnapshot()!
    if (stale) { ui.invalidate(); await ui.feedback.accept(dialog.id) }
    else ui.feedback.dismiss(dialog.id)
    await pending
    assert.equal(ui.requests.length, 1)
  }
})
