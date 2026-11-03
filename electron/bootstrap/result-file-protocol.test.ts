import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'

test('registers a secure streaming scheme and delegates protocol requests with disposal', async () => {
  const compiled = ts.transpileModule(readFileSync(new URL('./result-file-protocol.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const registrations: unknown[] = []
  let handler: ((request: Request) => Promise<Response>) | undefined
  let unhandled = false
  const module = { exports: {} as typeof import('./result-file-protocol') }
  compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => {
    assert.equal(id, 'electron')
    return { protocol: {
      registerSchemesAsPrivileged: (schemes: unknown) => { registrations.push(schemes) },
      handle: (scheme: string, value: typeof handler) => { assert.equal(scheme, 'sep-result'); handler = value },
      unhandle: (scheme: string) => { assert.equal(scheme, 'sep-result'); unhandled = true },
    } }
  }, module.exports, module)
  module.exports.registerResultFileScheme()
  assert.deepEqual(registrations, [[{ scheme: 'sep-result', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]])
  const request = new Request(`sep-result://preview/${'a'.repeat(64)}`)
  const dispose = module.exports.installResultFileProtocol({ async handle(value) { assert.equal(value, request); return new Response('test') } })
  assert.equal(await (await handler!(request)).text(), 'test')
  dispose(); assert.equal(unhandled, true)
})
