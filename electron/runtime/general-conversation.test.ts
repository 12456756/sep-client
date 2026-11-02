import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRuntime } from './task-runtime'
import { TaskManager } from './task-manager'
import { TaskRunStore } from '../data/task-run-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { effectivePermissionPolicy } from '../domain/arrangement-plan'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import type { MediaHostTools } from '../domain/media-tools'
import type { VideoHostTools } from '../domain/video-tools'
import * as videoFixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoRuntimeSchema } from '../../src/shared/video-media'
import { ConversationContextStore } from '../domain/conversation-context'

test('general chat preserves selected model, permissions and history across turns and restart without employee behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-general-chat-'))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root)
  const plans = new WorkPlanStore(root)
  const runs = new TaskRunStore(root)
  const contexts: PiTaskWorkerOptions['context'][] = []
  const preparations: Array<{ kind: string; subscriptionId: string }> = []
  const toolCalls: string[] = []
  const completedMedia: string[] = []
  const media = { profileId: 'image-profile' }
  const video = videoRuntimeSchema.parse(videoFixture.runtime)
  const mediaTools: MediaHostTools = { names: ['media_get_capabilities', 'media_generate_image', 'media_get_job', 'media_cancel_job'],
    async execute(name) { toolCalls.push(name); return { ok: true } } }
  const videoTools: VideoHostTools = { names: ['video_generate', 'video_from_image', 'video_get_job'],
    async execute(name) { toolCalls.push(name); return { ok: true } } }
  let subscriptionId = 'subscription-a'
  let runtime: TaskRuntime | undefined
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      if ((await manager.getTask(id))?.activeRunId === null) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('run did not settle')
  }
  const createRuntime = () => new TaskRuntime({
    taskManager: manager, taskRunStore: runs, workPlanStore: plans,
    resolveEmployee: id => ({ subscriptionId: id, modelId: 'model', gatewayUrl: 'http://unused' }),
    authorizeEmployee: async () => assert.fail('must not authorize employee or prepare skills'),
    authorizeModel: async modelId => ({ subscriptionId, modelId, gatewayUrl: 'http://unused', media, video }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    knowledgeSearch: async () => assert.fail('must not search employee knowledge'),
    media: { async prepareRun(input) {
      assert.deepEqual(input.employee.media, media)
      assert.equal(input.employee.runtimeSnapshot, undefined)
      assert.equal(input.toolPolicy?.preset, 'full-local')
      preparations.push({ kind: 'image', subscriptionId: input.subscriptionId })
      return mediaTools
    }, async stopTask() {}, async waitForRun() { completedMedia.push('image') } },
    video: { async prepareRun(input) {
      assert.deepEqual(input.employee.video, videoFixture.runtime)
      assert.equal(input.employee.runtimeSnapshot, undefined)
      assert.equal(input.toolPolicy?.preset, 'full-local')
      preparations.push({ kind: 'video', subscriptionId: input.subscriptionId })
      return videoTools
    }, async stopTask() {}, async waitForRun() { completedMedia.push('video') } },
    createWorker: options => ({
      async run(prompt) {
        contexts.push(options.context)
        assert.ok(['first', 'second', 'third'].some(text => prompt.startsWith(`${text}\n\n`)))
        assert.doesNotMatch(prompt, /当前通用助手没有账号主体的图片\/视频生成授权/)
        assert.match(prompt, /优先使用当前会话已提供的图片\/视频工具/)
        assert.match(prompt, /不能静默以脚本合成替代/)
        assert.match(prompt, /未指定的常规规格由模型.*本轮直接执行/)
        assert.match(prompt, /不要仅为确认.*追加一轮对话/)
        assert.equal(options.context.mediaTools, mediaTools)
        assert.equal(options.context.videoTools, videoTools)
        await options.context.mediaTools.execute('media_generate_image', {})
        await options.context.videoTools.execute('video_generate', {})
        await options.context.videoTools.execute('video_from_image', {})
        const emit = (type: string, data: unknown) => options.onEvent({
          taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
          sequence: 0, occurredAt: Date.now(), type, data,
        })
        await emit('text_delta', { text: 'I will generate a square image.' })
        await emit('tool_execution_start', { toolId: 'image-tool', toolName: 'media_generate_image' })
        await emit('tool_execution_end', { toolId: 'image-tool', toolName: 'media_generate_image', success: true })
        await emit('text_delta', { text: 'Generated and saved.' })
        await mkdir(options.context.sessionDir, { recursive: true })
        const file = join(options.context.sessionDir, 'session.jsonl')
        await writeFile(file, '{}\n', 'utf8')
        await options.onSessionCreated?.({ sessionId: 'shared', sessionFile: file })
      }, async abort() {}, async dispose() {},
    }),
  })
  try {
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('general', 'first', join(root, 'workspace'), subscriptionId)
    await plans.save(scope, {
      id: task.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, owner: scope, mode: 'conversation',
      title: 'general', goal: 'first', nodes: [], confirmedInputs: [],
      conversation: { kind: 'general', modelId: 'selected', participants: [{ subscriptionId, modelId: 'selected' }], activeSubscriptionId: subscriptionId },
      workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'full-local', approvalMode: 'auto-approve' }),
      planHash: 'general', createdAt: Date.now(),
    })
    runtime = createRuntime()
    await runtime.executeTask(task.id, { conversation: true })
    await settle(task.id)
    subscriptionId = 'subscription-b'
    await runtime.continueConversation(task.id, 'second')
    await settle(task.id)
    await runtime.stopAll()
    runtime = createRuntime()
    await runtime.continueConversation(task.id, 'third')
    await settle(task.id)
    assert.equal(contexts.length, 3)
    for (const context of contexts) {
      assert.equal(context.modelId, 'selected')
      assert.equal(context.employeeProfile, undefined)
      assert.equal(context.systemPrompt, undefined)
      assert.equal(context.useNativeSystemPrompt, true)
      assert.equal(context.disableSkills, true)
      assert.equal(context.enableCommonTools, true)
      assert.deepEqual(context.additionalSkillPaths, [])
      assert.equal(context.toolPolicy?.preset, 'full-local')
      assert.equal(context.toolPolicy?.approvalMode, 'auto-approve')
      assert.equal(context.transformSystemPrompt?.('unknown dynamic text'), 'unknown dynamic text')
    }
    assert.equal(contexts[1].resumeSessionFile, join(contexts[0].sessionDir, 'session.jsonl'))
    assert.equal(contexts[2].resumeSessionFile, contexts[1].resumeSessionFile)
    assert.deepEqual((await runs.list(scope, task.id)).map(run => run.subscriptionId).sort(), ['subscription-a', 'subscription-b', 'subscription-b'])
    assert.deepEqual(preparations, ['subscription-a', 'subscription-b', 'subscription-b'].flatMap(id => [
      { kind: 'image', subscriptionId: id }, { kind: 'video', subscriptionId: id },
    ]))
    assert.deepEqual(toolCalls, Array.from({ length: 3 }, () => ['media_generate_image', 'video_generate', 'video_from_image']).flat())
    assert.deepEqual(completedMedia, ['image', 'video', 'image', 'video', 'image', 'video'])
    const messages = await new ConversationContextStore(runs.getTaskDir(scope, task.id)).listMessages()
    assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => message.content),
      ['Generated and saved.', 'Generated and saved.', 'Generated and saved.'])
  } finally { await runtime?.stopAll(); await rm(root, { recursive: true, force: true }) }
})

test('general chat searches selected knowledge bases only when auto mode is relevant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-general-knowledge-'))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root)
  const plans = new WorkPlanStore(root)
  const runs = new TaskRunStore(root)
  const searches: Array<{ query: string; knowledgeBaseIds: string[] }> = []
  let skillsLoaded = false
  const runtime = new TaskRuntime({
    taskManager: manager, taskRunStore: runs, workPlanStore: plans,
    resolveEmployee: id => ({ subscriptionId: id, modelId: 'model', gatewayUrl: 'http://unused' }),
    authorizeEmployee: async () => { skillsLoaded = true; throw new Error('general chat must not authorize employee') },
    authorizeModel: async modelId => ({ subscriptionId: 'general-model', modelId, gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    knowledgeSearch: async request => {
      searches.push({ query: request.query, knowledgeBaseIds: request.knowledgeBaseIds })
      return { status: 'NO_MATCH', actualStrategy: 'hybrid', degraded: false, partial: false, durationMs: 1, results: [] }
    },
    createWorker: options => ({
      async run() { await mkdir(options.context.sessionDir, { recursive: true }); await writeFile(join(options.context.sessionDir, 'session.jsonl'), '{}\n'); await options.onSessionCreated?.({ sessionId: 's', sessionFile: join(options.context.sessionDir, 'session.jsonl') }) },
      async abort() {}, async dispose() {},
    }),
  })
  const settle = async (id: string) => { for (let i = 0; i < 200; i++) { if ((await manager.getTask(id))?.activeRunId === null) return; await new Promise(resolve => setTimeout(resolve, 5)) }; assert.fail('run did not settle') }
  try {
    await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('general', '请按公司制度说明报销标准', join(root, 'workspace'), 'general-model')
    await plans.save(scope, { id: task.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, owner: scope, mode: 'conversation', title: 'general', goal: task.prompt, nodes: [], confirmedInputs: [], knowledge: { mode: 'auto', knowledgeBaseIds: ['kb-selected'] }, conversation: { kind: 'general', modelId: 'selected', participants: [{ subscriptionId: 'general-model', modelId: 'selected' }], activeSubscriptionId: 'general-model' }, workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'confirm-each' }), planHash: 'general', createdAt: Date.now() })
    await runtime.executeTask(task.id, { conversation: true }); await settle(task.id)
    assert.deepEqual(searches, [{ query: task.prompt, knowledgeBaseIds: ['kb-selected'] }])
    assert.equal(skillsLoaded, false)
  } finally { await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
})

test('manual conversation without selected sources does not search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-general-manual-'))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root); const plans = new WorkPlanStore(root)
  let searched = false
  const runtime = new TaskRuntime({
    taskManager: manager, workPlanStore: plans, resolveEmployee: id => ({ subscriptionId: id, modelId: 'model', gatewayUrl: 'http://unused' }),
    authorizeModel: async modelId => ({ subscriptionId: 'general-model', modelId, gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    knowledgeSearch: async () => { searched = true; throw new Error('manual empty selection must not search') },
    createWorker: options => ({ async run() { await mkdir(options.context.sessionDir, { recursive: true }); await writeFile(join(options.context.sessionDir, 'session.jsonl'), '{}\n'); await options.onSessionCreated?.({ sessionId: 's', sessionFile: join(options.context.sessionDir, 'session.jsonl') }) }, async abort() {}, async dispose() {} }),
  })
  try {
    await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('general', '请按公司制度说明报销标准', join(root, 'workspace'), 'general-model')
    await plans.save(scope, { id: task.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, owner: scope, mode: 'conversation', title: 'general', goal: task.prompt, nodes: [], confirmedInputs: [], knowledge: { mode: 'manual', knowledgeBaseIds: ['kb-selected'] }, conversation: { kind: 'general', modelId: 'selected', participants: [{ subscriptionId: 'general-model', modelId: 'selected' }], activeSubscriptionId: 'general-model' }, workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'confirm-each' }), planHash: 'general', createdAt: Date.now() })
    await runtime.executeTask(task.id, { conversation: true });
    for (let i = 0; i < 200 && (await manager.getTask(task.id))?.activeRunId !== null; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(searched, false)
  } finally { await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
})
