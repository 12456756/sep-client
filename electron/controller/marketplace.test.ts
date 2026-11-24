import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import { windowCloseCommand } from '../../src/shared/window-close'
import { AppError, appError } from '../errors/app-error'
import { INVOKE_CHANNELS, SEND_CHANNELS } from './channels'
import type { Route } from './router'

function setup(open: (url: string) => Promise<void>) {
  const dependencies: Record<string, unknown> = {
    electron: { dialog: {}, shell: { openExternal: open } },
    'node:path': { isAbsolute: () => false },
    zod: { z },
    '../../errors/app-error': { appError },
    '../../../src/shared/window-close': { windowCloseCommand },
    '../../common/window-layout': {},
    '../channels': { INVOKE_CHANNELS, SEND_CHANNELS },
    '../router': {
      NO_INPUT: z.undefined(),
      route: (channel: string, schema: unknown, handle: unknown, options: object) => ({ channel, schema, handle, ...options }),
      listener: () => ({}),
    },
  }
  const filename = fileURLToPath(new URL('./routes/system.ts', import.meta.url))
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  compileFunction(source, ['require', 'exports', 'module'], { filename })(
    (id: string) => { assert.ok(Object.hasOwn(dependencies, id), id); return dependencies[id] }, module.exports, module,
  )
  const routes = (module.exports as { systemRoutes: Route[] }).systemRoutes
  const route = routes.find(item => item.channel === 'marketplace:open')
  assert.ok(route, 'marketplace route must be registered')
  return route
}

test('marketplace opens only the fixed URL from the trusted main frame without reading credentials or tasks', async () => {
  const calls: string[] = []
  const route = setup(async url => { calls.push(url) })
  assert.equal(route.trustedMainFrame, true)
  assert.equal(route.errorShape, 'ipc')
  assert.equal(route.schema.safeParse(undefined).success, true)
  for (const input of ['https://other.example', { url: 'file:///private' }, null, []]) {
    assert.equal(route.schema.safeParse(input).success, false)
  }
  const context = new Proxy({}, { get: () => assert.fail('Must not access credentials or task services') })
  const result = await route.handle(context as never, undefined as never)
  assert.deepEqual(result, { success: true })
  assert.deepEqual(calls, ['https://sep.longdaoec.com/marketplace'])
})

test('marketplace opening failure has a readable error without exposing OS details', async () => {
  const route = setup(async () => { throw new Error('private browser command') })
  await assert.rejects(async () => route.handle({} as never, undefined as never), error => {
    assert.ok(error instanceof AppError)
    assert.equal(error.userMessage, '无法打开员工市场，请重试')
    assert.equal(error.code, 'SERVICE_UNAVAILABLE')
    return true
  })
})
