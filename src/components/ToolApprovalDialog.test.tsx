import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { FeedbackController } from '../shared/feedback-controller'
import { toolApprovalTimeoutMs } from '../shared/tool-approval'
import type { ToolApprovalDialog } from './ToolApprovalDialog'

type Props = Parameters<typeof ToolApprovalDialog>[0]
const require = createRequire(import.meta.url)
const filename = new URL('./ToolApprovalDialog.tsx', import.meta.url)
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText

function mount(toolName: string, input: unknown, expiresAt: number | null = Date.now() + toolApprovalTimeoutMs({ toolName, input }), timestamp?: number) {
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
  const props: Props = { request: { requestId: 'request', toolName, input, expiresAt: expiresAt ?? undefined, timestamp },
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

test('missing deadlines retain three minutes for browser handoff and one minute for ordinary approvals', () => {
  const timestamp = Date.now() - 90_000
  const handoff = mount('mcp__playwright__browser_set_mode', { operation: 'manual-handoff' }, null, timestamp)
  const ordinary = mount('bash', {}, null, timestamp)
  const expired = mount('mcp__playwright__browser_set_mode', { operation: 'manual-handoff' }, null, Date.now() - 180_001)
  try {
    assert.deepEqual(handoff.decisions, [])
    assert.equal(handoff.feedback.getSnapshot()?.actionLabel, '已完成，继续')
    assert.deepEqual(ordinary.decisions, [false])
    assert.equal(ordinary.feedback.getSnapshot(), null)
    assert.deepEqual(expired.decisions, [false])
    assert.equal(expired.feedback.getSnapshot(), null)
  } finally { handoff.cleanup(); ordinary.cleanup(); expired.cleanup() }
})

test('manual browser handoff waits for completion and uses the existing expiry and cancellation', async () => {
  for (const accepted of [true, false]) {
    const ui = mount('mcp__playwright__browser_set_mode', { operation: 'manual-handoff' })
    try {
      const dialog = ui.feedback.getSnapshot()
      assert.match(dialog!.message, /3 分钟/)
      assert.equal(dialog!.actionLabel, '已完成，继续')
      assert.deepEqual(ui.decisions, [])
      if (accepted) await ui.feedback.accept(dialog!.id)
      else ui.feedback.dismiss(dialog!.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(ui.decisions, [accepted])
    } finally { ui.cleanup() }
  }
  const expired = mount('mcp__playwright__browser_set_mode', {}, Date.now() - 1)
  try {
    assert.deepEqual(expired.decisions, [false])
    assert.equal(expired.feedback.getSnapshot(), null)
  } finally { expired.cleanup() }
})
