import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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
import { ConversationArtifactStore } from '../data/conversation-artifact-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { DocumentPreviewStore } from '../data/document-preview-store'
import { ResultFileStore } from '../data/result-file-store'
import { managedFileTools } from '../pi/sdk/pi-managed-file-tools'

test('a desktop-style Save As produces one previewable card that survives task reload', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'csep-external-result-'))
  const root = await realpath(tmp)
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const appData = join(root, 'app-data')
  const manager = new TaskManager(appData)
  const runs = new TaskRunStore(appData)
  const plans = new WorkPlanStore(appData)
  const workspace = join(root, 'workspace')
  const desktop = join(root, 'Desktop')
  await mkdir(desktop)
  const destination = join(desktop, 'report.txt')
  const text = 'Saved to the desktop.'
  const runtime = new TaskRuntime({
    taskManager: manager, taskRunStore: runs, workPlanStore: plans,
    resolveEmployee: subscriptionId => ({ subscriptionId, modelId: 'model', gatewayUrl: 'http://unused' }),
    authorizeModel: async modelId => ({ subscriptionId: 'subscription', modelId, gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    createWorker: options => ({
      async run() {
        const [write] = managedFileTools({ ...options.context, getAccessToken: async () => '', authorizeTool: async request => {
          assert.equal(request.toolName, 'file_save_as')
          return true
        } })
        await write.execute('save', { path: destination, content: text }, undefined, undefined, {} as never)
        await write.execute('default', { path: 'default.txt', content: 'default result' }, undefined, undefined, {} as never)
      }, async abort() {}, async dispose() {},
    }),
  })
  try {
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('desktop output', text, workspace, 'subscription')
    await runtime.executeTask(task.id, { conversation: true })
    for (let attempt = 0; attempt < 200 && (await manager.getTask(task.id))?.activeRunId !== null; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const reloaded = new TaskManager(appData)
    await reloaded.initialize()
    await reloaded.setCurrentUser(scope.memberId, scope.enterpriseId)
    const saved = await reloaded.getTask(task.id)
    assert.equal(saved?.status, 'completed')
    assert.deepEqual(saved?.files, [destination, join(workspace, '成果', task.id, 'default.txt')])
    const stored = { ...saved!, workType: { state: 'resolved', kind: 'conversation' } } as const
    const documents = new DocumentPreviewStore(appData, plans, new ArrangementCheckpointStore(appData))
    const results = new ResultFileStore(appData, documents, async () => stored)
    const fileId = `${task.id}-file-0`
    assert.equal((await documents.readConversation(scope, stored, fileId))?.bytes.toString(), text)
    assert.equal(await results.revealPath(scope, { taskId: task.id, fileId }), destination)
    assert.equal((await results.actionFile(scope, { taskId: task.id, fileId })).verifiedBytes?.toString(), text)
  } finally { await runtime.stopAll() }
})

for (const kind of ['general', 'employee'] as const) {
  for (const [directoryStatus, outcome] of (['ready', 'retryable'] as const).flatMap(status =>
    (['success', 'model-error'] as const).map(result => [status, result] as const))) {
    test(`${kind} chat preserves media tracking with a ${directoryStatus} artifact directory after ${outcome}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'sep-conversation-media-delivery-'))
      const scope = { memberId: 'member', enterpriseId: 'enterprise' }
      const manager = new TaskManager(root)
      const runs = new TaskRunStore(root)
      const plans = new WorkPlanStore(root)
      const artifacts = new ConversationArtifactStore()
      const calls: string[] = []
      let promptSeen = ''
      let delivered = false
      let mediaStops = 0
      const runtime = new TaskRuntime({
        taskManager: manager, taskRunStore: runs, workPlanStore: plans,
        resolveEmployee: id => ({ subscriptionId: id, modelId: 'model', gatewayUrl: 'http://unused' }),
        authorizeModel: async modelId => ({ subscriptionId: 'subscription', modelId, gatewayUrl: 'http://unused' }),
        getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
        conversationArtifactStore: {
          async prepare(workspace, taskId) {
            if (directoryStatus === 'ready') return artifacts.prepare(workspace, taskId)
            return { status: directoryStatus, relativePath: `成果/${taskId}` }
          },
          scan: (workspace, taskId) => artifacts.scan(workspace, taskId),
        },
        // The fallback case exposes only a query tool, as when recovering an existing video.
        video: { async prepareRun() { return { names: ['video_get_job'], async execute(name) { calls.push(name); return { saveStatus: 'SAVED' } } } },
          async waitForRun() {}, async stopTask() { mediaStops++ } },
        media: { async prepareRun() { if (directoryStatus === 'retryable') return undefined; return { names: ['media_generate_image'], async execute(name) {
          calls.push(name)
          return { generationStatus: 'SUCCEEDED', saveStatus: 'SAVED', assets: [{ localAssetId: 'saved-output', source: 'output', status: 'SAVED' }] }
        } } }, async waitForRun() { delivered = true }, async stopTask() { mediaStops++ } },
        createWorker: options => ({
          async run(prompt) {
            promptSeen = prompt
            const { taskId, toolPolicy, browserArtifactTaskId, browserTaskStateDir } = options.context
            assert.equal(toolPolicy?.fileAccess, 'workspace')
            assert.equal(browserArtifactTaskId, directoryStatus === 'ready' ? taskId : undefined)
            assert.equal(browserTaskStateDir, directoryStatus === 'ready' ? runs.getTaskDir(scope, taskId) : undefined)
            assert.deepEqual(toolPolicy?.conversationOutput, { status: directoryStatus, relativePath: `成果/${taskId}` })
            assert.doesNotMatch(prompt, /只能使用这个固定路径|不要改用其他目录/)
            assert.match(prompt, /图片和视频工具的成果由客户端独立保存/)
            assert.match(prompt, /saveStatus="SAVED" 且有已保存成果时/)
            assert.match(prompt, /普通成果目录为空、创建失败或文件工具不可用，不影响已保存媒体成果的交付/)
            assert.match(prompt, /不要为核对或归档媒体成果调用 ls、find、bash/)
            assert.match(prompt, /不要将本地保存路径要求写入 creativeBrief/)
            assert.match(prompt, /用户明确要求另存指定目录时，仅使用实际可用的导出能力/)
            assert.match(prompt, /不得重新生成媒体来解决导出问题/)
            assert.doesNotMatch(prompt, /请将本轮需要保存的成果放入/)
            if (options.context.mediaTools) {
              const result = await options.context.mediaTools.execute('media_generate_image', {})
              assert.equal((result as { saveStatus: string }).saveStatus, 'SAVED')
            }
            await options.context.videoTools!.execute('video_get_job', { jobId: 'saved-video' })
            await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
              sequence: 0, occurredAt: Date.now(), type: 'text_delta', data: { text: 'Generated and saved.' } })
            if (outcome === 'model-error') throw new Error('Model response interrupted after media submission')
          }, async abort() {}, async dispose() {},
        }),
      })
      try {
        await manager.initialize()
        await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
        const task = await manager.createTask('media', 'generate a product grid', join(root, 'workspace'), 'subscription')
        await plans.save(scope, {
          id: task.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, owner: scope, mode: 'conversation',
          title: task.title, goal: task.prompt, nodes: [], confirmedInputs: [],
          conversation: { ...(kind === 'general' ? { kind, modelId: 'model' } : {}),
            participants: [{ subscriptionId: 'subscription', modelId: 'model' }], activeSubscriptionId: 'subscription' },
          workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'confirm-each' }),
          planHash: 'media', createdAt: Date.now(),
        })
        await runtime.executeTask(task.id, { conversation: true })
        for (let i = 0; i < 200 && (await manager.getTask(task.id))?.activeRunId !== null; i++) await new Promise(resolve => setTimeout(resolve, 10))
        const completed = await manager.getTask(task.id)
        assert.equal(completed?.activeRunId, null)
        assert.equal(completed?.status, outcome === 'success' ? 'completed' : 'failed')
        assert.equal(mediaStops, 0)
        assert.deepEqual(completed?.files, [])
        assert.ok(promptSeen.length > 0)
        assert.equal(delivered, outcome === 'success')
        assert.deepEqual(calls, directoryStatus === 'ready' ? ['media_generate_image', 'video_get_job'] : ['video_get_job'])
        if (directoryStatus === 'ready') assert.deepEqual(await readdir(join(task.workDir!, '成果', task.id)), [])
        const messages = await new ConversationContextStore(runs.getTaskDir(scope, task.id)).listMessages()
        assert.equal(messages.find(message => message.role === 'assistant')?.content, 'Generated and saved.')
      } finally { await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
    })
  }
}

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
  let vision: boolean | null = false
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
    authorizeModel: async modelId => ({ subscriptionId, modelId, vision, gatewayUrl: 'http://unused', media, video }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    knowledgeSearch: async () => assert.fail('must not search employee knowledge'),
    media: { async prepareRun(input) {
      assert.deepEqual(input.employee.media, media)
      assert.equal(input.employee.runtimeSnapshot, undefined)
      assert.equal(input.toolPolicy?.preset, 'workspace-edit')
      preparations.push({ kind: 'image', subscriptionId: input.subscriptionId })
      return mediaTools
    }, async stopTask() {}, async waitForRun() { completedMedia.push('image') } },
    video: { async prepareRun(input) {
      assert.deepEqual(input.employee.video, videoFixture.runtime)
      assert.equal(input.employee.runtimeSnapshot, undefined)
      assert.equal(input.toolPolicy?.preset, 'workspace-edit')
      preparations.push({ kind: 'video', subscriptionId: input.subscriptionId })
      return videoTools
    }, async stopTask() {}, async waitForRun() { completedMedia.push('video') } },
    createWorker: options => ({
      async run(prompt) {
        contexts.push(options.context)
        assert.match(prompt, new RegExp(`成果/${options.context.taskId}`))
        assert.match(prompt, /遵从用户指定的交付形式/)
        assert.match(prompt, /用户明确只需对话回复时不生成文件/)
        assert.match(prompt, /本轮形成包含多项建议、对比、测算或执行步骤的方案、分析、报告、清单等成体系内容时，必须保存为文件，无需用户另行要求/)
        assert.match(prompt, /草案或信息待补充也应保存并注明/)
        assert.match(prompt, /未指定格式的文本成果默认使用 Markdown/)
        assert.match(prompt, /先保存完整内容，最终答复只给大致摘要和实际文件位置/)
        assert.match(prompt, /简单问答、零散建议和状态反馈直接在对话中回答/)
        assert.match(prompt, /检索或工具调用本身不触发文档生成/)
        assert.match(prompt, /已有图片、视频或其他文件成果时直接交付，除非用户要求，不额外生成过程记录或说明文件/)
        assert.match(prompt, /只报告实际保存成功的文件/)
        assert.match(prompt, /保存失败时如实说明/)
        assert.doesNotMatch(prompt, /只要本轮进行了新闻或资料检索，也要保存检索结果 Markdown|形成了值得留存的方案、分析、总结、清单或说明/)
        assert.ok(['first', 'second', 'third'].some(text => prompt.startsWith(`${text}\n\n`)))
        assert.doesNotMatch(prompt, /当前通用助手没有账号主体的图片\/视频生成授权/)
        assert.match(prompt, /优先使用当前会话已提供的图片\/视频工具/)
        assert.match(prompt, /不能静默以脚本合成替代/)
        assert.match(prompt, /未指定的常规规格由模型.*本轮直接执行/)
        assert.match(prompt, /不要仅为确认.*追加一轮对话/)
        assert.match(prompt, /分别判断提交、生成、平台文件、本地保存和费用/)
        assert.match(prompt, /费用待核对不等于仍在生成，未知金额不等于免费/)
        assert.match(prompt, /同一项提交异常后不得自行再次生成，先查询原 jobId；其他独立任务可以继续/)
        assert.match(prompt, /不得用新 ID 绕过原任务的提交不明状态/)
        assert.equal(options.context.mediaTools, mediaTools)
        assert.equal(options.context.videoTools, videoTools)
        await options.context.mediaTools.execute('media_generate_image', {})
        await options.context.videoTools.execute('video_generate', {})
        await options.context.videoTools.execute('video_from_image', {})
        const artifactDir = join(options.context.workspaceDir, '成果', options.context.taskId)
        await mkdir(artifactDir, { recursive: true })
        await writeFile(join(artifactDir, 'report.md'), '# Result', 'utf8')
        const emit = (type: string, data: unknown) => options.onEvent({
          taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId,
          sequence: 0, occurredAt: Date.now(), type, data,
        })
        await emit('tool_execution_start', { toolId: 'report-write', toolName: 'write', input: { path: join(artifactDir, 'report.md') } })
        await emit('tool_execution_end', { toolId: 'report-write', toolName: 'write', success: true })
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
      workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'confirm-each' }),
      planHash: 'general', createdAt: Date.now(),
    })
    runtime = createRuntime()
    await runtime.executeTask(task.id, { conversation: true })
    await settle(task.id)
    subscriptionId = 'subscription-b'
    vision = true
    await runtime.continueConversation(task.id, 'second')
    await settle(task.id)
    await runtime.stopAll()
    runtime = createRuntime()
    vision = null
    await runtime.continueConversation(task.id, 'third')
    await settle(task.id)
    assert.equal(contexts.length, 3)
    assert.deepEqual(contexts.map(context => context.vision), [false, true, null])
    assert.deepEqual((await manager.getTask(task.id))?.files, [join(task.workDir!, '成果', task.id, 'report.md')])
    for (const context of contexts) {
      assert.equal(context.modelId, 'selected')
      assert.equal(context.employeeProfile, undefined)
      assert.equal(context.systemPrompt, undefined)
      assert.equal(context.useNativeSystemPrompt, true)
      assert.equal(context.disableSkills, true)
      assert.equal(context.enableCommonTools, true)
      assert.deepEqual(context.additionalSkillPaths, [])
      assert.equal(context.toolPolicy?.preset, 'workspace-edit')
      assert.equal(context.toolPolicy?.approvalMode, 'confirm-each')
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

test('general chat passes a retryable artifact destination to the tool policy and ignores scan failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-general-artifact-fallback-'))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root)
  const runs = new TaskRunStore(root)
  let promptSeen = ''
  const runtime = new TaskRuntime({
    taskManager: manager, taskRunStore: runs,
    resolveEmployee: id => ({ subscriptionId: id, modelId: 'model', gatewayUrl: 'http://unused' }),
    authorizeModel: async modelId => ({ subscriptionId: 'general-model', modelId, gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
    conversationArtifactStore: {
      async prepare(_workspace, taskId) { return { status: 'retryable', relativePath: `成果/${taskId}` } },
      async scan() { throw new Error('scan unavailable') },
    },
    createWorker: options => ({
      async run(prompt) {
        promptSeen = prompt
        assert.deepEqual(options.context.toolPolicy?.conversationOutput, { status: 'retryable', relativePath: `成果/${options.context.taskId}` })
        assert.match(prompt, /用户明确指定位置时，传入指定路径/)
        assert.doesNotMatch(prompt, /请尝试在工作目录下创建|只能使用这个固定路径|不要改用其他目录/)
        assert.match(prompt, /遵从用户指定的交付形式/)
        assert.match(prompt, /用户明确只需对话回复时不生成文件/)
        assert.match(prompt, /本轮形成包含多项建议、对比、测算或执行步骤的方案、分析、报告、清单等成体系内容时，必须保存为文件，无需用户另行要求/)
        assert.match(prompt, /草案或信息待补充也应保存并注明/)
        assert.match(prompt, /未指定格式的文本成果默认使用 Markdown/)
        assert.match(prompt, /先保存完整内容，最终答复只给大致摘要和实际文件位置/)
        assert.match(prompt, /简单问答、零散建议和状态反馈直接在对话中回答/)
        assert.match(prompt, /检索或工具调用本身不触发文档生成/)
        assert.match(prompt, /已有图片、视频或其他文件成果时直接交付，除非用户要求，不额外生成过程记录或说明文件/)
        assert.match(prompt, /只报告实际保存成功的文件/)
        assert.match(prompt, /保存失败时如实说明/)
        assert.doesNotMatch(prompt, /只要本轮进行了新闻或资料检索，也要保存检索结果 Markdown|形成了值得留存的方案、分析、总结、清单或说明/)
        await mkdir(options.context.sessionDir, { recursive: true })
        const sessionFile = join(options.context.sessionDir, 'session.jsonl')
        await writeFile(sessionFile, '{}\n', 'utf8')
        await options.onSessionCreated?.({ sessionId: 'session', sessionFile })
      }, async abort() {}, async dispose() {},
    }),
  })
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      if ((await manager.getTask(id))?.activeRunId === null) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail('run did not settle')
  }
  try {
    await manager.initialize()
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = await manager.createTask('general', 'write a report', join(root, 'workspace'), 'general-model')
    const plans = new WorkPlanStore(root)
    await plans.save(scope, {
      id: task.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, owner: scope, mode: 'conversation',
      title: 'general', goal: task.prompt, nodes: [], confirmedInputs: [],
      conversation: { kind: 'general', modelId: 'selected', participants: [{ subscriptionId: 'general-model', modelId: 'selected' }], activeSubscriptionId: 'general-model' },
      workspace: { mode: 'shared', path: task.workDir }, permissions: effectivePermissionPolicy({ preset: 'full-local', approvalMode: 'auto-approve' }),
      planHash: 'general', createdAt: Date.now(),
    })
    await runtime.executeTask(task.id, { conversation: true })
    await settle(task.id)
    assert.ok(promptSeen.length > 0)
    assert.equal((await manager.getTask(task.id))?.status, 'completed')
  } finally { await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
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
