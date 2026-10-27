import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { externalUpdateDownloadUrl, supportsAppUpdates } from './update-config'

it('builds versioned HTTPS download links for the current channel and architecture', () => {
  for (const channel of ['beta', 'stable'] as const) {
    for (const arch of ['arm64', 'x64']) {
      assert.equal(externalUpdateDownloadUrl(channel, '0.2.1', 'darwin', arch),
        'https://download.longdaosep.cn/sep-client/' + channel + '/0.2.1/SEP-Client-0.2.1-mac-' + arch + '.dmg')
    }
    assert.equal(externalUpdateDownloadUrl(channel, '0.2.1-beta.1', 'win32', 'x64'),
      'https://download.longdaosep.cn/sep-client/' + channel + '/0.2.1-beta.1/SEP-Client-0.2.1-beta.1-win-x64.exe')
  }
})

it('rejects untrusted versions, channels and unsupported platforms instead of opening arbitrary URLs', () => {
  for (const version of ['../0.2.1', 'https://evil.test', '0.2.1?token=x', '0.2.1#x', '0.2.1/other', '0.2.1\n', '01.2.1', '0.2.1-beta.01', '1.2.3-' + 'x'.repeat(100)]) {
    assert.throws(() => externalUpdateDownloadUrl('stable', version, 'darwin', 'arm64'))
  }
  assert.throws(() => externalUpdateDownloadUrl('other' as 'stable', '0.2.1', 'darwin', 'arm64'))
  assert.throws(() => externalUpdateDownloadUrl('stable', '0.2.1', 'linux', 'x64'))
  assert.throws(() => externalUpdateDownloadUrl('stable', '0.2.1', 'win32', 'arm64'))
  assert.throws(() => externalUpdateDownloadUrl('stable', '0.2.1' + String.fromCharCode(10), 'darwin', 'arm64'))
})

it('supports packaged Windows x64 and macOS x64/arm64 only', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const arch of ['x64', 'arm64', 'ia32']) {
      assert.equal(supportsAppUpdates(false, platform, arch), false)
      assert.equal(supportsAppUpdates(true, platform, arch),
        platform === 'darwin' && (arch === 'x64' || arch === 'arm64') || platform === 'win32' && arch === 'x64')
    }
  }
})
