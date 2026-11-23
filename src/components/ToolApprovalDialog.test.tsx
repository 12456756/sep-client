import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { FeedbackController } from '../shared/feedback-controller'
import { toolApprovalTimeoutMs } from '../shared/tool-approval'
import { CREATE_SCHEDULED_TASK_TOOL } from '../shared/scheduled-creation'
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

test('scheduled tasks require explicit confirmation showing the task and first execution time', async () => {
  const ui = mount(CREATE_SCHEDULED_TASK_TOOL, { title: '日报', goal: '汇总昨天的销售数据', timezone: 'Asia/Shanghai',
    firstRunAt: Date.parse('2026-11-24T00:00:00Z'), recurrence: '0 8 * * *' })
  try {
    const dialog = ui.feedback.getSnapshot()
    assert.ok(dialog)
    assert.match(dialog.message, /日报.*预计首次执行.*08:00/s)
    assert.match(dialog.message, /重复规则：每天 08:00/)
    assert.match(dialog.message, /汇总昨天的销售数据/)
    assert.deepEqual(ui.decisions, [])
    await ui.feedback.accept(dialog.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(ui.decisions, [true])
  } finally { ui.cleanup() }
})

test('the schedule approval describes an all-wildcard cron as every minute', () => {
  const ui = mount(CREATE_SCHEDULED_TASK_TOOL, { title: '简报', goal: '生成简报', timezone: 'Asia/Shanghai',
    firstRunAt: Date.parse('2026-11-23T05:27:00Z'), recurrence: '* * * * *' })
  try {
    const dialog = ui.feedback.getSnapshot()
    assert.ok(dialog)
    assert.match(dialog.message, /重复规则：每分钟/)
    assert.doesNotMatch(dialog.message, /\* \* \* \* \*/)
    assert.deepEqual(ui.decisions, [])
  } finally { ui.cleanup() }
})

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

test('new generation after an unknown submission always requires an explicit risk decision', async () => {
  for (const toolName of ['media_generate_image', 'video_generate', 'video_from_image']) {
    for (const accepted of [true, false]) {
      const ui = mount(toolName, { operation: 'confirm-new-generation', unconfirmedJobCount: 4,
        mock: false, quote: { amount: '1.000000', currency: 'CNY' } })
      try {
        const dialog = ui.feedback.getSnapshot()!
        assert.equal(dialog.tone, 'confirm')
        assert.match(dialog.message, toolName === 'media_generate_image'
          ? /4 个原图片任务.*尚未确认.*分别计费.*原任务仍会保留/
          : /是否受理及计费尚未确认.*分别生成并计费.*原任务状态仍会保留/)
        assert.equal(dialog.actionLabel, '仍然生成')
        assert.deepEqual(ui.decisions, [])
        if (accepted) await ui.feedback.accept(dialog.id)
        else ui.feedback.dismiss(dialog.id)
        await new Promise<void>(resolve => setImmediate(resolve))
        assert.deepEqual(ui.decisions, [accepted])
        ui.replay()
        assert.deepEqual(ui.decisions, [accepted])
      } finally { ui.cleanup() }
    }
  }
})

test('expired or cleared new-generation confirmations cannot approve another submission', async () => {
  const input = { operation: 'confirm-new-generation', unconfirmedJobCount: 1 }
  const expired = mount('video_generate', input, Date.now() - 1)
  const cleared = mount('media_generate_image', input)
  try {
    assert.deepEqual(expired.decisions, [false])
    assert.equal(expired.feedback.getSnapshot(), null)
    cleared.feedback.clear()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(cleared.decisions, [false])
  } finally { expired.cleanup(); cleared.cleanup() }
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

test('local composition asks before saving and shows the resolved plan in order', async () => {
  const ui = mount('local_media_process', { operation: 'compose', files: ['第一张.jpg', '原视频.mp4', '第二张.png'], plan: {
    aspect: '9:16', resolution: 1080, durationSeconds: 7.5, fadeIn: 0, fadeOut: 0.5, transitions: [0.5, 0],
    music: { name: '音乐.wav', volume: 0.2 }, clips: [
      { name: '第一张.jpg', durationSeconds: 2, crops: true, motion: 'zoom-in' },
      { name: '原视频.mp4', durationSeconds: 3, crops: false, start: 5, end: 8, volume: 0.5 },
      { name: '第二张.png', durationSeconds: 3, crops: false },
    ],
  } })
  try {
    const dialog = ui.feedback.getSnapshot()!
    assert.match(dialog.message, /MP4.*9:16.*1080p.*7\.5 秒.*原素材不会被覆盖/)
    assert.match(dialog.message, /第一张\.jpg.*推近.*裁切.*交叉淡化 0\.5 秒\n.*原视频\.mp4.*5–8 秒.*原声 50%）\n.*第二张\.png/)
    assert.match(dialog.message, /配乐：音乐\.wav（音量 20%）/)
    assert.deepEqual(ui.decisions, [])
    ui.feedback.dismiss(dialog.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(ui.decisions, [false])
  } finally { ui.cleanup() }
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
