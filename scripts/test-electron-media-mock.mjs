/* global window */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright-core'
import electron from 'electron'

const output = resolve(process.env.SEP_ELECTRON_MOCK_OUTPUT ?? 'outputs/electron-media-mock-2026-10-14')
await mkdir(output, { recursive: true })
const profile = await realpath(await mkdtemp(join(tmpdir(), 'sep-electron-media-mock-')))
const evidence = { explicitMock: true, realLogin: false, profile, phases: [], requests: [] }
evidence.lifecycle = []
let application
let page
const control = (fn, arg) => application.evaluate(fn, arg)
async function launch() {
  evidence.step = 'launch'
  application = await _electron.launch({ executablePath: electron,
    args: [resolve('out/main/media-mock.js')], env: { ...process.env,
      SEP_ELECTRON_MEDIA_MOCK: 'true', SEP_ELECTRON_MOCK_PROFILE: profile,
      SEP_BASE_URL: process.env.SEP_BASE_URL ?? 'http://127.0.0.1:3001/api',
      SEP_GATEWAY_URL: 'http://127.0.0.1:1/disabled-model-gateway',
      SEP_ELECTRON_MOCK_MEDIA_URL: process.env.SEP_ELECTRON_MOCK_MEDIA_URL ?? 'http://127.0.0.1:3002/api',
    }, timeout: 30_000 })
  page = await application.firstWindow()
  page.on('close', () => evidence.lifecycle.push({ event: 'page-close', step: evidence.step }))
  application.process().on('exit', (code, signal) => evidence.lifecycle.push({ event: 'process-exit', code, signal, step: evidence.step }))
  await page.waitForFunction(() => Boolean(window.electronAPI))
  const email = page.getByLabel('邮箱', { exact: true })
  await email.waitFor({ timeout: 20_000 })
  await control(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.on('show', () => window.hide())
      window.hide()
    }
  })
  await email.fill(process.env.SEP_ELECTRON_TEST_EMAIL ?? 'staff@acme.local')
  await page.getByLabel('密码', { exact: true }).fill(process.env.SEP_ELECTRON_TEST_PASSWORD ?? 'Demo123456')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  evidence.step = 'await-login'
  await email.waitFor({ state: 'hidden', timeout: 20_000 })
  await page.waitForFunction(async () => {
    const result = await window.electronAPI.getSubscriptions()
    return result.success && result.data.length > 0
  }, undefined, { timeout: 20_000 })
  evidence.realLogin = true
}
async function close() {
  evidence.requests.push(await control(() => globalThis.__sepMediaTest.evidence()))
  evidence.step = 'close'
  await application.close()
  application = undefined
}
async function ipc(name, arg) {
  const result = await page.evaluate(([method, input]) => window.electronAPI[method](input), [name, arg])
  assert.equal(result.success, true, `${name}: ${JSON.stringify(result.error)}`)
  return result
}
async function viewTask(title) {
  await page.getByRole('button', { name: '工作记录', exact: true }).click()
  await page.getByText(title, { exact: true }).first().click({ timeout: 20_000 })
  await openMedia()
}
async function openMedia() {
  await page.getByRole('region', { name: '图片创作与成果' }).waitFor({ timeout: 20_000 })
}
async function approve() {
  await page.getByRole('button', { name: '允许工具执行' }).click({ timeout: 20_000 })
}
async function waitJob(taskId, predicate) {
  for (let i = 0; i < 100; i++) {
    const view = (await ipc('getTaskMedia', taskId)).data
    const job = view.jobs.find(predicate)
    if (job) return { view, job }
    await new Promise(done => setTimeout(done, 250))
  }
  throw new Error('Timed out waiting for media job')
}
try {
  await launch()
  const subs = (await ipc('getSubscriptions')).data
  evidence.subscriptions = subs.map(item => ({ subscriptionId: item.subscriptionId, name: item.name, templateName: item.template?.name }))
  const ecommerce = subs.find(item => item.name === '国内电商运营专家' || item.template?.name === '国内电商运营专家')
  const frontend = subs.find(item => item.name === '前端工程师' || item.template?.name === '前端工程师')
  assert.ok(ecommerce && frontend, 'Existing subscribed employees required; runner never seeds accounts')
  const approved = await control((_, id) => globalThis.__sepMediaTest.prepare(id), frontend.subscriptionId)
  assert.ok(approved.skills.length > 0)
  for (const skill of approved.skills) assert.equal(createHash('sha256').update(await readFile(skill.path)).digest('hex'), skill.sha256)
  assert.equal(approved.productionExecutionAvailable, false)
  const mock = await control((_, id) => globalThis.__sepMediaTest.prepare(id), ecommerce.subscriptionId)
  assert.equal(mock.productionExecutionAvailable, false)
  evidence.phases.push({ name: 'actual-approved-skill-install', employee: frontend.name, skills: approved.skills })

  const title = 'Electron 电商图片显式 mock 验收'
  const task = (await ipc('createConversation', { title, prompt: '本地 mock 图片验收，不运行聊天模型', subscriptionId: ecommerce.subscriptionId })).task
  assert.ok(task?.id)
  evidence.taskId = task.id
  await viewTask(title)
  const originalSize = await control(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  evidence.workDirectoryLayouts = []
  for (const width of [originalSize[0], 980]) {
    await control(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, originalSize[1]])
    await page.waitForFunction(expected => window.innerWidth === expected, width)
    const layout = await page.locator('.ent-wk-infobar-item.workdir .ent-wk-path').evaluate(path => {
      const bounds = path.getBoundingClientRect()
      const parent = path.parentElement.getBoundingClientRect()
      const copy = path.querySelector('button').getBoundingClientRect()
      return { width: window.innerWidth, bounded: bounds.right <= parent.right + 1,
        copyVisible: copy.left >= bounds.left && copy.right <= bounds.right + 1 }
    })
    assert.equal(layout.bounded, true)
    assert.equal(layout.copyVisible, true)
    evidence.workDirectoryLayouts.push(layout)
    if (width === 980) await page.screenshot({ path: join(output, 'electron-work-detail-compact.png') })
  }
  await control(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), originalSize)
  await page.waitForFunction(expected => window.innerWidth === expected, originalSize[0])
  const fixturePath = join(profile, 'reference.png')
  await writeFile(fixturePath, Buffer.from(mock.referenceFixtureBase64, 'base64'))
  await control(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, fixturePath)
  await page.getByRole('button', { name: '从系统选择参考图' }).click()
  await page.getByLabel('参考图 1', { exact: true }).waitFor()
  await page.getByRole('button', { name: '编辑参考图', exact: true }).click()
  await page.getByLabel('参考图 1', { exact: true }).check()
  await page.getByLabel('图片配置', { exact: true }).selectOption('mock-sync')
  await page.getByLabel('创作需求', { exact: true }).fill('静态商品参考图编辑，仅 mock，不收费')
  await page.getByRole('button', { name: '提交图片编辑', exact: true }).click()
  await approve()
  await approve()
  const saved = await waitJob(task.id, job => job.profileId === 'mock-sync' && job.saveStatus === 'SAVED')
  assert.equal(saved.job.generationStatus, 'SUCCEEDED')
  assert.equal(saved.job.billingStatus, 'MOCK_NOT_CHARGED')
  await openMedia()
  await page.getByRole('button', { name: '放大查看成果 1', exact: true }).click()
  await page.getByRole('dialog', { name: '图片大图预览' }).waitFor()
  const decoded = await page.locator('.media-preview-dialog img').evaluate(image => image.complete && image.naturalWidth === 1)
  assert.equal(decoded, true)
  await page.screenshot({ path: join(output, 'electron-preview.png') })
  const exportPath = join(output, 'exported-mock.png')
  await control(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, exportPath)
  await page.getByRole('button', { name: '导出图片', exact: true }).click()
  await page.waitForTimeout(500)
  assert.equal(createHash('sha256').update(await readFile(exportPath)).digest('hex'), mock.referenceFixtureSha256)
  await page.getByRole('button', { name: '关闭大图预览' }).click()
  evidence.phases.push({ name: 'native-electron-edit-preview-export', job: saved.job, decoded, exportHash: mock.referenceFixtureSha256 })

  await page.getByRole('button', { name: '生成', exact: true }).click()
  await page.getByLabel('图片配置', { exact: true }).selectOption('mock-async')
  await page.getByLabel('参考图 1', { exact: true }).uncheck()
  await page.getByLabel('创作需求', { exact: true }).fill('断线后查询原回执，不重新生成')
  await page.getByRole('button', { name: '提交图片生成', exact: true }).click()
  await approve()
  const running = await waitJob(task.id, job => job.profileId === 'mock-async' && ['QUEUED', 'RUNNING'].includes(job.generationStatus))
  assert.equal(running.job.saveStatus, 'PENDING')
  assert.equal((await control(() => globalThis.__sepMediaTest.evidence())).requests['/api/gateway/v1/media/requests'], 2)
  await control(() => globalThis.__sepMediaTest.disconnect(true))
  evidence.phases.push({ name: 'disconnect-after-accepted', jobId: running.job.jobId, generationStatus: running.job.generationStatus })
  await close()
  await launch()
  evidence.step = 'prepare-recovery'
  await control((_, id) => globalThis.__sepMediaTest.prepare(id), ecommerce.subscriptionId)
  evidence.step = 'view-recovery'
  await viewTask(title)
  evidence.step = 'wait-recovery'
  const restored = await waitJob(task.id, job => job.jobId === running.job.jobId && job.saveStatus === 'SAVED')
  assert.equal(restored.job.generationStatus, 'SUCCEEDED')
  assert.equal(restored.view.jobs.length, 2)
  const recoveredJob = page.locator('.media-job').filter({ hasText: running.job.jobId })
  await recoveredJob.getByText('已保存到本地', { exact: true }).waitFor({ timeout: 10_000 })
  await recoveredJob.scrollIntoViewIfNeeded()
  evidence.recoveredJobUi = await recoveredJob.innerText()
  await page.screenshot({ path: join(output, 'electron-restart-recovery.png') })
  evidence.phases.push({ name: 'electron-process-restart-original-job-recovery', job: restored.job })
  await close()
  assert.equal(evidence.requests.reduce((n, x) => n + (x.requests['/api/gateway/v1/media/requests'] ?? 0), 0), 2)
  assert.equal(evidence.requests.reduce((n, x) => n + x.blockedRequests, 0), 0)
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  evidence.error = error instanceof Error ? error.stack : String(error)
  if (page && !page.isClosed()) {
    evidence.panel = await page.getByRole('region', { name: '图片创作与成果' }).innerText().catch(() => undefined)
    if (evidence.taskId) evidence.localMedia = await control((_, id) => globalThis.__sepMediaTest.inspect(id), evidence.taskId).catch(error => ({ error: String(error) }))
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined)
  }
  if (application) await close().catch(() => undefined)
  process.exitCode = 1
} finally {
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  process.stdout.write(JSON.stringify({ passed: evidence.passed, phases: evidence.phases.map(x => x.name), error: evidence.error, output }) + '\n')
}
