import '../../electron/common/undici-polyfill'
import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WorkPlanStore } from '../../electron/data/work-plan-store'
import { ArrangementCheckpointStore } from '../../electron/data/arrangement-checkpoint-store'
import { DocumentPreviewStore } from '../../electron/data/document-preview-store'
import { ResultFileStore } from '../../electron/data/result-file-store'
import { ResultArchiveStore } from '../../electron/data/result-archive-store'
import { MediaStore } from '../../electron/data/media-store'
import { VideoStore } from '../../electron/data/video-store'
import { ResultFileService } from '../../electron/service/result-file-service'
import { ResultArchiveService } from '../../electron/service/result-archive-service'
import { installResultFileProtocol, registerResultFileScheme } from '../../electron/bootstrap/result-file-protocol'
import type { WorkPlan } from '../../electron/domain/arrangement-plan'
import type { TaskReadView } from '../../src/shared/types'
import { resultFileActionSchema } from '../../src/shared/result-files'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { seedConversationResults } from './result-files-conversation'
import { installSpeechPermissions } from '../../electron/bootstrap/speech-permissions'

registerResultFileScheme()
const root = process.env.SEP_RESULT_TEST_ROOT!
app.setPath('userData', join(root, 'profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

void app.whenReady().then(async () => {
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  let scope: typeof owner | null = owner
  const files = [
    { id: 'image', path: 'product.png', format: 'png', bytes: await readFile(resolve('build/icon.png')) },
    { id: 'video', path: 'product.mp4', format: 'mp4', bytes: Buffer.from(fixture.mediaFixture.base64, 'base64') },
    { id: 'document', path: 'brief.md', format: 'md', bytes: Buffer.from('# Product brief\nAccepted final file.') },
  ]
  await Promise.all(files.map(file => writeFile(join(workspace, file.path), file.bytes)))
  const conversation = await seedConversationResults(root, owner, files[0].bytes, files[1].bytes)
  const plans = new WorkPlanStore(root)
  const checkpoints = new ArrangementCheckpointStore(root)
  const plan: WorkPlan = {
    id: 'results-test', schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, owner,
    mode: 'auto', title: 'Product media', goal: 'Product media', conversation: null,
    nodes: [{ id: 'node', subscriptionId: 'sub', modelId: 'model', title: 'Product media', instruction: 'Produce', expectedOutput: 'Files',
      dependsOn: [], skillIds: [], requiresUserConfirmation: false,
      deliverables: files.map(file => ({ id: file.id, path: file.path, name: file.id, format: file.format, contentOutline: ['Final'], acceptanceCriteria: ['Saved'] })) }],
    workspace: { mode: 'shared', path: workspace },
    permissions: { preset: 'workspace-edit', allowedTools: [], allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled' },
    confirmedInputs: [], planHash: 'hash', createdAt: 1,
  }
  await plans.save(owner, plan)
  await checkpoints.save(owner, {
    version: 1, taskId: plan.id, owner, planHash: plan.planHash, activeRunId: null, updatedAt: 1,
    state: { status: 'completed', failureNodeIds: [], interruptionReason: null,
      nodes: [{ nodeId: 'node', status: 'completed', attempt: 1, error: null, output: null,
        delivery: { validationAttempts: 1, issues: [], finalFiles: files.map(file => ({
          id: file.id, path: file.path, format: file.format, size: file.bytes.length,
          sha256: createHash('sha256').update(file.bytes).digest('hex'), nodeRunId: 'node-run', validatedAt: 1,
        })) } }] },
  })
  const task: TaskReadView = { id: plan.id, title: plan.title, prompt: plan.goal, workDir: workspace,
    status: 'completed', createdAt: 1, startedAt: 1, completedAt: 2, error: null, logs: [], files: [],
    ownerId: owner.memberId, ownerEnterpriseId: owner.enterpriseId, subscriptionId: 'sub', activeRunId: null,
    workType: { state: 'resolved', kind: 'arrangement' } }
  const scopeSource = { currentScope: () => scope }
  const archive = new ResultArchiveService(new ResultArchiveStore(root), scopeSource, () => root, () => 0)
  const store = new ResultFileStore(root, new DocumentPreviewStore(root, plans, checkpoints), async taskId => taskId === 'conversation-test'
    ? { ...task, id: taskId, workType: { state: 'resolved', kind: 'conversation' } } : task, new MediaStore(root), new VideoStore(root))
  const service = new ResultFileService({
    scope: scopeSource, store, archive,
    reveal: path => { revealed.push(path) },
  })
  const revealed: string[] = []
  const generated = join(root, 'generated')
  await mkdir(generated)
  await archive.configure(async () => generated)
  const videoFile = { taskId: 'conversation-test', jobId: 'video-job', outputId: fixture.output.outputId }
  const completedAt = Date.now()
  await service.queueArchive(owner, videoFile, task.title, completedAt, completedAt, async () => {
    const { name, version, archiveVersion } = await store.actionFile(owner, videoFile, 'sub')
    return { name, version: archiveVersion ?? version }
  }, 'sub')
  await service.saveQueuedArchive(owner, videoFile)
  if ((await service.archiveStatus(videoFile)).state !== 'saved') throw new Error('Test video copy was not saved')
  const requests: Array<{ method: string; range: string | null; status: number }> = []
  installResultFileProtocol({ handle: async request => {
    const response = await service.handle(request)
    requests.push({ method: request.method, range: request.headers.get('range'), status: response.status })
    return response
  } })
  const invoke = <T>(name: string, operation: (input: T) => Promise<unknown>) => ipcMain.handle(`result-test:${name}`, async (_event, input: unknown) => {
    try { return { success: true, data: await operation(input as T) } }
    catch { return { success: false, error: { message: 'Result file unavailable' } } }
  })
  invoke('preview', service.preview.bind(service))
  invoke('release', service.release.bind(service))
  const revealCalls: unknown[] = []
  invoke('reveal', async (input: Parameters<typeof service.reveal>[0]) => { revealCalls.push(input); await service.reveal(input) })
  invoke('action', async raw => {
    const input = resultFileActionSchema.parse(raw)
    if (input.action !== 'copy-path') throw new Error('Unexpected fixture action')
    await service.copyPath(input.file, path => clipboard.writeText(path))
  })
  const blockedRequests: string[] = []
  ipcMain.handle('result-test:state', () => ({ revealed, revealCalls, requests, blockedRequests, imagePath: conversation.imagePath, videoPath: conversation.videoPath }))
  ipcMain.handle('result-test:images', (_event, taskId: string) => ({ success: true, data: taskId === 'conversation-test' ? conversation.images
    : taskId === 'conversation-replay-image' ? conversation.replayImages
      : { capabilities: null, unavailableReason: null, assets: [], selectedReferenceIds: [], jobs: [], archived: false } }))
  ipcMain.handle('result-test:videos', (_event, taskId: string) => ({ success: true, data: taskId === 'conversation-test' ? conversation.videos
    : taskId === 'conversation-replay-video' ? conversation.replayVideos : null }))
  ipcMain.handle('result-test:logout', () => { scope = null; service.clear() })
  ipcMain.handle('result-test:replace', async () => writeFile(join(workspace, 'product.png'), 'changed'))
  const window = new BrowserWindow({ width: 1280, height: 900, show: false,
    webPreferences: { preload: process.env.SEP_RESULT_TEST_PRELOAD!, contextIsolation: true, nodeIntegration: false, offscreen: true } })
  const testUrl = new URL(process.env.SEP_RESULT_TEST_URL!)
  if (testUrl.protocol !== 'http:' || testUrl.hostname !== '127.0.0.1') throw new Error('Result tests require a loopback fixture')
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const target = new URL(details.url)
    const cancel = target.origin !== testUrl.origin || !['GET', 'HEAD'].includes(details.method)
    if (cancel) blockedRequests.push(`${details.method} ${target.origin}`)
    callback({ cancel })
  })
  ipcMain.handle('result-test:secure', () => installSpeechPermissions(window, window.webContents.getURL()))
  await window.loadURL(testUrl.href)
})
app.on('window-all-closed', () => app.quit())
