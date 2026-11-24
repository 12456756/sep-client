import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { FeedbackController } from '../shared/feedback-controller'
import { OFFICE_TOOL_NAME, removeResolvedBrowserHandoff, toolApprovalTimeoutMs } from '../shared/tool-approval'
import { CREATE_SCHEDULED_TASK_TOOL } from '../shared/scheduled-creation'
import type { ToolApprovalDialog } from './ToolApprovalDialog'

type Props = Parameters<typeof ToolApprovalDialog>[0]
const require = createRequire(import.meta.url)
const filename = new URL('./ToolApprovalDialog.tsx', import.meta.url)
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText

function mount(toolName: string, input: unknown, expiresAt: number | null = Date.now() + toolApprovalTimeoutMs({ toolName, input }), timestamp?: number,
  details?: Pick<NonNullable<Props['request']>, 'registeredTool' | 'summary'>) {
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
  const props: Props = { request: { requestId: 'request', toolName, input, expiresAt: expiresAt ?? undefined, timestamp, ...details },
    onApprove: () => decisions.push(true), onDeny: () => decisions.push(false) }
  Component(props)
  let cleanup = effect()
  return { feedback, decisions, replay() { cleanup?.(); cleanup = effect() }, cleanup() { cleanup?.(); feedback.clear() } }
}

test('browser snapshots describe reading or saving without skipping approval', () => {
  for (const [input, message] of [
    [{}, '允许读取当前网页内容？'],
    [{ filename: 'page.yml' }, '允许读取当前网页内容并将快照保存为文件？'],
  ] as const) {
    const ui = mount('mcp__playwright__browser_snapshot', input)
    try {
      assert.equal(ui.feedback.getSnapshot()?.message, message)
      assert.equal(ui.feedback.getSnapshot()?.tone, 'confirm')
      assert.deepEqual(ui.decisions, [])
    } finally { ui.cleanup() }
  }
})

test('browser navigation approval shows only the target origin, not credentials or URL parameters', async () => {
  const ui = mount('mcp__playwright__browser_navigate', { url: 'https://user:secret@example.test:8443/private?token=secret#fragment' })
  try {
    const dialog = ui.feedback.getSnapshot()!
    assert.equal(dialog.message, '允许打开网页？目标站点：https://example.test:8443')
    assert.deepEqual(ui.decisions, [])
    ui.feedback.dismiss(dialog.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(ui.decisions, [false])
  } finally { ui.cleanup() }
})

test('general browser operations have specific approval copy without disguising unknown tools', () => {
  for (const name of ['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click',
    'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_tabs',
    'browser_wait_for', 'browser_handle_dialog', 'browser_close', 'browser_set_mode', 'browser_scroll',
    'browser_extract', 'browser_save_assets', 'browser_run_code']) {
    const ui = mount(`mcp__playwright__${name}`, {})
    try {
      const dialog = ui.feedback.getSnapshot()!
      assert.equal(dialog.tone, 'confirm', name)
      assert.equal(dialog.message.includes('未知工具'), name === 'browser_run_code', name)
      assert.deepEqual(ui.decisions, [])
    } finally { ui.cleanup() }
  }
})

test('registered Office edits show only the validated write targets and still require consent', async () => {
  const ui = mount(OFFICE_TOOL_NAME, { command: ['batch', 'private/source.xlsx', '--commands', 'PRIVATE_CELL_VALUE'] }, undefined, undefined,
    { registeredTool: true, summary: { kind: 'office', operation: 'batch', files: ['销售汇总-副本.xlsx'], additionalFiles: false } })
  try {
    const dialog = ui.feedback.getSnapshot()!
    assert.match(dialog.message, /批量修改.*销售汇总-副本\.xlsx.*写入/)
    assert.doesNotMatch(dialog.message, /未知工具|PRIVATE_CELL_VALUE|private|原附件不会修改/)
    assert.deepEqual(ui.decisions, [])
    await ui.feedback.accept(dialog.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(ui.decisions, [true])
  } finally { ui.cleanup() }
})

test('registered tools with no usable summary keep an ordinary confirmation', async () => {
  const cases: Array<[string, string, NonNullable<Props['request']>['summary']]> = [
    [OFFICE_TOOL_NAME, '允许本次使用 OfficeCLI？', undefined],
    [OFFICE_TOOL_NAME, '允许本次使用 OfficeCLI？', { kind: 'office', operation: 'edit', files: ['C:\\private\\test.xlsx'], additionalFiles: false }],
    ['mcp__erp__sync', '允许本次使用 mcp__erp__sync？', { kind: 'browser-save-assets' }],
    ['mcp__playwright__browser_snapshot', '允许读取当前网页内容？', undefined],
  ]
  for (const [name, message, summary] of cases) {
    const ui = mount(name, {}, undefined, undefined, { registeredTool: true, summary })
    try {
      const dialog = ui.feedback.getSnapshot()!
      assert.equal(dialog.message, message)
      assert.deepEqual(ui.decisions, [])
      ui.feedback.dismiss(dialog.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(ui.decisions, [false])
    } finally { ui.cleanup() }
  }
})

test('a browser summary is bound to the tool and contains only an origin', () => {
  const name = 'mcp__playwright__browser_navigate'
  for (const [origin, message] of [
    ['https://example.test:8443', '允许打开网页？目标站点：https://example.test:8443'],
    ['https://user:secret@example.test/path?key=secret', '允许打开指定网页？'],
  ]) {
    const ui = mount(name, {}, undefined, undefined, { registeredTool: true, summary: { kind: 'browser-navigate', origin } })
    try { assert.equal(ui.feedback.getSnapshot()?.message, message) }
    finally { ui.cleanup() }
  }
})

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

test('local batch approval names the files and displays the individual byte limit', () => {
  const ui = mount('local_media_process', { operation: 'batch_transcode', files: ['甲.mp4', '乙.mp4'], maxBytes: 250_000 })
  try {
    assert.match(ui.feedback.getSnapshot()!.message, /批量转码.*甲\.mp4、乙\.mp4.*每个成品上限 250,000 字节.*原素材不会被覆盖/)
    assert.deepEqual(ui.decisions, [])
  } finally { ui.cleanup() }
})

test('local enhanced composition approval shows timing, overlays and audio processing', () => {
  const ui = mount('local_media_process', { operation: 'compose', plan: {
    aspect: '16:9', resolution: 720, durationSeconds: 3.5, transitions: [0, 0], fadeIn: 0, fadeOut: 0,
    clips: [{ name: '片头.png', role: 'intro', crops: false, durationSeconds: 0.5 },
      { name: '正文.mp4', crops: false, start: 0, end: 4, speed: 2, freeze: 0.5, durationSeconds: 2.5 },
      { name: '片尾.png', role: 'outro', crops: false, durationSeconds: 0.5 }],
    music: { name: '配乐.wav', volume: 0.4 }, watermark: { name: '标志.png', position: 'top-left', size: 0.2, opacity: 0.8 },
    pip: { name: '小窗.mp4', position: 'bottom-right', size: 0.3, at: 0.8, start: 0, end: 0.5 },
    audio: { denoise: true, normalize: true, duckMusic: true },
  } })
  try {
    const message = ui.feedback.getSnapshot()!.message
    assert.match(message, /片头：片头\.png[\s\S]*2 倍速，静音定格 0\.5 秒[\s\S]*片尾：片尾\.png/)
    assert.match(message, /水印：标志\.png（左上，尺寸上限 20%，不透明度 80%）/)
    assert.match(message, /画中画：小窗\.mp4.*成片第 0\.8 秒开始.*无原声/)
    assert.match(message, /原声降噪、响度统一.*自动压低配乐/)
    assert.deepEqual(ui.decisions, [])
  } finally { ui.cleanup() }
})

test('local subtitle approval names the source, the SRT and the local-only processing', () => {
  const ui = mount('local_media_process', { operation: 'subtitle', files: ['录音.mp4'] })
  try {
    assert.match(ui.feedback.getSnapshot()!.message, /在本机识别.*录音\.mp4.*保存 SRT 字幕.*不会上传素材或改动原文件/)
    assert.deepEqual(ui.decisions, [])
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

test('browser media saving explains its scope and an old workflow receives no special approval', async () => {
  for (const [name, input, message, action, approved] of [
    ['mcp__playwright__browser_save_assets', { folder: '主图', count: 1 }, /当前网页已加载的素材.*本对话的成果目录/, '允许', true],
    ['mcp__playwright__browser_run_workflow', { workflow: 'competitor-collection' }, /未知工具.*建议拒绝/, '允许', false],
  ] as const) {
    const ui = mount(name, input)
    try {
      const dialog = ui.feedback.getSnapshot()!
      assert.match(dialog.message, message)
      assert.equal(dialog.actionLabel, action)
      assert.deepEqual(ui.decisions, [])
      if (approved) await ui.feedback.accept(dialog.id)
      else ui.feedback.dismiss(dialog.id)
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.deepEqual(ui.decisions, [approved])
    } finally { ui.cleanup() }
  }
})

test('host-detected browser handoff removes only its own dialog and sends no duplicate decision', async () => {
  const input = { operation: 'manual-handoff', autoDetect: true }
  const toolName = 'mcp__playwright__browser_set_mode'
  const request = { taskId: 'task', runId: 'run', subscriptionId: 'employee', requestId: 'request', toolName, input, timestamp: Date.now() }
  const unrelated = { ...request, requestId: 'other' }
  const requests = [request, unrelated]
  const event = { ...request, sequence: 2, occurredAt: Date.now(), type: 'approval_resolved', data: { requestId: request.requestId, approved: true } }
  const ui = mount(toolName, input)
  try {
    assert.match(ui.feedback.getSnapshot()!.message, /检测到完成后会自动继续/)
    assert.match(ui.feedback.getSnapshot()!.message, /同一站点的网页快照无需再确认，不包括保存文件或提交操作/)
    assert.equal(ui.feedback.getSnapshot()!.actionLabel, '已完成，继续')
    assert.equal(removeResolvedBrowserHandoff(requests, { ...event, runId: 'old' }), requests)
    assert.deepEqual(removeResolvedBrowserHandoff(requests, event), [unrelated])
    ui.cleanup()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(ui.feedback.getSnapshot(), null)
    assert.deepEqual(ui.decisions, [])
  } finally { ui.cleanup() }
})
