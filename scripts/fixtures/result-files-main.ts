import '../../electron/common/undici-polyfill'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WorkPlanStore } from '../../electron/data/work-plan-store'
import { ArrangementCheckpointStore } from '../../electron/data/arrangement-checkpoint-store'
import { DocumentPreviewStore } from '../../electron/data/document-preview-store'
import { ResultFileStore } from '../../electron/data/result-file-store'
import { ResultFileService } from '../../electron/service/result-file-service'
import { installResultFileProtocol, registerResultFileScheme } from '../../electron/bootstrap/result-file-protocol'
import type { WorkPlan } from '../../electron/domain/arrangement-plan'
import type { TaskReadView } from '../../src/shared/types'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'

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
  const service = new ResultFileService({
    scope: { currentScope: () => scope },
    store: new ResultFileStore(root, new DocumentPreviewStore(root, plans, checkpoints), async () => task),
    reveal: path => { revealed.push(path) },
  })
  const revealed: string[] = []
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
  invoke('reveal', service.reveal.bind(service))
  ipcMain.handle('result-test:state', () => ({ revealed, requests }))
  ipcMain.handle('result-test:logout', () => { scope = null; service.clear() })
  ipcMain.handle('result-test:replace', async () => writeFile(join(workspace, 'product.png'), 'changed'))
  const window = new BrowserWindow({ width: 1280, height: 900, show: false,
    webPreferences: { preload: process.env.SEP_RESULT_TEST_PRELOAD!, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL(process.env.SEP_RESULT_TEST_URL!)
})
app.on('window-all-closed', () => app.quit())
