import * as assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { ResultArchiveStore, localArchiveDay, type ResultArchiveEntry } from '../data/result-archive-store'
import { ScopePath } from '../data/scope-path'
import { TaskStore } from '../data/task-store'
import { describeConversationResult, ResultFileStore, type CommittedResultSave } from '../data/result-file-store'
import { DocumentPreviewStore } from '../data/document-preview-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { validateDeliveryFiles } from '../data/arrangement-delivery-files'
import type { WorkPlan } from '../domain/arrangement-plan'
import { TaskManager } from '../runtime/task-manager'
import { ResultArchiveService } from './result-archive-service'
import { ResultFileService } from './result-file-service'
import type { ResultFileRequest } from '../../src/shared/result-files'

const owner = { memberId: 'member', enterpriseId: 'company' }
const unknownFailure = '原文件已生成，副本未保存。请重试。'
const locationFailure = '原文件已生成。找不到保存文件夹或该位置已不可用，请恢复连接或换个文件夹后重试。'
const spaceFailure = '原文件已生成。保存位置空间不足，请释放空间或换个文件夹后重试。'
const reconnectFailure = '原文件已生成。无法确认原保存位置是否已有副本。请重新连接原保存位置后重试。'
const describe = (input: ResultFileRequest) => async () => ({ name: '报告.md', version: JSON.stringify(input) })

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'csep-result-archive-')))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const profile = join(temp, 'profile'), store = new ResultArchiveStore(profile)
  const root = join(temp, 'results')
  const original = join(temp, 'original.md')
  await Promise.all([mkdir(root), writeFile(original, '原件')])
  let scope = owner, revision = 1
  const currentScope = () => scope
  let videoOwner = 'first', originalAvailable = true
  const createArchive = (store: ResultArchiveStore) => new ResultArchiveService(store, { currentScope }, () => join(temp, 'Documents'), () => revision)
  const archive = createArchive(store)
  const reveal: string[] = []
  const committed: CommittedResultSave[] = []
  const createFiles = (archive: ResultArchiveService) => new ResultFileService({ scope: { currentScope }, archive, reveal: path => { reveal.push(path) }, store: {
    open: async () => { throw new Error('unused') }, revealPath: async () => original,
    saveIntents: async (account, taskId, input) => account.memberId !== owner.memberId ? [] :
      committed.filter(record => record.file.taskId === taskId && (!input || JSON.stringify(record.file) === JSON.stringify(input))),
    actionFile: async (_scope, input, subscriptionId) => {
      if (!originalAvailable || ('jobId' in input && (subscriptionId ?? videoOwner) !== 'first')) throw new Error('Original unavailable')
      return { path: original, name: '报告.md', version: JSON.stringify(input) }
    },
  } })
  const files = createFiles(archive)
  const queue = (file: ResultFileRequest, title: string, when: number, startedAt: number, subscriptionId?: string, name?: string) =>
    files.queueArchive(owner, file, title, when, startedAt, name ? async () => ({ name, version: JSON.stringify(file) }) : describe(file), subscriptionId)
  const save = async (file: ResultFileRequest, title: string, when: number, startedAt: number, subscriptionId?: string, name?: string) => {
    await queue(file, title, when, startedAt, subscriptionId, name)
    await files.saveQueuedArchive(owner, file)
  }
  return { temp, profile, store, root, original, archive, files, reveal, queue, save, committed,
    restart: () => createFiles(createArchive(new ResultArchiveStore(profile))),
    changeEmployee: () => { videoOwner = 'second' }, hideOriginal: () => { originalAvailable = false },
    switchAccount(memberId: string) { scope = { ...owner, memberId }; revision++ } }
}

test('archive opt-in is local to the current account and a dialog cannot commit after switching accounts', async t => {
  const f = await fixture(t)
  const initial = await f.archive.settings()
  assert.equal(initial.mode, 'off')
  assert.equal(initial.path, join(f.temp, 'Documents', '元机AI', '生成文件'))
  assert.equal(await f.archive.configure(async () => null), null)
  assert.equal((await f.archive.configure())?.mode, 'system')
  await assert.rejects(f.archive.configure(async () => { f.switchAccount('other'); return f.root }), { code: 'AUTH_REQUIRED' })
  assert.equal((await f.archive.settings()).mode, 'off')
  f.switchAccount('member')
  assert.equal((await f.archive.settings()).mode, 'system')
})

test('completed output date groups results; repeated events and name collisions do not overwrite originals', async t => {
  const f = await fixture(t)
  const a = { taskId: 'task-1', fileId: 'file-a' }, b = { taskId: 'task-1', assetId: 'image-b' }, c = { taskId: 'task-1', jobId: 'job', outputId: 'out' }
  await f.save(a, '试用:项目', Date.now(), Date.now())
  assert.deepEqual(await readdir(f.root), [])
  await f.archive.configure(async () => f.root)
  const start = Date.now() + 1000
  const day = new Date(start); day.setHours(23, 59, 0, 0)
  const next = new Date(day); next.setDate(next.getDate() + 1); next.setHours(0, 1, 0, 0)
  const save = (request: ResultFileRequest, when: number) => f.save(request, '试用:项目', when, start)
  await Promise.all([save(a, +day), save(b, +day), save(a, +day)])
  await save(c, +next)
  const folder = (await readdir(join(f.root, localArchiveDay(+day))))[0]!
  assert.equal(folder, '试用_项目')
  const archived = join(f.root, localArchiveDay(+day), folder)
  assert.deepEqual((await readdir(archived)).sort(), ['报告 (2).md', '报告.md'].sort())
  assert.deepEqual(await readdir(join(f.root, localArchiveDay(+next), folder)), ['报告.md'])
  assert.equal(await readFile(f.original, 'utf8'), '原件')
  await f.files.reveal(a)
  assert.equal(dirname(f.reveal.at(-1)!), archived)
  assert.equal(await f.files.saveDialogPath(a, '另存.md'), join(archived, '另存.md'))
  assert.equal(await f.files.saveDialogPath(a, basename(f.reveal.at(-1)!)), join(archived, `${basename(f.reveal.at(-1)!, '.md')} - 副本.md`))
})

test('path-like and generic prompt titles use the first descriptive filename without exposing the local path', async t => {
  const f = await fixture(t)
  await f.archive.configure(async () => f.root)
  const now = Date.now(), day = join(f.root, localArchiveDay(now))
  const first = { taskId: 'task-1', fileId: 'plan' }, later = { taskId: 'task-1', fileId: 'other' }
  const generic = { taskId: 'task-2', fileId: 'plan' }
  await f.save(first, '"C:\\Users\\sample\\Desktop\\新建文件夹"，参考文件夹…', now, now, undefined, '手机概念展示视频_剪辑方案.md')
  await f.save(later, '另一个标题', now, now, undefined, '分镜.md')
  await f.save(generic, '参考文件夹…', now, now, undefined, '包装概念_脚本.md')
  assert.deepEqual((await readdir(day)).sort(), ['手机概念展示视频', '包装概念'].sort())
  assert.deepEqual((await readdir(join(day, '手机概念展示视频'))).sort(), ['手机概念展示视频_剪辑方案.md', '分镜.md'].sort())
  assert.equal(await readFile(join(day, '包装概念', '包装概念_脚本.md'), 'utf8'), '原件')
})

test('parallel same-title tasks take separate numbered directories and never reuse a pre-existing directory', async t => {
  const f = await fixture(t)
  await f.archive.configure(async () => f.root)
  const now = Date.now(), day = join(f.root, localArchiveDay(now))
  const external = join(day, '交付报告')
  await mkdir(external, { recursive: true })
  await writeFile(join(external, '报告.md'), '本地文件')
  const a = { taskId: 'task-1', fileId: 'first' }, b = { taskId: 'task-2', fileId: 'first' }
  const later = { taskId: a.taskId, fileId: 'second' }
  await Promise.all([f.save(a, '交付报告', now, now), f.save(b, '交付报告', now, now), f.save(later, '交付报告', now, now)])
  const restarted = f.restart()
  for (const file of [a, b, later]) assert.equal(await restarted.reveal(file), false)
  assert.equal(dirname(f.reveal[0]!), dirname(f.reveal[2]!))
  assert.notEqual(dirname(f.reveal[0]!), dirname(f.reveal[1]!))
  assert.deepEqual((await readdir(day)).sort(), ['交付报告', '交付报告（2）', '交付报告（3）'].sort())
  assert.deepEqual(await readdir(external), ['报告.md'])
  assert.equal(await readFile(join(external, '报告.md'), 'utf8'), '本地文件')
})

test('a task whose directory was replaced does not save into the replacement', async t => {
  const f = await fixture(t)
  await f.archive.configure(async () => f.root)
  const now = Date.now(), file = { taskId: 'task-1', fileId: 'first' }
  await f.save(file, '交付报告', now, now)
  const day = join(f.root, localArchiveDay(now)), original = join(day, '交付报告')
  await rename(original, join(day, '已移动'))
  await mkdir(original)
  const later = { taskId: file.taskId, fileId: 'second' }
  await f.save(later, '交付报告', now, now)
  assert.deepEqual(await readdir(original), [])
  assert.deepEqual(await readdir(join(day, '交付报告（2）')), ['报告.md'])
  assert.equal(await readFile(join(day, '已移动', '报告.md'), 'utf8'), '原件')
})

test('a task with an existing legacy directory keeps its original copy and directory name', async t => {
  const f = await fixture(t)
  await f.archive.configure(async () => f.root)
  const now = Date.now(), file = { taskId: 'task-1', fileId: 'first' }
  await f.save(file, '交付报告', now, now)
  const ledgerPath = join(new ScopePath(f.profile).taskDir(owner, file.taskId), 'result-archive.json')
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, ResultArchiveEntry>
  const record = Object.values(ledger)[0]!
  const legacy = '交付报告-4c39091bef54', day = join(f.root, record.day)
  await rename(join(day, record.folder), join(day, legacy))
  record.folder = legacy
  delete record.folderLabel
  delete record.folderIdentity
  await writeFile(ledgerPath, JSON.stringify(ledger))

  const restarted = f.restart()
  assert.equal(await restarted.reveal(file), false)
  assert.equal(f.reveal.at(-1), join(day, legacy, '报告.md'))
  await f.save({ taskId: file.taskId, fileId: 'second' }, '交付报告', now, now)
  assert.deepEqual(await readdir(day), [legacy])
  assert.deepEqual((await readdir(join(day, legacy))).sort(), ['报告.md', '报告 (2).md'].sort())
})

test('archive status and reveal follow canonical Windows casing, but never a replaced archive folder', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const file = { taskId: 'task', fileId: 'task-file-0' }
  await f.archive.configure(async () => f.root)
  const time = Date.now()
  await f.save(file, 'Report', time, time)
  assert.equal(await f.store.available(join(f.temp, 'RESULTS')), true)
  await f.files.reveal(file)
  const original = f.reveal.at(-1)!
  const directory = dirname(original)
  const renamed = join(directory, basename(original).toUpperCase())
  await rename(original, join(directory, 'intermediate.md'))
  await rename(join(directory, 'intermediate.md'), renamed)
  const canonicalDirectory = join(dirname(directory), basename(directory).toUpperCase())
  const interim = join(dirname(directory), 'intermediate')
  await rename(directory, interim)
  await rename(interim, canonicalDirectory)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'saved' })
  await f.files.reveal(file)
  assert.equal(f.reveal.at(-1), join(canonicalDirectory, basename(renamed)))

  const other = join(f.temp, 'moved')
  await rename(canonicalDirectory, other)
  await symlink(other, directory, 'junction')
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'missing' })
})

test('a replaced copy is not revealed or overwritten, and retry saves the original under a free name', async t => {
  const f = await fixture(t)
  const file = { taskId: 'task-1', fileId: 'report' }
  await f.archive.configure(async () => f.root)
  const now = Date.now()
  await f.save(file, 'Report', now, now)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'saved' })
  assert.equal(await f.files.reveal(file), false)
  const saved = f.reveal.at(-1)!
  const replacement = join(f.temp, 'replacement.md')
  await writeFile(replacement, '替换')
  await rename(replacement, saved)

  const restarted = f.restart()
  await restarted.resumeArchives(owner, [file.taskId], new AbortController().signal)
  assert.deepEqual(await restarted.archiveStatus(file), { state: 'missing' })
  assert.equal(await restarted.reveal(file), true)
  assert.equal(f.reveal.at(-1), f.original)
  const copied: string[] = []
  await restarted.copyPath(file, path => { copied.push(path) })
  assert.deepEqual(copied, [f.original])
  assert.deepEqual(await readdir(dirname(saved)), [basename(saved)])

  await restarted.retryArchive(file)
  assert.deepEqual(await restarted.archiveStatus(file), { state: 'saved' })
  assert.equal(await restarted.reveal(file), false)
  assert.equal(f.reveal.at(-1), join(dirname(saved), '报告 (2).md'))
  assert.equal(await readFile(f.reveal.at(-1)!, 'utf8'), '原件')
  assert.equal(await readFile(saved, 'utf8'), '替换')
  assert.equal(await readFile(f.original, 'utf8'), '原件')
})

test('a legacy saved record without a copy identity remains readable and gains one when retried', async t => {
  const f = await fixture(t)
  const file = { taskId: 'task-1', fileId: 'report' }
  await f.archive.configure(async () => f.root)
  const now = Date.now()
  await f.save(file, 'Report', now, now)
  await f.files.reveal(file)
  const saved = f.reveal.at(-1)!
  const ledgerPath = join(new ScopePath(f.profile).taskDir(owner, file.taskId), 'result-archive.json')
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, ResultArchiveEntry>
  const record = Object.values(ledger)[0]!
  assert.ok(record.targetIdentity)
  delete record.targetIdentity
  await writeFile(ledgerPath, JSON.stringify(ledger))

  const restarted = f.restart()
  assert.deepEqual(await restarted.archiveStatus(file), { state: 'saved' })
  assert.equal(await restarted.reveal(file), false)
  assert.equal(f.reveal.at(-1), saved)
  await rm(saved)
  await restarted.retryArchive(file)
  assert.ok((await f.store.entry(owner, file.taskId, 'file:report'))?.targetIdentity)
  assert.equal(await readFile(saved, 'utf8'), '原件')
})

test('a media job and document from the same run use its original root after a settings change', async t => {
  const f = await fixture(t)
  const next = join(f.temp, 'new-results')
  await mkdir(next)
  await f.archive.configure(async () => f.root)
  const startedAt = Date.now()
  await new Promise(resolve => setTimeout(resolve, 5))
  await f.archive.configure(async () => next)
  const first = { taskId: 'task-1', fileId: 'before' }, second = { taskId: 'task-1', fileId: 'after' }, media = { taskId: 'task-1', assetId: 'image' }
  const completedAt = Date.now()
  await f.save(first, '报告', completedAt, startedAt)
  await f.save(media, '报告', completedAt, startedAt)
  await f.save(second, '报告', completedAt, completedAt)
  await f.files.reveal(first)
  await f.files.reveal(second)
  await f.files.reveal(media)
  assert.deepEqual(f.reveal.map(path => dirname(dirname(dirname(path)))), [f.root, next, f.root])
  const copied: string[] = []
  const restarted = f.restart()
  for (const file of [first, second, media]) await restarted.copyPath(file, path => { copied.push(path) })
  assert.deepEqual(copied, f.reveal)
})

test('copying a saved path does not write to the clipboard after the account changes', async t => {
  const f = await fixture(t)
  const file = { taskId: 'task-1', fileId: 'report' }
  await f.archive.configure(async () => f.root)
  const now = Date.now()
  await f.save(file, 'Report', now, now)
  const destination = f.store.destination.bind(f.store)
  t.mock.method(f.store, 'destination', async (entry: ResultArchiveEntry) => {
    const saved = await destination(entry)
    assert.ok(saved)
    f.switchAccount('other')
    return saved
  })
  const copied: string[] = []
  await assert.rejects(f.files.copyPath(file, path => { copied.push(path) }), { code: 'AUTH_REQUIRED' })
  assert.deepEqual(copied, [])
})

test('an unavailable destination preserves the original and retry keeps the recorded date after changing root', async t => {
  const f = await fixture(t)
  await f.archive.configure(async () => f.root)
  const doneAt = Date.now() + 1000
  const file = { taskId: 'task-1', nodeId: 'node-1', deliverableId: 'delivery-1' }
  await rename(f.root, join(f.temp, 'offline'))
  await f.save(file, '报告', doneAt, doneAt)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'failed', message: locationFailure })
  assert.deepEqual(await f.restart().archiveStatus(file), { state: 'failed', message: locationFailure })
  await assert.rejects(f.files.retryArchive(file), { code: 'INVALID_STATE', message: locationFailure })
  assert.equal(await f.files.reveal(file), true)
  assert.equal(f.reveal.at(-1), f.original)
  const next = join(f.temp, 'new-results')
  await mkdir(next)
  await f.archive.configure(async () => next)
  await f.files.retryArchive(file)
  assert.equal(await f.files.reveal(file), false)
  assert.equal(basename(dirname(dirname(f.reveal.at(-1)!))), localArchiveDay(doneAt))
  assert.equal(await readFile(f.reveal.at(-1)!, 'utf8'), '原件')
})

test('resumes the persisted intent when the original committed but its saved callback never ran', async t => {
  const f = await fixture(t)
  const file = { taskId: 'task-1', assetId: 'image' }
  await f.archive.configure(async () => f.root)
  const now = Date.now()
  await f.queue(file, '图片', now, now)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'pending' })
  const restarted = f.restart()
  await restarted.resumeArchives(owner, [file.taskId], new AbortController().signal)
  assert.deepEqual(await restarted.archiveStatus(file), { state: 'saved' })
  await restarted.reveal(file)
  assert.equal(await readFile(f.reveal.at(-1)!, 'utf8'), '原件')
})

test('retries a failed scheduled report copy from its verified snapshot using the actual filename', async t => {
  const f = await fixture(t)
  const scope = { currentScope: () => owner }
  const manager = new TaskManager(f.profile)
  await manager.initialize()
  await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
  const task = await manager.createTask('Daily report', 'Generate a daily report')
  const workspace = task.workDir!
  const plans = new WorkPlanStore(f.profile), checkpoints = new ArrangementCheckpointStore(f.profile)
  const previews = new DocumentPreviewStore(f.profile, plans, checkpoints)
  const store = new ResultFileStore(f.profile, previews, async () => ({ ...task, workType: { state: 'resolved', kind: 'arrangement' } }))
  const files = new ResultFileService({ scope, archive: f.archive, store, reveal: path => { f.reveal.push(path) } })
  const ref = { taskId: task.id, nodeId: 'node', deliverableId: 'report' }
  const actual = 'Sales-2026-11-26.md'
  const plan: WorkPlan = { id: task.id, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1,
    owner, mode: 'auto', title: task.title, goal: 'Daily report', conversation: null,
    scheduledOrigin: { definitionId: 'definition', occurrenceId: 'occurrence' },
    nodes: [{ id: ref.nodeId, subscriptionId: 'sub', modelId: 'model', title: 'Report', instruction: 'Write', expectedOutput: 'Report',
      dependsOn: [], skillIds: [], requiresUserConfirmation: false,
      deliverables: [{ id: ref.deliverableId, name: 'Report', path: 'Sales-YYYY-MM-DD.md', format: 'md', contentOutline: ['Report'], acceptanceCriteria: ['Report'] }] }],
    workspace: { mode: 'shared', path: workspace }, permissions: { preset: 'workspace-edit', allowedTools: [], allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled' },
    confirmedInputs: [], planHash: 'scheduled-hash', createdAt: 1 }
  await plans.save(owner, plan)
  await f.archive.configure(async () => f.root)
  const startedAt = Date.now()
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, actual), '# Verified report')
  const node = plan.nodes[0]!
  const accepted = await validateDeliveryFiles(workspace, { ...node, deliverables: [{ ...node.deliverables![0]!, path: actual }] },
    { nodeId: node.id, summary: 'Done', finalDeliverables: [{ id: ref.deliverableId, path: actual }] }, 'node-run', undefined,
    { taskDirectory: new ScopePath(f.profile).taskDir(owner, task.id) })
  assert.ok(accepted.ok)
  const original = accepted.files[0]!
  const version = `${original.nodeRunId}:${original.sha256}:${original.path}`
  const intent = await files.queueArchive(owner, ref, task.title, Date.now(), startedAt, async () => ({ name: actual, version }))
  assert.ok(intent)
  // Emulate the earlier lookup failure recorded before this fix.
  await f.store.fail(owner, task.id, JSON.stringify(['delivery', ref.nodeId, ref.deliverableId]), version, () => {}, 'source')
  await checkpoints.save(owner, { version: 1, taskId: task.id, owner, planHash: plan.planHash, activeRunId: 'run', updatedAt: 1,
    state: { status: 'completed', failureNodeIds: [], interruptionReason: null,
      nodes: [{ nodeId: node.id, status: 'completed', attempt: 1, error: null, output: null,
        delivery: { validationAttempts: 1, issues: [], finalFiles: [{ ...original, saveIntent: intent }] } }] } })
  assert.equal((await files.archiveStatus(ref)).state, 'failed')
  await files.retryArchive(ref)
  assert.deepEqual(await files.archiveStatus(ref), { state: 'saved' })
  await files.reveal(ref)
  const copy = f.reveal.at(-1)!
  assert.notEqual(copy, join(workspace, actual))
  assert.equal(basename(copy), actual)
  assert.equal(await readFile(copy, 'utf8'), '# Verified report')
  assert.equal(await readFile(join(workspace, actual), 'utf8'), '# Verified report')
})

test('legacy duplicate paths do not renumber original files or their archived copies after restart', async t => {
  const f = await fixture(t)
  const openTasks = async () => {
    const manager = new TaskManager(f.profile)
    await manager.initialize()
    await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
    return manager
  }
  const task = await (await openTasks()).createTask('history', 'generate a report')
  const workspace = task.workDir!
  await f.archive.configure(async () => f.root)
  const startedAt = Date.now()
  await mkdir(workspace, { recursive: true })
  await Promise.all(['first.md', 'middle.md', 'last.md'].map(path => writeFile(join(workspace, path), path)))
  const legacy = { ...task, files: ['first.md', 'middle.md', join(workspace, 'middle.md'), 'last.md', 'last.md'] }
  const snapshots = new TaskStore(f.profile)
  await snapshots.initialize()
  await snapshots.save(owner, [legacy])

  const scope = { currentScope: () => owner }
  const previews = new DocumentPreviewStore(f.profile, new WorkPlanStore(f.profile), new ArrangementCheckpointStore(f.profile))
  let readTask = async () => ({ ...legacy, workType: { state: 'resolved', kind: 'conversation' } as const })
  const store = new ResultFileStore(f.profile, previews, () => readTask())
  const createFiles = (archive: ResultArchiveService) => new ResultFileService({ scope, archive, store, reveal: path => { f.reveal.push(path) } })
  const finishedAt = Date.now()
  const files = createFiles(f.archive)
  const ref = (index: number) => ({ taskId: task.id, fileId: `${task.id}-file-${index}` })
  for (const index of [2, 3]) {
    const path = legacy.files[index]!
    await files.queueArchive(owner, ref(index), task.title, finishedAt, startedAt, () => describeConversationResult(workspace, path, startedAt))
    await files.saveQueuedArchive(owner, ref(index))
    assert.ok((await f.store.entry(owner, task.id, `file:${ref(index).fileId}`))?.target)
  }

  const restarted = await openTasks()
  readTask = async () => ({ ...(await restarted.getTask(task.id))!, workType: { state: 'resolved', kind: 'conversation' } })
  const archive = new ResultArchiveService(new ResultArchiveStore(f.profile), scope, () => f.temp, () => 1)
  const restartedFiles = createFiles(archive)
  assert.equal((await readTask()).fileSaveIntents, undefined, 'the legacy snapshot has only a separate archive ledger')
  for (const [index, expected] of [[2, 'middle.md'], [3, 'last.md']] as const) {
    assert.equal((await store.actionFile(owner, ref(index))).name, expected)
    assert.equal((await previews.readConversation(owner, await readTask(), ref(index).fileId))?.bytes.toString(), expected)
    assert.deepEqual(await restartedFiles.archiveStatus(ref(index)), { state: 'saved' })
    await restartedFiles.reveal(ref(index))
    assert.equal(await readFile(f.reveal.at(-1)!, 'utf8'), expected)
  }
  const described = await describeConversationResult(workspace, 'last.md', startedAt)
  assert.ok(described)
  await restarted.addTaskFile(task.id, 'last.md', async (_task, _path, index) => {
    assert.equal(index, 3)
    return { ...described, title: task.title, when: finishedAt, startedAt }
  })
  assert.deepEqual((await store.saveIntents(owner, task.id)).map(item => item.file), [ref(3)])
  assert.deepEqual(await store.saveIntents(owner, task.id, ref(4)), [])
  await restarted.addTaskFile(task.id, 'new.md')
  assert.deepEqual((await (await openTasks()).getTask(task.id))?.files, [...legacy.files, 'new.md'])
})

test('an ENOSPC before the first ledger write is recovered from the committed task snapshot after restart', async t => {
  const f = await fixture(t)
  const openTasks = async () => {
    const manager = new TaskManager(f.profile)
    await manager.initialize()
    await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
    return manager
  }
  const scope = { currentScope: () => owner }
  const createFiles = (tasks: TaskManager, archive: ResultArchiveService) => new ResultFileService({
    scope, archive, reveal: path => { f.reveal.push(path) },
    store: new ResultFileStore(f.profile, new DocumentPreviewStore(f.profile, new WorkPlanStore(f.profile), new ArrangementCheckpointStore(f.profile)),
      async taskId => ({ ...(await tasks.getTask(taskId))!, workType: { state: 'resolved', kind: 'conversation' } })),
  })
  const tasks = await openTasks()
  const task = await tasks.createTask('report', 'generate a report')
  const files = createFiles(tasks, f.archive)
  const source = join(task.workDir!, 'report.md')
  await f.archive.configure(async () => f.root)
  const startedAt = Date.now()
  await mkdir(task.workDir!, { recursive: true })
  await writeFile(source, 'original')
  const finishedAt = Date.now(), file = { taskId: task.id, fileId: `${task.id}-file-0` }
  const fail = t.mock.method(f.store, 'enqueue', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) })
  await tasks.addTaskFile(task.id, 'report.md', (_task, path) => files.queueArchive(owner, file, task.title, finishedAt, startedAt,
    () => describeConversationResult(task.workDir!, path, startedAt)))
  assert.deepEqual((await tasks.getTask(task.id))?.files, ['report.md'])
  assert.equal(await f.store.entry(owner, task.id, `file:${file.fileId}`), undefined)
  assert.deepEqual(await files.archiveStatus(file), { state: 'failed', message: unknownFailure })
  assert.equal(await readFile(source, 'utf8'), 'original')
  fail.mock.restore()
  const nextRoot = join(f.temp, 'next')
  await mkdir(nextRoot)
  await f.archive.configure(async () => nextRoot)
  const restarted = createFiles(await openTasks(), new ResultArchiveService(new ResultArchiveStore(f.profile), scope, () => f.temp, () => 1))
  await restarted.resumeArchives(owner, [task.id], new AbortController().signal)
  await restarted.resumeArchives(owner, [task.id], new AbortController().signal)
  assert.deepEqual(await restarted.archiveStatus(file), { state: 'saved' })
  await restarted.reveal(file)
  const copy = f.reveal.at(-1)!
  assert.equal(dirname(dirname(dirname(copy))), f.root)
  assert.equal(basename(dirname(dirname(copy))), localArchiveDay(finishedAt))
  assert.deepEqual(await readdir(dirname(copy)), ['report.md'])
  assert.equal(await readFile(copy, 'utf8'), 'original')
  assert.deepEqual(await readdir(nextRoot), [])
})

test('a committed video can retry a failed registration without generating or replacing the original', async t => {
  const f = await fixture(t)
  const file = { taskId: 'task-1', jobId: 'video', outputId: 'out' }
  await f.archive.configure(async () => f.root)
  const now = Date.now()
  const fail = t.mock.method(f.store, 'enqueue', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) })
  const intent = await f.queue(file, 'Video', now, now, 'first')
  assert.ok(intent)
  f.committed.push({ file, intent, subscriptionId: 'first' })
  await f.files.saveQueuedArchive(owner, file)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'failed', message: unknownFailure })
  await assert.rejects(f.files.retryArchive(file), { code: 'INVALID_STATE', message: unknownFailure })
  f.switchAccount('other')
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'none' })
  f.switchAccount(owner.memberId)
  f.changeEmployee()
  const nextRoot = join(f.temp, 'next')
  await mkdir(nextRoot)
  await f.archive.configure(async () => nextRoot)
  fail.mock.restore()
  await f.files.retryArchive(file)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'saved' })
  await f.files.reveal(file)
  assert.equal(dirname(dirname(dirname(f.reveal.at(-1)!))), nextRoot)
  assert.deepEqual(await readFile(f.reveal.at(-1)!), await readFile(f.original))
})

test('destination errors are safe to show and retryable even if the ledger cannot record them', async t => {
  const f = await fixture(t)
  const file = { taskId: 'task-1', fileId: 'report' }
  await f.archive.configure(async () => f.root)
  const now = Date.now()
  await f.queue(file, 'Report', now, now)
  const originalOpen = fs.open
  let code = 'ENOSPC'
  const open = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (typeof args[0] === 'string' && args[0].startsWith(f.root) && args[0].endsWith('.part')) {
      throw Object.assign(new Error('private filesystem details'), { code })
    }
    return originalOpen(...args)
  })
  syncBuiltinESMExports()
  const fail = t.mock.method(f.store, 'fail', async () => { throw new Error('could not record failure') })
  try {
    await f.files.saveQueuedArchive(owner, file)
    assert.deepEqual(await f.files.archiveStatus(file), { state: 'failed', message: spaceFailure })
    await assert.rejects(f.files.retryArchive(file), { code: 'INVALID_STATE', message: spaceFailure })
    fail.mock.restore()
    code = 'EACCES'
    const permissionFailure = '原文件已生成。无法写入保存位置，请检查文件夹权限或换个文件夹后重试。'
    await assert.rejects(f.files.retryArchive(file), { code: 'INVALID_STATE', message: permissionFailure })
    assert.deepEqual(await f.restart().archiveStatus(file), { state: 'failed', message: permissionFailure })
    code = 'EIO'
    await assert.rejects(f.files.retryArchive(file), { code: 'INVALID_STATE', message: unknownFailure })
    assert.deepEqual(await f.restart().archiveStatus(file), { state: 'failed', message: unknownFailure })
  } finally {
    open.mock.restore()
    syncBuiltinESMExports()
  }
  await f.files.retryArchive(file)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'saved' })
})

test('a disconnected previous save requires current, file-specific confirmation before switching roots', async t => {
  const f = await fixture(t)
  const file = { taskId: 'task-1', fileId: 'report' }, identity = 'file:report'
  await f.archive.configure(async () => f.root)
  const date = Date.now()
  await f.queue(file, 'Report', date, date)
  const failLink = t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('link interrupted'), { code: 'EIO' }) })
  syncBuiltinESMExports()
  try { await f.files.saveQueuedArchive(owner, file) }
  finally { failLink.mock.restore(); syncBuiltinESMExports() }
  const entry = (await f.store.entry(owner, file.taskId, identity))!
  assert.equal(entry.stage?.candidate, entry.name)
  const offline = join(f.temp, 'offline'), next = join(f.temp, 'next'), last = join(f.temp, 'last')
  await rename(f.root, offline)
  const restarted = f.restart()
  await restarted.resumeArchives(owner, [file.taskId], new AbortController().signal)
  assert.deepEqual(await restarted.archiveStatus(file), { state: 'failed', message: reconnectFailure })
  await mkdir(next)
  await f.archive.configure(async () => next)
  await assert.rejects(restarted.retryArchive(file), { code: 'INVALID_STATE', message: reconnectFailure })
  assert.deepEqual(await readdir(next), [])
  const status = await restarted.archiveStatus(file)
  assert.equal(status.state, 'failed')
  assert.ok(status.alternateConfirmation)
  assert.deepEqual((await f.store.entry(owner, file.taskId, identity))?.stage, entry.stage)
  await mkdir(last)
  await f.archive.configure(async () => last)
  await assert.rejects(restarted.retryArchive(file, status.alternateConfirmation), { code: 'INVALID_STATE', message: /重新确认/ })
  assert.deepEqual(await readdir(last), [])
  const current = await restarted.archiveStatus(file)
  assert.equal(current.state, 'failed')
  assert.ok(current.alternateConfirmation)
  const occupied = join(last, entry.day, entry.folder)
  await mkdir(occupied, { recursive: true })
  await writeFile(join(occupied, entry.name), '已有文件')
  f.switchAccount('other')
  await assert.rejects(restarted.retryArchive(file, current.alternateConfirmation), { code: 'INVALID_STATE' })
  f.switchAccount(owner.memberId)
  await restarted.retryArchive(file, current.alternateConfirmation)
  assert.deepEqual(await restarted.archiveStatus(file), { state: 'saved' })
  await restarted.reveal(file)
  assert.equal(f.reveal.at(-1), join(last, entry.day, `${entry.folder}（2）`, entry.name))
  assert.equal(await readFile(f.reveal.at(-1)!, 'utf8'), '原件')
  assert.equal(await readFile(join(occupied, entry.name), 'utf8'), '已有文件')
  assert.equal(await readFile(f.original, 'utf8'), '原件')
  assert.deepEqual(await readdir(join(offline, entry.day, entry.folder)), [entry.stage!.part])
})

for (const interrupted of ['copying', 'published'] as const) {
  test(`a process exit while ${interrupted} recovers to one complete file`, async t => {
    const f = await fixture(t)
    const file = { taskId: 'task-1', fileId: 'report' }
    const bytes = Buffer.alloc(2 * 1024 * 1024, 42)
    await writeFile(f.original, bytes)
    await f.archive.configure(async () => f.root)
    const now = Date.now()
    await f.queue(file, '报告', now, now)
    const entry = (await f.store.entry(owner, file.taskId, 'file:report'))!
    const directory = join(entry.root, entry.day, entry.folder)
    const child = `
      const { ResultArchiveStore } = require('./electron/data/result-archive-store.ts');
      const { existsSync, readdirSync, statSync } = require('node:fs');
      const { join } = require('node:path');
      const [profile, owner, entry, original, directory, interrupted] = JSON.parse(process.argv[1]);
      const store = new ResultArchiveStore(profile);
      store.copy(owner, 'task-1', 'file:report', { entry, source: { path: original } }, () => {
        if (!existsSync(directory)) return;
        if (interrupted === 'published' && existsSync(join(directory, entry.name))) process.exit(37);
        if (interrupted === 'copying' && readdirSync(directory).some(name => name.endsWith('.part') && statSync(join(directory, name)).size > 0)) process.exit(37);
      }).catch(error => { process.stderr.write(String(error)); process.exit(38); });
    `
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', '-e', child,
      JSON.stringify([f.profile, owner, entry, f.original, directory, interrupted])], { timeout: 20_000 }), { code: 37 })
    const interruptedNames = await readdir(directory)
    assert.equal(interruptedNames.includes(entry.name), interrupted === 'published')
    assert.equal(interruptedNames.some(name => name.endsWith('.part')), true)
    const restarted = f.restart()
    if (interrupted === 'published') {
      f.hideOriginal()
      const offline = join(f.temp, 'offline'), next = join(f.temp, 'next')
      await rename(f.root, offline)
      await mkdir(next)
      await f.archive.configure(async () => next)
      await restarted.resumeArchives(owner, [file.taskId], new AbortController().signal)
      await assert.rejects(restarted.retryArchive(file), { code: 'INVALID_STATE', message: reconnectFailure })
      const status = await restarted.archiveStatus(file)
      assert.equal(status.state, 'failed')
      assert.ok(status.alternateConfirmation)
      await rename(offline, f.root)
      // If the original location reconnects while the dialog is open, use the existing copy.
      await restarted.retryArchive(file, status.alternateConfirmation)
      assert.deepEqual(await readdir(next), [])
    }
    await restarted.resumeArchives(owner, [file.taskId], new AbortController().signal)
    assert.deepEqual(await restarted.archiveStatus(file), { state: 'saved' })
    const recovered = await f.store.entry(owner, file.taskId, 'file:report')
    assert.ok(recovered?.targetIdentity)
    assert.equal(recovered.stage, undefined)
    assert.deepEqual(await readdir(directory), [entry.name])
    assert.deepEqual(await readFile(join(directory, entry.name)), bytes)
  })
}

test('old video can retry after switching employee, and a deleted copy can be restored', async t => {
  const f = await fixture(t)
  const file = { taskId: 'task-1', jobId: 'video', outputId: 'out' }
  await f.archive.configure(async () => f.root)
  await rename(f.root, join(f.temp, 'offline'))
  const now = Date.now()
  await f.save(file, '视频', now, now, 'first')
  f.changeEmployee()
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'failed', message: locationFailure })
  const next = join(f.temp, 'new-results')
  await mkdir(next)
  await f.archive.configure(async () => next)
  await f.files.retryArchive(file)
  await f.files.reveal(file)
  const copy = f.reveal.at(-1)!
  await rm(copy)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'missing' })
  await f.files.retryArchive(file)
  assert.deepEqual(await f.files.archiveStatus(file), { state: 'saved' })
  assert.equal(await readFile(copy, 'utf8'), '原件')
})
