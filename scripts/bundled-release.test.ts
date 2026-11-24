import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readBundledRelease } from './bundled-release'

test('bundles only the package version notes and preserves their structure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-release-notes-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.5.9' }))
    await mkdir(join(root, 'release-notes'))
    await writeFile(join(root, 'release-notes/0.5.9.md'), '### 1. Update\nDetails\n')
    await writeFile(join(root, 'release-notes/0.6.0.md'), 'Other version')
    assert.deepEqual(readBundledRelease(root), { version: '0.5.9', notes: '### 1. Update\nDetails' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('missing notes have an explicit empty fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sep-release-notes-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.6.0' }))
    assert.deepEqual(readBundledRelease(root), { version: '0.6.0', notes: '' })
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '../outside' }))
    assert.throws(() => readBundledRelease(root), /version/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
