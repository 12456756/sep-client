import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('production video hosts wire distinct local, recovery and execution authorization paths', async () => {
  const source = await readFile(new URL('./build-backend.ts', import.meta.url), 'utf8')
  assert.match(source, /localAuthorizationRevision:\s*\(\)\s*=>\s*this\.employees\.getLocalAuthorizationRevision\(\)/)
  assert.match(source, /recoveryAuthorizationRevision:\s*\(\)\s*=>\s*this\.employees\.getRecoveryAuthorizationRevision\(\)/)
  assert.match(source, /localRuntime:\s*subscriptionId\s*=>\s*this\.employees\.resolveVideo\(subscriptionId\)/)
  assert.match(source, /authorizeRecovery:[\s\S]*?this\.employees\.authorizeRecovery\(subscriptionId\)[\s\S]*?PERMISSION_DENIED/)
  assert.match(source, /new MockVideoHostService\(videoOptions\)/)
  assert.match(source, /new VideoRunService\(videoOptions, this\.video\)/)
  assert.match(source, /authorize:[\s\S]*?this\.employees\.authorizeRuntime\(subscriptionId\)/)
})
