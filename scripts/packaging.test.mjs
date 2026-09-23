import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = process.cwd()
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'sep-packaging-test-'))
  for (const folder of ['scripts', 'config', 'electron/common', 'dist']) mkdirSync(resolve(dir, folder), { recursive: true })
  for (const file of ['generate-runtime-config.mjs', 'generate-checksums.mjs', 'generate-release-notes.mjs']) cpSync(resolve(root, 'scripts', file), resolve(dir, 'scripts', file))
  for (const channel of ['beta', 'stable']) cpSync(resolve(root, 'config', 'release.' + channel + '.json'), resolve(dir, 'config', 'release.' + channel + '.json'))
  cpSync(resolve(root, 'package.json'), resolve(dir, 'package.json'))
  return dir
}
function run(dir, script, args = [], extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SEP_')))
  return spawnSync(process.execPath, [resolve(dir, 'scripts', script), ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' })
}
test('beta config is generated and stable requires an explicit base URL', () => {
  const dir = fixture()
  assert.equal(run(dir, 'generate-runtime-config.mjs', ['beta']).status, 0)
  const generated = readFileSync(resolve(dir, 'electron/common/runtime-config.generated.ts'), 'utf8')
  assert.match(generated, /"channel": "beta"/)
  assert.match(generated, /longdaosep\.cn/)
  assert.notEqual(run(dir, 'generate-runtime-config.mjs', ['stable']).status, 0)
  assert.equal(run(dir, 'generate-runtime-config.mjs', ['stable'], { SEP_BASE_URL: 'https://example.test/api', SEP_GATEWAY_URL: 'https://example.test/api/gateway/v1' }).status, 0)
  assert.match(readFileSync(resolve(dir, 'electron/common/runtime-config.generated.ts'), 'utf8'), /example\.test/)
  assert.notEqual(run(dir, 'generate-runtime-config.mjs', ['invalid']).status, 0)
})
test('checksums cover installers and release notes are generated', () => {
  const dir = fixture()
  writeFileSync(resolve(dir, 'dist/test.exe'), 'installer')
  writeFileSync(resolve(dir, 'dist/ignored.txt'), 'ignore')
  assert.equal(run(dir, 'generate-checksums.mjs', ['dist']).status, 0)
  assert.equal(readFileSync(resolve(dir, 'dist/SHA256SUMS.txt'), 'utf8'), createHash('sha256').update('installer').digest('hex') + '  test.exe\n')
  assert.equal(run(dir, 'generate-release-notes.mjs', ['beta']).status, 0)
  assert.match(readFileSync(resolve(dir, 'dist/RELEASE-NOTES-beta.md'), 'utf8'), /SEP Client 0.1.0 \(beta\)/)
})
test('release scripts keep channel selection and do not force cross-platform packaging', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const channel of ['beta', 'stable']) {
    assert.match(pkg.scripts['package:' + channel], new RegExp('release:config:' + channel))
    assert.doesNotMatch(pkg.scripts['package:' + channel], /npm run build|--mac --win/)
  }
  assert.equal(pkg.dependencies['@earendil-works/pi-coding-agent'], '0.83.0')
  assert.equal(pkg.devDependencies['@earendil-works/pi-ai'], '0.83.0')
})
