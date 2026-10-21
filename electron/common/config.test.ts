import { execFileSync } from 'node:child_process'
import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { isVideoMockEnabled, isVideoRealEnabled } from './config'

it('real video is enabled by default, can be explicitly disabled and cannot coexist with mock', () => {
  assert.equal(isVideoRealEnabled({}), true)
  assert.equal(isVideoRealEnabled({ SEP_VIDEO_REAL_ENABLED: '' }), true)
  for (const value of ['false', '1', 'TRUE', ' true', 'true ']) assert.equal(isVideoRealEnabled({ SEP_VIDEO_REAL_ENABLED: value }), false)
  assert.equal(isVideoRealEnabled({ SEP_VIDEO_REAL_ENABLED: 'true' }), true)
  assert.equal(isVideoRealEnabled({ SEP_VIDEO_MOCK_ENABLED: 'true' }), false)
  const both = { SEP_VIDEO_REAL_ENABLED: 'true', SEP_VIDEO_MOCK_ENABLED: 'true' }
  assert.throws(() => isVideoRealEnabled(both), /mutually exclusive/)
  assert.throws(() => isVideoMockEnabled(both), /mutually exclusive/)
})

it('requires an explicit exact true opt-in for mock video', () => {
  for (const value of [undefined, '', 'false', '1', 'TRUE', ' true', 'true ']) {
    assert.equal(isVideoMockEnabled({ SEP_VIDEO_MOCK_ENABLED: value }), false)
  }
  assert.equal(isVideoMockEnabled({ SEP_VIDEO_MOCK_ENABLED: 'true' }), true)
})

const cases = [
  { name: 'production API path', baseUrl: 'https://LONGDAOSEP.cn:443/api/', expected: 'https://longdaosep.cn' },
  { name: 'localhost API', baseUrl: 'http://localhost:3001/api', expected: 'http://localhost:3000' },
  { name: 'loopback API', baseUrl: 'http://127.0.0.1:3001/api', expected: 'http://127.0.0.1:3000' },
  { name: 'separate web origin', baseUrl: 'https://api.example.com/api', webOrigin: 'https://WEB.example.com:443/', expected: 'https://web.example.com' },
  { name: 'independent asset CDN', baseUrl: 'https://longdaosep.cn/api', assetBaseUrl: 'https://cdn.example.com/assets', expected: 'https://longdaosep.cn' },
]

for (const scenario of cases) {
  it(`configures the platform request Origin for ${scenario.name}`, () => {
    const output = execFileSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { config } from ${JSON.stringify(new URL('./config.ts', import.meta.url).href)}; process.stdout.write(JSON.stringify(config));`,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SEP_BASE_URL: scenario.baseUrl,
        SEP_WEB_ORIGIN: scenario.webOrigin ?? '',
        SEP_ASSET_BASE_URL: scenario.assetBaseUrl ?? '',
      },
    })
    const config = JSON.parse(output) as { SEP_WEB_ORIGIN: string }
    assert.equal(config.SEP_WEB_ORIGIN, scenario.expected)
  })
}
