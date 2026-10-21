/* global window */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve, relative, sep } from 'node:path'
import { _electron } from 'playwright-core'
import electron from 'electron'

// Sources contain tokens; only whitelist nonsecret fields into the private GUI fixture.
const sourceRoot = await realpath(process.env.SEP_VIDEO_REAL_RECOVERY_SOURCE ?? '/private/tmp/sep-video-closure-jpajkks4')
assert.ok(sourceRoot.startsWith('/private/tmp/sep-video-closure-'))
const output = resolve(process.env.SEP_VIDEO_REAL_RECOVERY_OUTPUT ??
  '/Users/yao/LLM/SEP/outputs/video-v2-relay-live-2026-10-20/closure-fixed/electron-gui')
await mkdir(output, { recursive: true, mode: 0o700 })
const outputRoot = await realpath(output)
assert.equal((await lstat(outputRoot)).isDirectory(), true)
const profile = await realpath(await mkdtemp('/private/tmp/sep-electron-video-real-recovery-'))
const fixturePath = join(profile, 'adopted-originals.json')
const evidence = { version: 1, source: 'two-real-completed-original-video-jobs', provesPiFlow: false,
  provesProductionAuthorization: false, authorization: 'captured-real-runtime-offline-test-seam',
  nativePlaybackObserved: false, previewVerification: 'OS-openPath-success-not-player-frame-observation',
  profile, phase: 'adoption', passed: false, phases: [] }
let application, page
async function regularTree(path) {
  const stat = await lstat(path)
  assert.equal(stat.isSymbolicLink(), false)
  assert.ok(stat.isDirectory() || stat.isFile() && stat.nlink === 1)
  if (stat.isDirectory()) for (const name of await readdir(path)) await regularTree(join(path, name))
}
async function treeDigest(path) {
  const hash = createHash('sha256')
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), stat = await lstat(file)
      if (stat.isDirectory()) await visit(file)
      else { assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1); hash.update(relative(path, file)); hash.update(await readFile(file)) }
    }
  }
  await visit(path)
  return hash.digest('hex')
}
async function readPrivateJson(path) {
  const stat = await lstat(path)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 1024 * 1024)
  assert.equal(stat.mode & 0o077, 0)
  assert.equal(await realpath(path), path)
  return JSON.parse(await readFile(path, 'utf8'))
}
const inspect = () => application.evaluate(() => globalThis.__sepVideoRealRecovery.summary())
async function close(phase) {
  const done = application.waitForEvent('close', { timeout: 15_000 })
  await application.evaluate(() => globalThis.__sepVideoRealRecovery.shutdown())
  await done
  application = undefined
  const shutdown = JSON.parse(await readFile(join(profile, `shutdown-${phase}.json`), 'utf8'))
  assert.equal(shutdown.completed, true)
  return shutdown
}
const fixture = { version: 1, tasks: [] }
const sourceDigests = []
try {
  for (const kind of ['text', 'image']) {
    const directory = join(sourceRoot, kind)
    const config = await readPrivateJson(join(directory, 'run.json'))
    const runtime = await readPrivateJson(join(directory, 'runtime-video.json'))
    assert.equal(await realpath(config.outputRoot), join(directory, 'client'))
    const scope = { enterpriseId: config.enterpriseId, memberId: config.memberId, subscriptionId: config.subscriptionId }
    const enc = value => Buffer.from(value).toString('base64url')
    const ownerRelative = join('task-data', 'v3', enc(scope.enterpriseId), enc(scope.memberId))
    const source = join(config.outputRoot, ownerRelative)
    await regularTree(source)
    sourceDigests.push({ source, digest: await treeDigest(source) })
    const jobsDirectory = join(source, 'video', 'v1', enc(scope.subscriptionId), 'tasks', config.taskId, 'jobs')
    const names = await readdir(jobsDirectory)
    assert.equal(names.length, 1)
    const job = await readPrivateJson(join(jobsDirectory, names[0]))
    assert.equal(job.executionMode, 'real')
    assert.equal(job.saveStatus, 'SAVED', 'Wait for main runner; never manufacture saved status')
    assert.equal(job.receipt.status, 'SUCCEEDED')
    assert.equal(job.receipt.billingStatus, 'SETTLED')
    assert.equal(job.receipt.mock, false)
    assert.equal(job.taskId, config.taskId)
    assert.deepEqual(job.scope, scope)
    const target = join(profile, ownerRelative)
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false })
    fixture.tasks.push({ scope, taskId: config.taskId, job, runtime })
  }
  await writeFile(fixturePath, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' })
  let baseline
  for (const phase of ['initial', 'restart']) {
    evidence.phase = `launch-${phase}`
    const env = { ...process.env, SEP_VIDEO_REAL_RECOVERY_HARNESS: '1', SEP_VIDEO_REAL_RECOVERY_PROFILE: profile,
      SEP_VIDEO_REAL_RECOVERY_FIXTURE: fixturePath, SEP_VIDEO_REAL_RECOVERY_PHASE: phase,
      SEP_VIDEO_REAL_RECOVERY_OPEN_NATIVE: process.env.SEP_VIDEO_REAL_RECOVERY_OPEN_NATIVE ?? '1', SEP_PLAYWRIGHT_MCP: '0' }
    delete env.SEP_MCP_CONFIG; delete env.ELECTRON_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE
    application = await _electron.launch({ executablePath: electron,
      args: [resolve('out/video-real-recovery/main/index.mjs')], env, timeout: 30_000 })
    page = await application.firstWindow()
    await page.getByRole('heading', { name: '真实视频 · 原任务保存与恢复验收', exact: true }).waitFor({ timeout: 25_000 })
    await page.getByRole('region', { name: '视频成果', exact: true }).nth(1).waitFor({ timeout: 25_000 })
    const before = await inspect()
    assert.equal(before.identities.length, 2)
    if (baseline) assert.deepEqual(before.identities, baseline)
    else baseline = before.identities
    assert.equal(before.audit.networkRequestsSent, 0)
    const text = fixture.tasks[0]
    const prohibited = await page.evaluate(async input => {
      return [await window.electronAPI.importVideoReferences(input.taskId),
        await window.electronAPI.resumeVideoTracking({ taskId: input.taskId, jobId: input.jobId })]
    }, { taskId: text.taskId, jobId: text.job.jobId })
    assert.ok(prohibited.every(result => result.success === false && result.error?.code === 'PERMISSION_DENIED'))
    const deniedGenerate = await page.evaluate(async input => window.electronAPI.generateTaskVideo(input), {
      taskId: text.taskId, input: { profileId: text.job.request.profileId, operation: 'text-to-video', localAssetIds: [],
        creativeBrief: 'DENIED HARNESS TEST', parameters: text.job.request.parameters } })
    assert.equal(deniedGenerate.success, false)
    assert.equal(deniedGenerate.error?.code, 'PERMISSION_DENIED')
    for (const [index, item] of fixture.tasks.entries()) {
      evidence.phase = `${phase}-preview-export-${index + 1}`
      const job = item.job, outputInfo = job.receipt.outputs[0]
      const article = page.getByRole('article', { name: `视频任务 ${job.jobId}`, exact: true })
      await article.getByText('已保存到本地', { exact: true }).waitFor()
      await article.getByRole('button', { name: '预览视频成果 1', exact: true }).click()
      const modal = page.getByRole('dialog', { name: '本地视频预览', exact: true })
      await modal.waitFor()
      await modal.getByText('已在系统播放器打开', { exact: true }).waitFor()
      const afterPreview = await inspect()
      const native = afterPreview.audit.nativePreview.at(-1)
      assert.equal(native.jobId, job.jobId)
      assert.equal(native.outputId, outputInfo.outputId)
      assert.equal(native.sha256, outputInfo.sha256)
      if (env.SEP_VIDEO_REAL_RECOVERY_OPEN_NATIVE === '1') assert.equal(native.dispatched, true)
      const exportPath = join(outputRoot, `${phase}-${index === 0 ? 'text' : 'image'}.mp4`)
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, exportPath)
      await modal.getByRole('button', { name: '导出视频', exact: true }).click()
      await modal.getByText('视频已导出', { exact: true }).waitFor()
      const bytes = await readFile(exportPath)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      assert.equal(sha256, outputInfo.sha256)
      assert.equal(bytes.byteLength, outputInfo.byteLength)
      assert.ok(!relative(outputRoot, exportPath).startsWith(`..${sep}`))
      await page.screenshot({ path: join(outputRoot, `${phase}-${index + 1}-native-preview.png`), fullPage: true })
      await modal.getByRole('button', { name: '关闭视频预览', exact: true }).click()
    }
    await page.screenshot({ path: join(outputRoot, `${phase}-saved-jobs.png`), fullPage: true })
    const after = await inspect()
    assert.deepEqual(after.identities, baseline)
    assert.equal(after.audit.networkRequestsSent, 0)
    assert.equal(after.audit.forbiddenFetchAttempts, 0)
    assert.equal(after.audit.rendererDenied, 0)
    assert.equal(after.audit.approvals, 0)
    evidence.phases.push({ phase, ...after, screenshots: [`${phase}-saved-jobs.png`],
      prohibitedActionsDenied: ['generateTaskVideo', 'importVideoReferences', 'resumeVideoTracking'],
      exports: after.identities.map((identity, index) => ({ jobId: identity.jobId,
        path: `${phase}-${index === 0 ? 'text' : 'image'}.mp4`, ...identity.outputs[0] })) })
    const shutdown = await close(phase)
    assert.deepEqual(shutdown.identities, baseline)
  }
  for (const item of sourceDigests) assert.equal(await treeDigest(item.source), item.digest)
  // Whole source subtree digests prove adoption and GUI did not alter the source stores.
  evidence.sourcePreserved = true
  evidence.passed = true
  evidence.phase = 'complete'
} catch {
  evidence.failure = 'ISOLATED_VIDEO_REAL_RECOVERY_FAILED'
  if (page && !page.isClosed()) await page.screenshot({ path: join(outputRoot, 'failure.png'), fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  if (application) await application.close().catch(() => {})
  await writeFile(join(outputRoot, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  process.stdout.write(`${evidence.passed ? 'PASS' : 'FAIL'} isolated Electron original-video recovery: ${outputRoot}\n`)
}
