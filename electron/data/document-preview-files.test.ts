import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readDeliveryPreviewFile } from './arrangement-delivery-files'
import type { FinalDeliveryFile } from '../domain/arrangement-delivery'

test('preview reads accepted snapshots without repairing or modifying the workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-document-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = Buffer.from('accepted document')
  const sha256 = createHash('sha256').update(original).digest('hex')
  const file: FinalDeliveryFile = { id: 'report', path: 'report.md', format: 'md', size: original.length,
    sha256, nodeRunId: 'run-1', validatedAt: 1, snapshot: { sha256, size: original.length, source: 'confirmed' } }
  await mkdir(join(root, 'delivery-snapshots'))
  const snapshot = join(root, 'delivery-snapshots', `${sha256}.md`)
  await writeFile(snapshot, original)
  await writeFile(join(root, 'report.md'), 'a different in-progress version')
  const result = await readDeliveryPreviewFile(root, file, root)
  assert.equal(result.bytes.toString(), original.toString())
  assert.equal(result.source, 'snapshot')
  await writeFile(snapshot, 'corrupt')
  await assert.rejects(readDeliveryPreviewFile(root, file, root))
  assert.equal(await readFile(join(root, 'report.md'), 'utf8'), 'a different in-progress version')
})

test('historical deliveries can preview an unchanged original but never recover changed bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-document-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('legacy accepted')
  const file: FinalDeliveryFile = { id: 'report', path: 'report.txt', format: 'txt', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), nodeRunId: 'run-1', validatedAt: 1 }
  await writeFile(join(root, file.path), bytes)
  assert.equal((await readDeliveryPreviewFile(root, file, root)).source, 'verified-original')
  await writeFile(join(root, file.path), 'modified')
  await assert.rejects(readDeliveryPreviewFile(root, file, root))
  await assert.rejects(readFile(join(root, 'delivery-snapshots', `${file.sha256}.txt`)))
  await assert.rejects(readDeliveryPreviewFile(root, { ...file, path: '../outside.txt' }, root))
})
