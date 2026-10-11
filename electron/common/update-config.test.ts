import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { supportsAppUpdates } from './update-config'

it('supports packaged Windows x64 and macOS x64/arm64 only', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const arch of ['x64', 'arm64', 'ia32']) {
      assert.equal(supportsAppUpdates(false, platform, arch), false)
      assert.equal(supportsAppUpdates(true, platform, arch),
        platform === 'darwin' && (arch === 'x64' || arch === 'arm64') || platform === 'win32' && arch === 'x64')
    }
  }
})
