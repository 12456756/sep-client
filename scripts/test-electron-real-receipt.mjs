/* global window */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { _electron } from 'playwright-core'
import electron from 'electron'

// The runner passes the private path through untouched; only Electron main opens the fixture.
const fixturePath = process.env.SEP_REAL_RECEIPT_FIXTURE
assert.ok(fixturePath && isAbsolute(fixturePath), 'SEP_REAL_RECEIPT_FIXTURE must be an absolute private JSON path')
const output = resolve(process.env.SEP_REAL_RECEIPT_OUTPUT ?? `outputs/electron-real-receipt-${Date.now()}`)
await mkdir(output, { recursive: true, mode: 0o700 })
const profile = await realpath(await mkdtemp(join(tmpdir(), 'sep-electron-real-receipt-')))
const evidence = { harness: 'explicit-real-receipt', provesPiFlow: false, profile, phases: [], passed: false, step: 'start' }
let application, page, summary
const control = (fn, arg) => application.evaluate(fn, arg)
const inspect = () => control(() => globalThis.__sepRealReceiptTest.summary())
async function launch(phase) {
  evidence.step = `launch-${phase}`
  const env = { ...process.env, SEP_REAL_RECEIPT_HARNESS: '1', SEP_REAL_RECEIPT_PROFILE: profile,
    SEP_REAL_RECEIPT_PHASE: phase, SEP_REAL_RECEIPT_FIXTURE: fixturePath, SEP_PLAYWRIGHT_MCP: '0' }
  delete env.SEP_MCP_CONFIG
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: electron,
    args: [resolve('out/real-receipt/main/index.js')], env, timeout: 30_000 })
  page = await application.firstWindow()
  await page.getByRole('region', { name: '图片创作与成果' }).waitFor({ timeout: 20_000 })
  summary = await inspect()
  assert.equal(summary.identities.length, 2)
  assert.equal(summary.audit.actualNetworkRequests, 0, 'startup must not request the fixture service')
  return summary
}
async function ipc(name, input) {
  const result = await page.evaluate(([name, input]) => window.electronAPI[name](input), [name, input])
  assert.equal(result.success, true, `IPC ${name} failed`)
  return result.data
}
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`TIMEOUT_${label}`)
}
async function close(phase) {
  evidence.step = `close-${phase}`
  const done = application.waitForEvent('close', { timeout: 15_000 })
  await control(() => globalThis.__sepRealReceiptTest.shutdown())
  await done
  application = undefined
  const shutdown = JSON.parse(await readFile(join(profile, `real-receipt-shutdown-${phase}.json`), 'utf8'))
  assert.equal(shutdown.completed, true)
  return shutdown
}
function identityOnly(items) {
  return items.map(item => {
    const identity = { ...item }
    delete identity.trackingStatus
    delete identity.saveStatus
    return identity
  })
}
async function resumeFromPanel() {
  await page.getByRole('button', { name: '重新读取图片任务', exact: true }).count().then(async count => {
    if (count) await page.getByRole('button', { name: '重新读取图片任务', exact: true }).click()
  })
  for (let index = 0; index < 2; index++) {
    const button = page.getByRole('button', { name: '恢复跟踪', exact: true }).first()
    await button.waitFor({ timeout: 15_000 })
    await button.click()
    // The actual panel disables other actions while its IPC command refreshes the view.
    await waitFor(async () => await page.getByText('正在处理图片操作', { exact: true }).count() === 0, 'UI_COMMAND')
  }
}
try {
  const first = await launch('blocked')
  evidence.source = first.source
  evidence.identities = first.identities
  evidence.step = 'verify-receipts'
  const verification = await control(() => globalThis.__sepRealReceiptTest.verifyReceipts())
  if (verification.failure) evidence.receiptVerification = verification.failure
  assert.deepEqual(verification, { verified: 2 })
  // Production IPC validators still run, but all mutating routes are explicitly denied.
  const redo = await page.evaluate(input => window.electronAPI.redoMediaJob(input), {
    taskId: first.taskId, jobId: first.identities[0].jobId,
  })
  assert.equal(redo.success, false)
  assert.equal(redo.error?.code, 'PERMISSION_DENIED')
  evidence.step = 'block-downloads'
  await resumeFromPanel()
  const blocked = await waitFor(async () => {
    const state = await inspect()
    return state.audit.blockedDownloads === 2 ? state : null
  }, 'BLOCK_DOWNLOADS')
  assert.ok(blocked.identities.every(job => job.saveStatus === 'SAVING'))
  evidence.phases.push({ phase: 'blocked-before-quit', ...blocked })
  const shutdown = await close('blocked')
  assert.ok(shutdown.identities.every(job => job.trackingStatus === 'INTERRUPTED' && job.saveStatus === 'SAVE_FAILED'))
  assert.deepEqual(identityOnly(shutdown.identities), identityOnly(first.identities))
  evidence.phases.push({ phase: 'normal-shutdown', ...shutdown })

  const restarted = await launch('recover')
  assert.deepEqual(restarted.identities, shutdown.identities, 'restart must load original persisted jobs without reseeding')
  assert.equal(restarted.audit.allowed.length, 0, 'restart waits for explicit recovery')
  evidence.step = 'explicit-recovery'
  await resumeFromPanel()
  const saved = await waitFor(async () => {
    const view = await ipc('getTaskMedia', restarted.taskId)
    return view.jobs.length === 2 && view.jobs.every(job => job.saveStatus === 'SAVED') && view.assets.length === 2 ? view : null
  }, 'SAVED')
  await page.getByRole('button', { name: '放大查看成果 2', exact: true }).waitFor({ timeout: 15_000 })
  const exports = []
  for (let index = 0; index < 2; index++) {
    evidence.step = `preview-export-${index + 1}`
    const asset = saved.assets[index]
    const expected = restarted.expected.find(job => job.jobId === asset.jobId).outputs.find(out => out.outputId === asset.outputId)
    const grid = page.locator('.media-asset').nth(index)
    // Resolve the visible grid's asset via its exact preload result ordering.
    const gridAssets = (await ipc('getTaskMedia', restarted.taskId)).assets.filter(item => item.source === 'output')
    assert.equal(gridAssets[index].localAssetId, asset.localAssetId)
    await grid.getByRole('button', { name: `放大查看成果 ${index + 1}`, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '图片大图预览' })
    await dialog.waitFor()
    await waitFor(async () => dialog.locator('img').evaluateAll(images => images.length === 1 && images[0].complete && images[0].naturalWidth > 0), 'PNG_DECODE')
    const dimensions = await dialog.locator('img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight }))
    assert.deepEqual(dimensions, { width: expected.width, height: expected.height })
    const preview = await ipc('previewMediaAsset', { taskId: restarted.taskId, assetId: asset.localAssetId })
    const previewHash = createHash('sha256').update(new Uint8Array(preview.bytes)).digest('hex')
    assert.equal(previewHash, expected.sha256)
    const exportPath = join(output, `export-${index + 1}.png`)
    await control(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, exportPath)
    await dialog.getByRole('button', { name: '导出图片', exact: true }).click()
    await waitFor(async () => {
      try { return createHash('sha256').update(await readFile(exportPath)).digest('hex') === expected.sha256 } catch { return false }
    }, 'EXPORT_HASH')
    await page.screenshot({ path: join(output, `preview-${index + 1}.png`) })
    exports.push({ jobId: asset.jobId, outputId: asset.outputId, dimensions, previewHash,
      exportSha256: expected.sha256, byteLength: (await readFile(exportPath)).length })
    assert.equal(exports[index].byteLength, expected.size)
    await dialog.getByRole('button', { name: '关闭大图预览', exact: true }).click()
  }
  await page.screenshot({ path: join(output, 'saved-panel.png'), fullPage: true })
  const final = await inspect()
  assert.deepEqual(identityOnly(final.identities), identityOnly(first.identities))
  for (const state of [blocked, final]) {
    assert.ok(state.audit.allowed.every(request => request.method === 'GET'))
    assert.equal(state.audit.postRequestsSent, 0)
    assert.equal(state.audit.approvalRequested, 0)
  }
  evidence.phases.push({ phase: 'recovered-preview-export', ...final, exports })
  await close('recover')
  evidence.passed = true
  evidence.step = 'complete'
} catch {
  // Do not serialize Playwright exception details, network traces, fixture paths or error bodies.
  evidence.failure = 'REAL_RECEIPT_ACCEPTANCE_FAILED'
  process.exitCode = 1
} finally {
  if (application) {
    try { await application.close() } catch { /* preserve a sanitized failure artifact */ }
  }
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  process.stdout.write(`${evidence.passed ? 'PASS' : 'FAIL'} real receipt acceptance: ${output}\n`)
}
