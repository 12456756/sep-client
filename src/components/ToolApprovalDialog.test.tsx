import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { FeedbackController } from '../shared/feedback-controller'
import type { ToolApprovalDialog } from './ToolApprovalDialog'

type Props = Parameters<typeof ToolApprovalDialog>[0]
const require = createRequire(import.meta.url)
const filename = new URL('./ToolApprovalDialog.tsx', import.meta.url)
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText

function mount(toolName: string, input: unknown, expiresAt = Date.now() + 60_000) {
  const feedback = new FeedbackController()
  const decisions: boolean[] = []
  const refs: unknown[] = []
  let cursor = 0
  let effect: () => void | (() => void) = () => undefined
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'module', 'exports', 'window'], { filename: filename.pathname })(
    (id: string) => {
      if (id === 'react') return {
        useRef(initial: unknown) { const index = cursor++; return refs[index] ??= { current: initial } },
        useEffect(run: typeof effect) { effect = run },
      }
      if (id === './feedback/FeedbackProvider') return { useFeedback: () => feedback }
      return require(id)
    }, module, module.exports, { setTimeout, clearTimeout })
  const Component = (module.exports as { ToolApprovalDialog: typeof ToolApprovalDialog }).ToolApprovalDialog
  const props: Props = { request: { requestId: 'request', toolName, input, expiresAt },
    onApprove: () => decisions.push(true), onDeny: () => decisions.push(false) }
  Component(props)
  let cleanup = effect()
  return { feedback, decisions, replay() { cleanup?.(); cleanup = effect() }, cleanup() { cleanup?.(); feedback.clear() } }
}

test('quoted image and video generation proceeds once without a confirmation dialog', () => {
  for (const [toolName, input] of [
    ['media_generate_image', { quote: { amount: '1.25', currency: 'CNY' } }],
    ['video_generate', { mock: false, quote: { amount: '28.800000', currency: 'CNY' } }],
    ['video_from_image', { mock: false, quote: { amount: '28.800000', currency: 'CNY' } }],
    ['video_generate', { mock: true }],
  ] as const) {
    const ui = mount(toolName, input)
    try {
      assert.deepEqual(ui.decisions, [true])
      assert.equal(ui.feedback.getSnapshot(), null)
      ui.replay()
      assert.deepEqual(ui.decisions, [true])
    } finally { ui.cleanup() }
  }
})

test('expired approvals and invalid paid video quotes are denied without a dialog', () => {
  for (const ui of [
    mount('video_generate', { mock: false, quote: { amount: 'unknown', currency: 'CNY' } }),
    mount('video_generate', { mock: false }),
    mount('media_generate_image', { quote: { amount: '1', currency: 'CNY' } }, Date.now() - 1),
  ]) {
    try {
      assert.deepEqual(ui.decisions, [false])
      assert.equal(ui.feedback.getSnapshot(), null)
    } finally { ui.cleanup() }
  }
})

test('reference uploads, local commands and other tools retain explicit approval', async () => {
  for (const [toolName, input] of [
    ['media_generate_image', { operation: 'upload-references' }],
    ['video_from_image', { operation: 'upload-references', mock: false }],
    ['bash', { command: 'example' }],
    ['media_cancel_job', { quote: { amount: '1', currency: 'CNY' } }],
    ['unknown', {}],
  ] as const) {
    const ui = mount(toolName, input)
    try {
      assert.deepEqual(ui.decisions, [])
      const dialog = ui.feedback.getSnapshot()
      assert.equal(dialog?.tone, 'confirm')
      await ui.feedback.accept(dialog!.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(ui.decisions, [true])
    } finally { ui.cleanup() }
  }
})
