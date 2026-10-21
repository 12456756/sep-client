/* global window, document */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright-core'
import electron from 'electron'
import { startVideoMockFixture } from '../out-video-mock/main/fixture.mjs'

const root = resolve('.'), output = resolve(process.env.SEP_VIDEO_OUTPUT ?? 'output/playwright/video-mock-2026-10-19')
await mkdir(output, { recursive: true })
const profile = await realpath(await mkdtemp(join(tmpdir(), 'sep-electron-video-mock-')))
const fixture = JSON.parse(await readFile(join(root, 'src/shared/fixtures/media-video-v1.json'), 'utf8'))
const reference = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ2FIBAAJEAU2Vdyv6AAAAAElFTkSuQmCC', 'base64')
const referencePath = join(profile, 'reference.png')
await writeFile(referencePath, reference)
const server = await startVideoMockFixture()
const evidence = { explicitMock: true, syntheticScope: true, realModels: false, realBilling: false, profile, phases: [], main: [], errors: [] }
let application, page
async function control(fn, arg) { return application.evaluate(fn, arg) }
async function launch() {
  const env = { ...process.env, SEP_ELECTRON_VIDEO_MOCK: 'true', SEP_ELECTRON_VIDEO_PROFILE: profile, SEP_ELECTRON_VIDEO_URL: server.baseUrl, SEP_PLAYWRIGHT_MCP: '0' }
  delete env.SEP_MCP_CONFIG; delete env.ELECTRON_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: electron, cwd: root, args: [join(root, 'out-video-mock/main/index.mjs')], env, timeout: 30_000 })
  application.process().stderr.on('data', chunk => { evidence.errors.push(String(chunk).slice(0, 2000)) })
  page = await application.firstWindow()
  page.on('pageerror', error => evidence.errors.push(error.message))
  await page.getByRole('region', { name: '视频创作与成果' }).waitFor({ timeout: 20_000 })
  await control(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, referencePath)
}
async function close() {
  if (!application) return
  evidence.main.push(await control(() => globalThis.__sepVideoTest.evidence()))
  evidence.jobs = await control(() => globalThis.__sepVideoTest.jobs())
  await application.close(); application = undefined
}
async function ipc(method, input) {
  const result = await page.evaluate(([method, input]) => window.electronAPI[method](input), [method, input])
  assert.equal(result.success, true, `${method}: ${JSON.stringify(result.error)}`)
  return result
}
async function waitJob(predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const jobs = await control(() => globalThis.__sepVideoTest.jobs())
    const job = jobs.find(predicate)
    if (job) return job
    await page.waitForTimeout(150)
  }
  throw new Error('Timed out waiting for mock video job')
}
async function approve() { await page.getByRole('button', { name: '允许工具执行', exact: true }).click({ timeout: 20_000 }) }
async function form() {
  if (!await page.getByLabel('视频参考图 1', { exact: true }).count()) {
    const importer = page.getByRole('button', { name: /从系统选择视频参考图/ })
    await importer.waitFor({ state: 'visible', timeout: 20_000 })
    await importer.click()
  }
  await page.getByLabel('视频参考图 1', { exact: true }).check()
  await page.getByLabel('视频创作需求', { exact: true }).fill('商品缓慢旋转，固定镜头；仅 mock，不扣费。')
}
async function submit() {
  await form()
  await page.getByRole('button', { name: '提交视频生成', exact: true }).click()
  await approve(); await approve()
}
function article(job) { return page.getByRole('article', { name: `视频任务 ${job.jobId}`, exact: true }) }
async function waitArticle(job, text) { await article(job).getByText(text, { exact: true }).waitFor({ timeout: 20_000 }) }
async function verifyParameterForms() {
  const image = page.getByRole('region', { name: '图片参数联动验收', exact: true })
  const value = async label => image.getByLabel(label, { exact: true }).inputValue()
  assert.equal(await value('图片模型'), 'image-synthetic-b')
  assert.equal(await value('图片尺寸'), '1536x1024')
  assert.equal(await value('图片比例'), '3:2')
  assert.equal(await value('图片质量'), 'high')
  await image.getByLabel('图片比例', { exact: true }).selectOption('2:3')
  assert.equal(await value('图片尺寸'), '1024x1536')
  await image.getByLabel('图片尺寸', { exact: true }).selectOption('1024x1024')
  assert.equal(await value('图片比例'), '1:1')
  await image.getByLabel('图片质量', { exact: true }).selectOption('low')
  await image.getByLabel('创作需求', { exact: true }).fill('仅验证本地参数，不生成')
  await image.getByRole('button', { name: '提交图片生成', exact: true }).click()
  const submitted = JSON.parse(await image.getByTestId('image-parameters-submit').textContent())
  assert.equal(submitted.parameters.quality, 'low')
  assert.equal(submitted.parameters.size, '1024x1024')
  await image.getByRole('button', { name: '切换参数偏好身份' }).click()
  assert.equal(await value('图片质量'), 'high')
  await image.getByRole('button', { name: '切换参数偏好身份' }).click()
  assert.equal(await value('图片质量'), 'low')
  await image.getByRole('button', { name: '收紧图片规格' }).click()
  assert.equal(await value('图片质量'), 'medium')
  assert.equal(await value('图片尺寸'), '1024x1024')
  assert.equal(await image.getByLabel('图片质量', { exact: true }).isDisabled(), true)
  await image.getByRole('button', { name: '移除默认图片模型' }).click()
  assert.equal(await value('图片模型'), 'image-synthetic-a')
  await image.getByRole('button', { name: '恢复默认图片模型' }).click()
  await image.getByRole('button', { name: '恢复图片规格' }).click()
  await page.getByRole('button', { name: '展开固定音轨验收' }).click()
  const video = page.getByRole('region', { name: '固定音轨参数验收', exact: true })
  const audio = video.getByLabel('视频音频', { exact: true })
  assert.equal(await audio.inputValue(), 'true')
  assert.equal(await audio.isDisabled(), true)
  assert.equal(await audio.locator('option').count(), 1)
  for (const label of ['视频时长', '视频比例', '视频分辨率', '视频帧率', '视频输出格式']) {
    assert.equal(await video.getByLabel(label, { exact: true }).isDisabled(), true)
  }
  await video.getByLabel('视频创作需求', { exact: true }).fill('仅本地固定音轨验收')
  await video.getByRole('button', { name: '提交视频生成', exact: true }).click()
  const fixed = JSON.parse(await video.getByTestId('video-fixed-audio-submit').textContent())
  assert.equal(fixed.parameters.audio, true)
  assert.equal(fixed.parameters.durationSeconds, 4)
  await page.screenshot({ path: join(output, '05-media-parameters-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No narrow-screen horizontal overflow')
  await page.screenshot({ path: join(output, '06-media-parameters-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1180, height: 900 })
  await page.getByRole('button', { name: '收起固定音轨验收' }).click()
  evidence.phases.push({ name: 'quality-size-ratio-identity-capability-fixed-audio', submitted, fixed })
}
try {
  server.state.phase = 'initial'
  await launch(); await form()
  await page.screenshot({ path: join(output, '01-video-form.png'), fullPage: true })
  await page.getByRole('button', { name: '提交视频生成', exact: true }).click()
  await page.getByRole('button', { name: '拒绝工具执行', exact: true }).click()
  await page.getByRole('button', { name: '提交视频生成', exact: true }).waitFor({ state: 'visible' })
  assert.equal(server.state.counts.submit, 0); assert.equal(server.state.counts.references, 0)
  evidence.phases.push({ name: 'deny-reference-approval', submitted: 0, uploaded: 0 })

  // Actual Pi SDK → host tools → existing UI approvals; no model network.
  const refs = (await ipc('getVideoReferences', 'video-task-a')).data
  const input = { profileId: 'mock-video-from-image', operation: 'image-to-video', localAssetIds: [refs[0].localAssetId], creativeBrief: 'Pi 商品视频 mock', parameters: fixture.quoteRequest.parameters }
  await control((_, input) => globalThis.__sepVideoTest.startPi(input), input)
  await approve(); await approve()
  const first = await waitJob(job => job.saveStatus === 'SAVED')
  await page.waitForFunction(async () => (await window.electronAPI.getTaskVideo('video-task-a')).data?.jobs.some(job => job.saveStatus === 'SAVED'))
  await waitArticle(first, '已保存到本地')
  const piDeadline = Date.now() + 30_000
  let pi
  do { pi = await control(() => globalThis.__sepVideoTest.evidence()); if (pi.piStatus === 'complete' || pi.piStatus === 'failed') break; await page.waitForTimeout(100) } while (Date.now() < piDeadline)
  assert.equal(pi.piStatus, 'complete'); assert.equal(pi.piModel.generationCount, 1); assert.equal(pi.piModel.steps.video_get_job, 1)
  assert.equal(server.state.counts.submit, 1)
  await article(first).getByRole('button', { name: '预览视频成果 1', exact: true }).click()
  await page.getByRole('dialog', { name: '本地视频预览' }).waitFor()
  await page.waitForFunction(() => { const video = document.querySelector('video'); return video?.readyState >= 2 && video.videoWidth === 720 && video.videoHeight === 1280 })
  const decoding = await page.locator('video').evaluate(async video => { await video.play(); return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, paused: video.paused } })
  assert.equal(decoding.paused, false); assert.equal(decoding.duration, 5)
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2)
  decoding.pixel = await page.locator('video').evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data]
  })
  assert.equal(decoding.pixel[3], 255)
  assert.ok(decoding.pixel.slice(0, 3).some(value => value > 10), 'Decoded fixture frame must not be blank/black')
  await page.screenshot({ path: join(output, '02-video-preview.png') })
  const exported = join(output, 'exported-mock.mp4')
  await control(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, exported)
  await page.getByRole('button', { name: '导出视频', exact: true }).click()
  await page.getByText('视频已导出', { exact: true }).first().waitFor()
  assert.equal(createHash('sha256').update(await readFile(exported)).digest('hex'), fixture.mediaFixture.sha256)
  await page.getByRole('button', { name: '关闭视频预览' }).click()
  evidence.phases.push({ name: 'actual-pi-approval-playback-export', jobId: first.jobId, pi, decoding, sha256: fixture.mediaFixture.sha256 })

  // Restart actual Electron while an original receipt is queued; parent fixture lives on.
  server.state.holdQueries = true; server.state.phase = 'before-restart'
  await submit()
  const queued = await waitJob(job => job.jobId !== first.jobId && job.submission === 'RECEIPTED')
  const submissions = server.state.counts.submit, quotes = server.state.counts.quotes
  await close()
  server.state.holdQueries = false; server.state.phase = 'after-restart'
  await launch()
  const restored = await waitJob(job => job.jobId === queued.jobId && job.saveStatus === 'SAVED')
  assert.equal(restored.receipt.receiptId, queued.receipt.receiptId)
  assert.equal(server.state.counts.submit, submissions); assert.equal(server.state.counts.quotes, quotes)
  await waitArticle(restored, '已保存到本地')
  await page.screenshot({ path: join(output, '03-restored-jobs.png'), fullPage: true })
  evidence.phases.push({ name: 'actual-process-restart-original-receipt', jobId: restored.jobId, submit: submissions, quotes })

  // Grant revocation pauses durably and granting it again requires explicit UI resume.
  server.state.holdQueries = true; server.state.phase = 'before-revoke'
  await submit()
  const revocable = await waitJob(job => ![first.jobId, queued.jobId].includes(job.jobId) && job.submission === 'RECEIPTED')
  await control(() => globalThis.__sepVideoTest.setGranted(false))
  await waitJob(job => job.jobId === revocable.jobId && job.trackingStatus === 'AUTH_REQUIRED')
  const pausedCount = server.state.counts.getReceipt
  await page.waitForTimeout(700); assert.equal(server.state.counts.getReceipt, pausedCount)
  await control(() => globalThis.__sepVideoTest.setGranted(true))
  server.state.holdQueries = false; server.state.phase = 'grant-restored'
  await waitArticle(revocable, '需要恢复认证')
  await page.waitForTimeout(700); assert.equal(server.state.counts.getReceipt, pausedCount)
  await article(revocable).getByRole('button', { name: '恢复跟踪', exact: true }).click()
  await waitJob(job => job.jobId === revocable.jobId && job.saveStatus === 'SAVED')
  assert.equal(server.state.counts.submit, submissions + 1)
  evidence.phases.push({ name: 'revoked-pause-explicit-ui-resume', jobId: revocable.jobId, pausedQueries: pausedCount })

  // Corrupt download cannot publish; explicit retry uses the same output/receipt.
  server.state.corruptDownload = true; server.state.phase = 'corrupt-download'
  await submit()
  const corrupt = await waitJob(job => job.saveStatus === 'SAVE_FAILED')
  const beforeRetry = server.state.counts.submit
  await waitArticle(corrupt, '本地保存失败')
  assert.equal((await ipc('getTaskVideo', 'video-task-a')).data.jobs.find(job => job.jobId === corrupt.jobId).savedOutputIds.length, 0)
  server.state.corruptDownload = false; server.state.phase = 'retry-download'
  await article(corrupt).getByRole('button', { name: '重新保存', exact: true }).click()
  const retried = await waitJob(job => job.jobId === corrupt.jobId && job.saveStatus === 'SAVED')
  assert.equal(retried.receipt.receiptId, corrupt.receipt.receiptId); assert.equal(server.state.counts.submit, beforeRetry)
  evidence.phases.push({ name: 'corrupt-download-explicit-retry', jobId: corrupt.jobId, receiptUnchanged: true })

  // Partial receipt: first result expired, second saved. Keep the valid output usable.
  server.state.scenario = 'partial-expired'; server.state.phase = 'partial-save'
  await submit()
  const partial = await waitJob(job => job.receipt?.status === 'PARTIAL_SUCCEEDED' && job.saveStatus === 'SAVE_FAILED')
  const partialView = (await ipc('getTaskVideo', 'video-task-a')).data.jobs.find(job => job.jobId === partial.jobId)
  assert.deepEqual(partialView.savedOutputIds, [partial.receipt.outputs[1].outputId])
  const partialArticle = article(partial)
  assert.equal(await partialArticle.getByRole('button', { name: '预览视频成果 1', exact: true }).count(), 0)
  await partialArticle.getByRole('button', { name: '预览视频成果 2', exact: true }).click()
  await page.getByRole('dialog', { name: '本地视频预览' }).waitFor()
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
  await page.getByRole('button', { name: '关闭视频预览' }).click()
  evidence.phases.push({ name: 'partial-output-local-preview', jobId: partial.jobId, savedOutputId: partialView.savedOutputIds[0] })

  server.state.scenario = 'success'; server.state.holdQueries = true; server.state.phase = 'before-disconnect'
  const previousIds = new Set((await control(() => globalThis.__sepVideoTest.jobs())).map(job => job.jobId))
  await submit()
  const interrupted = await waitJob(job => !previousIds.has(job.jobId) && job.submission === 'RECEIPTED')
  const beforeReconnect = server.state.counts.submit
  await control(() => globalThis.__sepVideoTest.setDisconnected(true))
  await waitJob(job => job.jobId === interrupted.jobId && job.trackingStatus === 'INTERRUPTED')
  server.state.holdQueries = false; server.state.phase = 'after-reconnect'
  await control(() => globalThis.__sepVideoTest.setDisconnected(false))
  await control(() => globalThis.__sepVideoTest.track())
  const reconnected = await waitJob(job => job.jobId === interrupted.jobId && job.saveStatus === 'SAVED')
  assert.equal(reconnected.receipt.receiptId, interrupted.receipt.receiptId)
  assert.equal(server.state.counts.submit, beforeReconnect)
  evidence.phases.push({ name: 'disconnect-reconnect-original-task', jobId: interrupted.jobId, noResubmit: true })

  await verifyParameterForms()
  const beforePreferenceRestart = { submit: server.state.counts.submit, quotes: server.state.counts.quotes }
  await close()
  await launch()
  const restoredForm = page.getByRole('region', { name: '图片参数联动验收', exact: true })
  assert.equal(await restoredForm.getByLabel('图片模型', { exact: true }).inputValue(), 'image-synthetic-b')
  assert.equal(await restoredForm.getByLabel('图片质量', { exact: true }).inputValue(), 'low')
  assert.equal(await restoredForm.getByLabel('图片尺寸', { exact: true }).inputValue(), '1024x1024')
  assert.equal(server.state.counts.submit, beforePreferenceRestart.submit)
  assert.equal(server.state.counts.quotes, beforePreferenceRestart.quotes)
  evidence.phases.push({ name: 'parameter-preferences-process-restart', noQuoteOrSubmit: true })
  // Saved bytes belong to the local member, not the current employee grant.
  await control(() => { globalThis.__sepVideoTest.setDisconnected(true); globalThis.__sepVideoTest.setGranted(false) })
  const requestsBeforeLocal = await control(() => globalThis.__sepVideoTest.evidence().requests)
  const offlineView = (await ipc('getTaskVideo', 'video-task-a')).data
  assert.ok(offlineView.jobs.find(job => job.jobId === first.jobId).savedOutputIds.length)
  await article(first).getByRole('button', { name: '预览视频成果 1', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
  const offlineExport = join(output, 'offline-revoked-export.mp4')
  await control(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, offlineExport)
  await page.getByRole('button', { name: '导出视频', exact: true }).click()
  await page.getByText('视频已导出', { exact: true }).first().waitFor()
  assert.equal(createHash('sha256').update(await readFile(offlineExport)).digest('hex'), fixture.mediaFixture.sha256)
  assert.deepEqual(await control(() => globalThis.__sepVideoTest.evidence().requests), requestsBeforeLocal)
  await page.getByRole('button', { name: '关闭视频预览' }).click()
  evidence.phases.push({ name: 'offline-revoked-local-preview-export', noNetwork: true })
  await page.screenshot({ path: join(output, '04-final-jobs.png'), fullPage: true })
  const main = await control(() => globalThis.__sepVideoTest.evidence())
  assert.equal(main.blocked, 0); assert.equal(main.rendererBlocked, 0)
  evidence.completed = true
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await close().catch(error => { evidence.closeError = error.message })
  evidence.server = server.evidence()
  await server.close()
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
}
console.log(`Video mock Electron acceptance passed: ${output}`)
