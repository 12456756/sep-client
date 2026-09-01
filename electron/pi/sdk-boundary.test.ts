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
  it('loads the task coordinator lazily after the Electron compatibility layer', async () => {
    const mainSource = await readFile(join(process.cwd(), 'electron', 'main.ts'), 'utf8')
    const compatibilityImport = mainSource.indexOf("import './infrastructure/undici-polyfill'")
    const coordinatorImport = mainSource.indexOf("await import('./tasks/task-execution-coordinator')")

    assert.ok(compatibilityImport >= 0, 'Electron compatibility layer must be loaded by main.ts')
    assert.ok(coordinatorImport > compatibilityImport, 'Task coordinator must load after the compatibility layer')
    assert.doesNotMatch(
      mainSource,
      /import\s+(?!type\b)[^;\n]*from\s+['"]\.\/tasks\/task-execution-coordinator['"]/,
      'Any static coordinator import would load the pi SDK before main.ts can initialize compatibility support',
    )
  })

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
