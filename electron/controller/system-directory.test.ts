import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import { appError } from '../errors/app-error'
import { INVOKE_CHANNELS, SEND_CHANNELS } from './channels'
import type { SelectDirectoryResult } from '../../src/shared/ipc'

interface TestRoute {
  channel: string
  schema: z.ZodType
  handle(ctx: unknown, input: unknown): Promise<SelectDirectoryResult>
}

// Run the actual route with the native dialog replaced; Node cannot load Electron UI APIs.
function harness(result = { canceled: false, filePaths: [join(process.cwd(), 'selected')] }) {
  const calls: Array<{ defaultPath?: string; properties: string[] }> = []
  const exports: { systemRoutes?: TestRoute[] } = {}
  const source = readFileSync(new URL('./routes/system.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const imports: Record<string, unknown> = {
    electron: { dialog: { async showOpenDialog(_window: unknown, options: typeof calls[number]) { calls.push(options); return result } } },
    'node:path': { isAbsolute },
    zod: { z },
    '../../errors/app-error': { appError },
    '../channels': { INVOKE_CHANNELS, SEND_CHANNELS },
    '../router': {
      NO_INPUT: z.undefined(),
      route: (channel: string, schema: z.ZodType, handle: TestRoute['handle']) => ({ channel, schema, handle }),
      listener: () => ({}),
    },
  }
  runInNewContext(compiled, { exports, require: (name: string) => {
    assert.ok(name in imports, 'unexpected route dependency: ' + name)
    return imports[name]
  } })
  const route = exports.systemRoutes?.find(entry => entry.channel === INVOKE_CHANNELS.UTIL_SELECT_DIRECTORY)
  assert.ok(route)
  const paths: Array<string | undefined> = []
  const defaultPath = join(process.cwd(), 'default-workspace')
  const ctx = {
    window: () => ({}),
    tasks: { async prepareDirectorySelection(path?: string) { paths.push(path); return defaultPath } },
  }
  return { route, calls, paths, defaultPath, ctx }
}

describe('directory selection IPC', () => {
  it('opens the dialog at the prepared default workspace for no input', async () => {
    const { route, calls, paths, defaultPath, ctx } = harness()
    const result = await route.handle(ctx, route.schema.parse(undefined))
    assert.equal(calls[0]?.defaultPath, defaultPath)
    assert.deepEqual(paths, [undefined])
    assert.ok(calls[0]?.properties.includes('openDirectory'))
    assert.equal(result.path, join(process.cwd(), 'selected'))
    assert.equal(result.success, true)
  })

  it('validates and forwards the currently selected absolute path', async () => {
    const { route, paths, ctx } = harness()
    const path = join(process.cwd(), 'existing-workspace')
    await route.handle(ctx, route.schema.parse('  ' + path + '  '))
    assert.deepEqual(paths, [path])
    for (const invalid of [null, 1, {}, 'relative/path']) {
      assert.equal(route.schema.safeParse(invalid).success, false)
    }
  })

  it('returns no selected path when the dialog is canceled', async () => {
    const { route, ctx } = harness({ canceled: true, filePaths: [] })
    const result = await route.handle(ctx, route.schema.parse(undefined))
    assert.equal(result.success, false)
    assert.equal(result.path, null)
  })

  it('does not prepare a directory or open a dialog without a window', async () => {
    const { route, calls, paths, ctx } = harness()
    await assert.rejects(() => route.handle({ ...ctx, window: () => null }, undefined), { code: 'INTERNAL_ERROR' })
    assert.equal(calls.length, 0)
    assert.equal(paths.length, 0)
  })
})
