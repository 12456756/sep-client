import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

const SDK_PATTERN = /@earendil-works\/pi-(?:coding-agent|ai)/

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  }))
  return nested.flat()
}

describe('Pi SDK boundary', () => {
  it('keeps production SDK imports inside the single adapter module', async () => {
    const root = process.cwd()
    const files = [
      ...await sourceFiles(join(root, 'electron', 'pi')),
      ...await sourceFiles(join(root, 'pi-extension')),
    ]
    const importers: string[] = []
    for (const file of files) {
      if (SDK_PATTERN.test(await readFile(file, 'utf8'))) importers.push(relative(root, file).replaceAll('\\', '/'))
    }
    assert.deepEqual(importers, ['electron/pi/sdk/pi-coding-agent-adapter.ts'])
  })
})
