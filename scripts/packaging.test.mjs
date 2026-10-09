import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { getConfig, validateConfiguration } from 'app-builder-lib/out/util/config/config.js'
import { DebugLogger } from 'builder-util'
import { createBuilderConfig } from './generate-builder-config.mjs'

const root = process.cwd()
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'sep-packaging-test-'))
  for (const folder of ['scripts', 'config', 'electron/common', 'dist']) mkdirSync(resolve(dir, folder), { recursive: true })
  for (const file of ['generate-runtime-config.mjs', 'generate-builder-config.mjs', 'generate-checksums.mjs', 'generate-release-notes.mjs']) cpSync(resolve(root, 'scripts', file), resolve(dir, 'scripts', file))
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
  const version = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).version
  assert.match(readFileSync(resolve(dir, 'dist/RELEASE-NOTES-beta.md'), 'utf8'), new RegExp(`SEP Client ${version} \\(beta\\)`))
})
test('release scripts keep channel selection and do not force cross-platform packaging', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const channel of ['beta', 'stable']) {
    assert.match(pkg.scripts['package:' + channel], new RegExp('release:config:' + channel))
    assert.match(pkg.scripts['package:' + channel], new RegExp('release:builder:' + channel))
    assert.match(pkg.scripts['package:' + channel], new RegExp(`electron-builder --config \\.release/electron-builder\\.${channel}\\.json --publish never`))
    assert.match(pkg.scripts['package:' + channel], new RegExp(`generate-checksums\\.mjs dist/${channel}`))
    assert.match(pkg.scripts['package:' + channel], new RegExp(`generate-release-notes\\.mjs ${channel} dist/${channel}`))
    assert.doesNotMatch(pkg.scripts['package:' + channel], /npm run build|--mac --win/)
  }
  assert.equal(pkg.dependencies['@earendil-works/pi-coding-agent'], '0.83.0')
  assert.equal(pkg.devDependencies['@earendil-works/pi-ai'], '0.83.0')
})

test('channel builder configs preserve packaging settings and pass the installed builder schema', async () => {
  const dir = fixture()
  const original = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).build
  const urls = []
  for (const channel of ['beta', 'stable']) {
    assert.equal(run(dir, 'generate-builder-config.mjs', [channel]).status, 0)
    const path = resolve(dir, `.release/electron-builder.${channel}.json`)
    const config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.publish, [{ provider: 'generic', url: `https://download.longdaosep.cn/sep-client/${channel}/`, channel: 'latest' }])
    assert.equal(config.directories.output, `dist/${channel}`)
    assert.equal(config.detectUpdateChannel, false)
    assert.equal(config.generateUpdatesFilesForAllChannels, false)
    for (const key of ['appId', 'productName', 'copyright', 'files', 'asarUnpack', 'artifactName', 'win', 'linux']) {
      assert.deepEqual(config[key], original[key])
    }
    assert.deepEqual(config.mac.target, [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ])
    assert.equal(config.mac.icon, original.mac.icon)
    assert.equal(config.mac.category, original.mac.category)
    urls.push(config.publish[0].url)
    const effective = await getConfig(dir, path)
    await validateConfiguration(effective, new DebugLogger(false))
    assert.deepEqual(effective.publish, config.publish)
    assert.equal(effective.appId, original.appId)
    assert.equal(effective.directories.output, config.directories.output)
  }
  assert.notEqual(urls[0], urls[1])
  assert.equal(JSON.stringify(JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).build), JSON.stringify(original))
})

test('builder generation rejects unknown, missing and conflicting channels before writing a config', () => {
  const dir = fixture()
  for (const args of [[], ['invalid'], ['../stable'], ['beta', 'stable']]) {
    assert.notEqual(run(dir, 'generate-builder-config.mjs', args).status, 0)
  }
  const result = run(dir, 'generate-builder-config.mjs', ['stable'], { SEP_RELEASE_CHANNEL: 'beta' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /conflicts/)
})

test('builder config does not mutate the base and rejects platform feed overrides', () => {
  const base = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).build
  const snapshot = structuredClone(base)
  createBuilderConfig(base, 'beta')
  assert.deepEqual(base, snapshot)
  for (const channel of ['__proto__', 'constructor', 'preview']) {
    assert.throws(() => createBuilderConfig(base, channel), /channel/)
  }
  for (const platform of ['mac', 'win', 'linux']) {
    const overridden = { ...base, [platform]: { ...base[platform], publish: { provider: 'generic', url: 'https://wrong.test/' } } }
    assert.throws(() => createBuilderConfig(overridden, 'stable'), /must not override/)
  }
})

test('release notes and checksums can target isolated channel directories', () => {
  const dir = fixture()
  for (const channel of ['beta', 'stable']) {
    const directory = `dist/${channel}`
    mkdirSync(resolve(dir, directory), { recursive: true })
    writeFileSync(resolve(dir, directory, 'test.exe'), channel)
    assert.equal(run(dir, 'generate-checksums.mjs', [directory]).status, 0)
    assert.equal(readFileSync(resolve(dir, directory, 'SHA256SUMS.txt'), 'utf8'), createHash('sha256').update(channel).digest('hex') + '  test.exe\n')
    assert.equal(run(dir, 'generate-release-notes.mjs', [channel, directory]).status, 0)
    assert.match(readFileSync(resolve(dir, directory, `RELEASE-NOTES-${channel}.md`), 'utf8'), new RegExp(`\\(${channel}\\)`))
  }
  assert.notEqual(run(dir, 'generate-release-notes.mjs', ['invalid']).status, 0)
})

test('default packaging selects beta and update tooling has a pinned YAML parser', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.scripts.package, 'npm run package:beta')
  assert.equal(pkg.devDependencies['js-yaml'], '4.3.0')
  assert.equal(lock.packages[''].devDependencies['js-yaml'], pkg.devDependencies['js-yaml'])
  assert.equal(lock.packages['node_modules/js-yaml'].version, pkg.devDependencies['js-yaml'])
})
