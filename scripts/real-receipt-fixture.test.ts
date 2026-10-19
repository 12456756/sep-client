import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { MediaStore } from '../electron/data/media-store'
import { memoryReceiptFixture } from './real-receipt-test-fixture'
import { isReceiptGetAllowed, parseRealReceiptFixture, readRealReceiptFixture, receiptGetPaths } from './real-receipt-fixture'

test('complete synthetic generate/edit jobs pass the real store validator; inconsistent quote is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'receipt-store-test-'))
  try {
    const fixture = parseRealReceiptFixture(memoryReceiptFixture(), true)
    const store = new MediaStore(root)
    for (const job of fixture.jobs) await store.saveJob(fixture.owner, job)
    assert.equal((await store.listJobs(fixture.owner)).length, 2)
    const invalid = structuredClone(fixture.jobs[0])
    invalid.jobId = 'invalid-job'
    invalid.quote.requestHash = 'f'.repeat(64)
    await assert.rejects(store.saveJob(fixture.owner, invalid))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('GET allowlist denies every POST, wrong IDs, origins, query strings, model, quote, redirect destination', () => {
  const fixture = memoryReceiptFixture()
  for (const path of receiptGetPaths(fixture)) {
    const url = new URL(path, fixture.baseUrl)
    assert.equal(isReceiptGetAllowed(fixture, url, 'GET'), true)
    for (const method of ['POST', 'DELETE', 'PUT', 'HEAD', 'PATCH']) assert.equal(isReceiptGetAllowed(fixture, url, method), false)
    assert.equal(isReceiptGetAllowed(fixture, new URL(`${url}?token=x`), 'GET'), false)
  }
  for (const url of ['https://evil.invalid/api/gateway/v1/media/real/requests/local-test-receipt-edit',
    'http://127.0.0.1:1/api/gateway/v1/media/real/requests/other',
    'http://127.0.0.1:1/api/gateway/v1/media/real/quotes',
    'http://127.0.0.1:1/api/chat/completions',
    'http://127.0.0.1:1/api/gateway/v1/media/real/requests/local-test-receipt-edit/cancel']) {
    assert.equal(isReceiptGetAllowed(fixture, new URL(url), 'GET'), false)
  }
})

test('provenance rejects invented manual approvals, token in public data and unflagged synthetic data', () => {
  const fixture = memoryReceiptFixture()
  assert.throws(() => parseRealReceiptFixture(fixture))
  const manual = structuredClone(fixture)
  manual.jobs[0].approval = 'manual'
  assert.throws(() => parseRealReceiptFixture(manual, true))
  manual.provenance.approvals[0].kind = 'recorded-manual'
  assert.throws(() => parseRealReceiptFixture(manual, true))
  const leaked = structuredClone(fixture)
  leaked.jobs[0].input.creativeBrief = fixture.employmentToken
  assert.throws(() => parseRealReceiptFixture(leaked, true))
})

test('private fixture rejects loose file/parent permissions and symlink', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'receipt-private-test-'))
  const file = join(parent, 'fixture.json')
  try {
    await writeFile(file, JSON.stringify(memoryReceiptFixture()), { mode: 0o600 })
    await readRealReceiptFixture(file, true)
    await chmod(file, 0o644)
    await assert.rejects(readRealReceiptFixture(file, true), /INVALID_PRIVATE_RECEIPT_FIXTURE/)
    await chmod(file, 0o600)
    await chmod(parent, 0o755)
    await assert.rejects(readRealReceiptFixture(file, true), /INVALID_PRIVATE_RECEIPT_FIXTURE/)
    await chmod(parent, 0o700)
    await symlink(file, join(parent, 'link.json'))
    await assert.rejects(readRealReceiptFixture(join(parent, 'link.json'), true))
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test('real Electron restart, real preload/IPC/panel, preview and exports using IN-MEMORY protocol only', {
  skip: process.env.SEP_RUN_RECEIPT_ELECTRON_TEST !== '1', timeout: 120_000,
}, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'receipt-electron-test-'))
  const file = join(parent, 'fixture.json')
  const output = resolve(`outputs/real-receipt-memory-test-${Date.now()}`)
  try {
    await writeFile(file, JSON.stringify(memoryReceiptFixture()), { mode: 0o600 })
    const result = await new Promise<number | null>(resolve => {
      const child = spawn(process.execPath, ['scripts/test-electron-real-receipt.mjs'], {
        cwd: process.cwd(), stdio: 'inherit', env: { ...process.env,
          SEP_REAL_RECEIPT_FIXTURE: file, SEP_REAL_RECEIPT_OUTPUT: output, SEP_REAL_RECEIPT_MEMORY_TEST: '1' },
      })
      child.once('exit', resolve)
      child.once('error', () => resolve(-1))
    })
    const text = await readFile(join(output, 'evidence.json'), 'utf8')
    assert.equal(text.includes('local-harness-test-token'), false)
    const evidence = JSON.parse(text)
    assert.equal(result, 0, `sanitized failing step: ${evidence.step}`)
    assert.equal(evidence.passed, true)
    assert.equal(evidence.source, 'memory-protocol-test')
    for (const phase of evidence.phases) if (phase.audit) assert.equal(phase.audit.actualNetworkRequests, 0)
  } finally { await rm(parent, { recursive: true, force: true }) }
})
