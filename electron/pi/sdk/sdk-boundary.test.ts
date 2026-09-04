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
    const root = process.cwd()
    const mainSource = await readFile(join(root, 'electron', 'main.ts'), 'utf8')
    const compositionSource = await readFile(join(root, 'electron', 'bootstrap', 'build-backend.ts'), 'utf8')

    // 下面几个都是被检查文件里的源码字面量，不是本文件的 import——搬家后要跟着更新。
    // main.ts 的第一个 import 必须是兼容层：它之后的任何静态 import 都可能拉进 pi SDK。
    const firstImport = /^\s*import\s.*$/m.exec(mainSource)
    assert.ok(firstImport, 'main.ts must import something')
    assert.match(
      firstImport[0],
      /['"]\.\/common\/undici-polyfill['"]/,
      'main.ts 的第一个 import 必须是 Electron 兼容层',
    )

    // 协调器只能通过动态 import 加载，且只有组装根这一处。
    assert.match(
      compositionSource,
      /await import\('\.\.\/runtime\/task-execution-coordinator'\)/,
      '协调器必须在组装根里用动态 import 加载',
    )

    const staticImporters: string[] = []
    for (const file of await sourceFiles(join(root, 'electron'))) {
      const source = await readFile(file, 'utf8')
      if (/import\s+(?!type\b)[^;\n]*from\s+['"][^'"]*runtime\/task-execution-coordinator['"]/.test(source)) {
        staticImporters.push(relative(root, file).replaceAll('\\', '/'))
      }
    }
    assert.deepEqual(
      staticImporters,
      [],
      'Any static coordinator import would load the pi SDK before the compatibility layer runs',
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
