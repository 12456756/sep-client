import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import yaml from 'js-yaml'
import { getConfig, validateConfiguration } from 'app-builder-lib/out/util/config/config.js'
import { Arch, DebugLogger } from 'builder-util'
import { normalizeOptions } from 'electron-builder/out/builder.js'
import { computeArchToTargetNamesMap } from 'app-builder-lib/out/targets/targetFactory.js'
import { createBuilderConfig } from './generate-builder-config.mjs'
import signAdhoc from './mac-adhoc-sign.cjs'

const root = process.cwd()

test('release validates version notes before packaging and uses the same version source for publication', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  const steps = workflow.jobs.validate.steps
  const checkIndex = steps.findIndex(step => step.run === 'npm run release:notes:check')
  assert.ok(checkIndex >= 0)
  assert.equal(steps[checkIndex].if, undefined)
  assert.ok(checkIndex < steps.findIndex(step => step.run === 'npm run test:packaging'))
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['release:notes:check'], 'node scripts/generate-release-notes.mjs --check-version')
  assert.ok(readFileSync(resolve(root, 'release-notes', `${pkg.version}.md`), 'utf8').trim())
})

test('release assembles once and gates production access and upload for each run mode', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  assert.equal(workflow.jobs.assemble, undefined)
  const job = workflow.jobs.publish
  assert.deepEqual(job.needs, ['validate', 'preflight', 'build-mac', 'build-win'])
  const steps = job.steps
  assert.deepEqual(steps.filter(step => step.uses === 'actions/download-artifact@v4').map(step => [step.with.name, step.with.path]), [
    ['sep-client-mac-arm64', 'release-mac-arm64'], ['sep-client-mac-x64', 'release-mac-x64'], ['sep-client-win', 'release-win'],
  ])
  const mergeIndex = steps.findIndex(step => step.run === 'node scripts/merge-mac-update-manifests.mjs release-mac-arm64/latest-mac.yml release-mac-x64/latest-mac.yml release-source/latest-mac.yml')
  const uploadIndex = steps.findIndex(step => step.name === 'Upload client files and publish manifests last')
  const prepareIndex = steps.findIndex(step => step.run === 'node scripts/prepare-download-update.mjs release-source stable release-prepared')
  assert.ok(mergeIndex >= 0 && mergeIndex < prepareIndex)
  assert.ok(prepareIndex >= 0 && prepareIndex < uploadIndex)
  for (const command of ['node scripts/verify-connector-assets.mjs release-source', 'node scripts/verify-update-manifest.mjs release-source --require-all-platforms']) {
    const index = steps.findIndex(step => step.run === command)
    assert.ok(index > mergeIndex && index < prepareIndex)
    assert.equal(steps[index].if, undefined)
  }
  assert.equal(steps[uploadIndex].run, 'node scripts/upload-download-update.mjs release-source release-prepared stable')
  const archive = steps.find(step => step.uses === 'actions/upload-artifact@v4')
  const publicCheck = steps.find(step => step.name === 'Verify the public update feed')
  assert.ok(steps.indexOf(publicCheck) > uploadIndex)
  assert.equal(steps.filter(step => step.uses === 'actions/upload-artifact@v4').length, 1)
  for (const [event, publish, expected, preflight] of [
    ['push', undefined, true, 'success'], ['workflow_dispatch', true, true, 'success'],
    ['workflow_dispatch', false, false, 'skipped'],
  ]) {
    const context = { github: { event_name: event }, inputs: { publish }, always: () => true,
      needs: Object.fromEntries(job.needs.map(name => [name, { result: name === 'preflight' ? preflight : 'success' }])) }
    const evaluate = value => runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), context, { timeout: 1000 })
    assert.equal(evaluate(job.if), true)
    assert.equal(evaluate(job.environment.name), expected ? 'sep-download-production' : 'sep-download-validation')
    assert.equal(evaluate(steps[uploadIndex].if), expected)
    assert.equal(evaluate(publicCheck.if), expected)
    assert.equal(evaluate(archive.if), !expected)
    for (const dependency of job.needs) {
      for (const result of ['failure', 'cancelled']) {
        const previous = context.needs[dependency].result
        context.needs[dependency].result = result
        assert.equal(evaluate(job.if), false, `${event}: ${dependency} ${result} must block release`)
        context.needs[dependency].result = previous
      }
    }
  }
})

test('platform artifacts contain only downloadable release files without recompressing installers', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  for (const [job, patterns] of [
    ['build-mac', ['*.dmg', '*.zip', '*.blockmap', 'latest-mac.yml', 'connector-assets/**']],
    ['build-win', ['*.exe', '*.blockmap', 'latest.yml', 'connector-assets/**']],
  ]) {
    const step = workflow.jobs[job].steps.find(step => step.uses === 'actions/upload-artifact@v4')
    assert.equal(step.with['compression-level'], 0)
    assert.equal(step.with['if-no-files-found'], 'error')
    assert.deepEqual(step.with.path.trim().split(/\r?\n/), patterns.map(pattern => `dist/local/stable/${pattern}`))
  }
  assert.equal(workflow.jobs.publish.steps.find(step => step.uses === 'actions/upload-artifact@v4').with['compression-level'], 0)
})

test('Electron download caches restore before npm installation and remain isolated by platform and lockfile', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  assert.equal(workflow.env.ELECTRON_CACHE, '${{ github.workspace }}/.cache/electron')
  assert.equal(workflow.env.electron_config_cache, workflow.env.ELECTRON_CACHE)
  assert.equal(workflow.env.ELECTRON_BUILDER_CACHE, '${{ github.workspace }}/.cache/electron-builder')
  for (const job of ['validate', 'build-mac', 'build-win', 'publish']) {
    const steps = workflow.jobs[job].steps
    const cacheIndex = steps.findIndex(step => step.uses === 'actions/cache@v4' && step.with.key.startsWith('electron-downloads-'))
    const installIndex = steps.findIndex(step => step.run?.includes('npm ci'))
    assert.ok(cacheIndex >= 0 && cacheIndex < installIndex, `${job} must restore downloads before install scripts`)
    const cache = steps[cacheIndex]
    const prefix = job === 'build-mac'
      ? 'electron-downloads-v2-${{ runner.os }}-${{ runner.arch }}-${{ matrix.arch }}-'
      : 'electron-downloads-v1-${{ runner.os }}-${{ runner.arch }}-'
    assert.equal(cache.with.key, prefix + "${{ hashFiles('package-lock.json') }}")
    assert.equal(cache.with['restore-keys'].trim(), prefix)
    assert.deepEqual(cache.with.path.trim().split(/\r?\n/), ['${{ env.ELECTRON_CACHE }}', '${{ env.ELECTRON_BUILDER_CACHE }}'])
  }
})

test('Windows dependency installation clears inherited PowerShell modules without disabling install scripts', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  const install = workflow.jobs['build-win'].steps.find(step => step.run?.includes('npm ci'))
  assert.equal(install.shell, 'cmd')
  assert.deepEqual(install.run.trim().split(/\r?\n/), ['set "PSModulePath="', 'npm ci'])
})

test('Windows install shell allows Node children to extract the pinned DingTalk archive with system modules', { skip: process.platform !== 'win32' }, t => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  const install = workflow.jobs['build-win'].steps.find(step => step.run?.includes('npm ci'))
  const directory = mkdtempSync(resolve(tmpdir(), 'sep-windows-install-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const archive = resolve(root, 'node_modules/dingtalk-workspace-cli/assets/dws-windows-amd64.zip')
  const probe = resolve(directory, 'probe.cjs')
  writeFileSync(probe, [
    "const assert = require('node:assert/strict')",
    "const { spawnSync } = require('node:child_process')",
    'assert.equal(process.env.PSModulePath, undefined)',
    "const quote = value => \"'\" + value.replaceAll(\"'\", \"''\") + \"'\"",
    "const command = \"$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath \" + quote(process.argv[2]) + ' -DestinationPath ' + quote(process.argv[3]) + '; (Get-Module Microsoft.PowerShell.Archive).Path'",
    "const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })",
    'process.stdout.write(result.stdout ?? "")',
    'process.stderr.write(result.stderr ?? "")',
    'assert.equal(result.status, 0, result.stderr)',
    'assert.match(result.stdout, /WindowsPowerShell/i)',
  ].join('\n'))
  const executable = resolve(directory, 'extracted')
  const command = install.run.replace('npm ci', `"${process.execPath}" "${probe}" "${archive}" "${executable}"`)
  const batch = resolve(directory, 'install.cmd')
  writeFileSync(batch, `@echo off\r\nchcp 65001 >nul\r\n${command.trim().replace(/\r?\n/g, '\r\n')}\r\n`, 'utf8')
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'install.cmd'], {
    cwd: directory, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PSModulePath: resolve(process.env.ProgramFiles, 'PowerShell/7/Modules') },
  })
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  assert.equal(readFileSync(resolve(executable, 'dws.exe')).subarray(0, 2).toString(), 'MZ')
})

test('release workflow allows 120 seconds per public artifact verification', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  const step = workflow.jobs.publish.steps.find(step => step.name === 'Verify the public update feed')
  assert.equal(step.run, 'node scripts/test-update-feed.mjs https://sep.longdaoec.com/sep-client/stable/ --require-all-platforms --timeout-ms 120000')
})

test('release workflow builds macOS architectures in parallel without rebuilding the other architecture', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  const job = workflow.jobs['build-mac']
  assert.equal(job['runs-on'], 'macos-15-intel')
  assert.deepEqual(job.strategy.matrix.arch, ['arm64', 'x64'])
  assert.equal(job.strategy['max-parallel'], 2)
  assert.equal(job.strategy['fail-fast'], false)
  assert.deepEqual(job.needs, ['validate', 'preflight'])
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const config = createBuilderConfig(pkg.build, 'stable')
  assert.match(pkg.scripts['package:ci:stable:mac'], /--mac$/)
  const command = job.steps.find(step => step.run?.startsWith('npm run package:ci:stable:mac'))
  assert.equal(command.run, 'npm run package:ci:stable:mac -- dmg zip --${{ matrix.arch }}')
  for (const arch of job.strategy.matrix.arch) {
    const options = normalizeOptions({ mac: ['dmg', 'zip'], [arch]: true })
    const [[platform, targets]] = options.targets
    const effective = computeArchToTargetNamesMap(targets, { platformSpecificBuildOptions: config.mac }, platform)
    assert.deepEqual([...effective], [[Arch[arch], ['dmg', 'zip']]])
  }
  const install = job.steps.find(step => step.run?.startsWith('npm install --no-save'))
  assert.equal(install.run, 'npm install --no-save --package-lock=false --ignore-scripts --force sherpa-onnx-darwin-${{ matrix.arch }}@1.13.8')
  const upload = job.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.equal(upload.with.name, 'sep-client-mac-${{ matrix.arch }}')
})

test('release workflow restores versioned speech caches before unconditional verification on every build platform', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  for (const job of ['validate', 'build-mac', 'build-win']) {
    const steps = workflow.jobs[job].steps
    const caches = steps.filter(step => step.uses === 'actions/cache@v4' && step.with.key.startsWith('speech-'))
    assert.equal(caches.length, 1, `${job} must have one speech cache`)
    const cache = caches[0]
    assert.equal(cache.with.key, "speech-v1-${{ runner.os }}-${{ hashFiles('resources/speech/sensevoice-int8/manifest.json') }}")
    assert.deepEqual(cache.with.path.trim().split(/\r?\n/), [
      'resources/speech/sensevoice-int8/model.int8.onnx',
      'resources/speech/sensevoice-int8/tokens.txt',
    ])
    assert.equal(cache.with['restore-keys'], undefined)
    assert.equal(cache.if, undefined)
    const prepare = steps.find(step => step.run === 'npm run speech:prepare')
    assert.ok(prepare, `${job} must verify even on cache hits`)
    assert.equal(prepare.if, undefined)
    assert.ok(steps.indexOf(cache) < steps.indexOf(prepare))
  }
})

test('release workflow prepares and caches only the target OfficeCLI architecture', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/client-release.yml'), 'utf8'))
  for (const [job, paths, commands] of [
    ['build-mac', ['resources/office/officecli-mac-${{ matrix.arch }}'],
      ['npm run office:prepare -- darwin ${{ matrix.arch }}']],
    ['build-win', ['resources/office/officecli-win-x64.exe'], ['npm run office:prepare']],
  ]) {
    const steps = workflow.jobs[job].steps
    const caches = steps.filter(step => step.uses === 'actions/cache@v4' && step.with.key.startsWith('officecli-'))
    assert.equal(caches.length, 1, `${job} must have one OfficeCLI cache`)
    const cache = caches[0]
    assert.equal(cache.with.key, job === 'build-mac'
      ? "officecli-v2-${{ runner.os }}-${{ matrix.arch }}-${{ hashFiles('resources/office/manifest.json') }}"
      : "officecli-v1-${{ runner.os }}-${{ hashFiles('resources/office/manifest.json') }}")
    assert.deepEqual(cache.with.path.trim().split(/\r?\n/), paths)
    assert.equal(cache.with['restore-keys'], undefined)
    assert.equal(cache.if, undefined)
    const packageIndex = steps.findIndex(step => step.run?.startsWith('npm run package:ci:stable:'))
    assert.ok(packageIndex >= 0)
    for (const command of commands) {
      const prepare = steps.find(step => step.run === command)
      assert.ok(prepare, `${job} must prepare ${command}`)
      assert.equal(prepare.if, undefined)
      assert.ok(steps.indexOf(cache) < steps.indexOf(prepare))
      assert.ok(steps.indexOf(prepare) < packageIndex)
    }
  }
})

test('macOS packaging declares microphone purpose and signed audio input access', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.mac.extendInfo?.NSMicrophoneUsageDescription)
  const entitlements = readFileSync(resolve(root, 'build/entitlements.mac.plist'), 'utf8')
  assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/)
  for (const channel of ['beta', 'stable']) {
    const generated = createBuilderConfig(pkg.build, channel)
    assert.deepEqual(generated.mac.extendInfo, pkg.build.mac.extendInfo)
  }
})

test('local and signed installers preserve the Skills import system protocol', () => {
  const build = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).build
  assert.deepEqual(build.protocols, [{ name: 'SEP Skills Import', schemes: ['sep-import'] }])
  assert.deepEqual(createBuilderConfig(build, 'stable').protocols, build.protocols)
  const signed = createBuilderConfig(build, 'stable', { signed: true, platform: 'darwin', env: { SEP_MAC_TEAM_ID: 'ABCDE12345', APPLE_KEYCHAIN_PROFILE: 'test-profile' } })
  assert.deepEqual(signed.protocols, build.protocols)
})

test('local packages require ad hoc signing even with certificate discovery disabled', () => {
  const base = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).build
  for (const channel of ['beta', 'stable']) {
    const config = createBuilderConfig(base, channel, { env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
    assert.equal(config.mac.sign, 'scripts/mac-adhoc-sign.cjs')
    assert.equal(config.mac.identity, undefined)
    assert.equal(config.mac.notarize, false)
    assert.equal(config.dmg.sign, false)
  }
})

test('ad hoc signing seals renamed applications and rejects changed resources', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'sep-adhoc-test-'))
  const app = resolve(dir, 'Renamed Client.app')
  const contents = resolve(app, 'Contents')
  try {
    mkdirSync(resolve(contents, 'MacOS'), { recursive: true })
    mkdirSync(resolve(contents, 'Resources'), { recursive: true })
    cpSync('/usr/bin/true', resolve(contents, 'MacOS/Client'))
    writeFileSync(resolve(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cn.longdao.adhoc-test</string><key>CFBundleExecutable</key><string>Client</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
    const resource = resolve(contents, 'Resources/test.txt')
    writeFileSync(resource, 'original')
    await signAdhoc({ app, platform: 'darwin', optionsForFile: () => ({ entitlements: resolve(root, 'build/entitlements.mac.plist') }) })
    assert.equal(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status, 0)
    const signature = spawnSync('codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' })
    assert.equal(signature.status, 0)
    assert.match(signature.stderr, /Signature=adhoc/)
    assert.match(signature.stderr, /Identifier=cn\.longdao\.adhoc-test/)
    writeFileSync(resource, 'modified')
    assert.notEqual(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'sep-packaging-test-'))
  for (const folder of ['scripts', 'config', 'electron/common', 'dist']) mkdirSync(resolve(dir, folder), { recursive: true })
  for (const file of ['generate-runtime-config.mjs', 'generate-builder-config.mjs', 'release-signing.mjs', 'generate-checksums.mjs', 'generate-release-notes.mjs']) cpSync(resolve(root, 'scripts', file), resolve(dir, 'scripts', file))
  for (const channel of ['beta', 'stable']) cpSync(resolve(root, 'config', 'release.' + channel + '.json'), resolve(dir, 'config', 'release.' + channel + '.json'))
  cpSync(resolve(root, 'package.json'), resolve(dir, 'package.json'))
  return dir
}
function run(dir, script, args = [], extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SEP_')))
  return spawnSync(process.execPath, [resolve(dir, 'scripts', script), ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' })
}
test('runtime generation defaults to stable and rejects retired beta builds', () => {
  const dir = fixture()
  assert.equal(run(dir, 'generate-runtime-config.mjs').status, 0)
  const generated = readFileSync(resolve(dir, 'electron/common/runtime-config.generated.ts'), 'utf8')
  assert.match(generated, /"channel": "stable"/)
  assert.match(generated, /"environment": "production"/)
  assert.match(generated, /sep\.longdaoec\.com/)
  for (const [args, env] of [[['beta'], {}], [[], { SEP_RELEASE_CHANNEL: 'beta' }], [['stable'], { SEP_RELEASE_CHANNEL: 'beta' }]]) {
    const result = run(dir, 'generate-runtime-config.mjs', args, env)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /retired|conflicts/)
    assert.equal(readFileSync(resolve(dir, 'electron/common/runtime-config.generated.ts'), 'utf8'), generated)
  }
  writeFileSync(resolve(dir, 'config/release.stable.json'), JSON.stringify({ channel: 'stable', environment: 'production', sepBaseUrl: '', gatewayUrl: '' }))
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
test('local release packaging builds the complete macOS and Windows artifact set', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  for (const channel of ['stable']) {
    assert.match(pkg.scripts['package:' + channel], new RegExp('release:config:' + channel))
    assert.match(pkg.scripts['package:' + channel], new RegExp('release:builder:signed:' + channel))
    assert.match(pkg.scripts['package:' + channel], new RegExp(`electron-builder --config \\.release/electron-builder\\.${channel}\\.signed\\.json --publish never`))
    assert.ok(pkg.scripts['package:' + channel].startsWith('npm run release:preflight && '))
    assert.match(pkg.scripts['package:' + channel], new RegExp(`verify-release-signatures\\.mjs ${channel} && node scripts/verify-update-manifest\\.mjs dist/${channel} && node scripts/generate-checksums`))
    assert.match(pkg.scripts['package:local:' + channel], /--publish never/)
    assert.doesNotMatch(pkg.scripts['package:local:' + channel], /signed\.json/)
    assert.match(pkg.scripts['package:' + channel], new RegExp(`generate-checksums\\.mjs dist/${channel}`))
    assert.match(pkg.scripts['package:' + channel], new RegExp(`generate-release-notes\\.mjs ${channel} dist/${channel}`))
    assert.doesNotMatch(pkg.scripts['package:' + channel], /--mac --win/)
    assert.match(pkg.scripts['package:local:' + channel], /--mac --win/)
    assert.match(pkg.scripts['package:ci:' + channel + ':mac'], /--mac/)
    assert.doesNotMatch(pkg.scripts['package:ci:' + channel + ':mac'], /--win/)
    assert.match(pkg.scripts['package:ci:' + channel + ':win'], /--win/)
    assert.doesNotMatch(pkg.scripts['package:ci:' + channel + ':win'], /--mac/)
  }
  for (const name of ['package:beta', 'package:local:beta', 'release:config:beta', 'release:builder:beta', 'release:builder:signed:beta']) assert.equal(pkg.scripts[name], undefined)
  assert.equal(pkg.dependencies['@earendil-works/pi-coding-agent'], '0.83.0')
  assert.equal(pkg.dependencies['@earendil-works/pi-ai'], '0.83.0')
})

test('dynamically imported Pi provider is a pinned production dependency', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const name = '@earendil-works/pi-ai'
  assert.equal(pkg.dependencies[name], '0.83.0')
  assert.equal(pkg.devDependencies[name], undefined)
  assert.equal(lock.packages[''].dependencies[name], pkg.dependencies[name])
  assert.equal(lock.packages[''].devDependencies[name], undefined)
  assert.equal(lock.packages[`node_modules/${name}`].version, pkg.dependencies[name])
  assert.notEqual(lock.packages[`node_modules/${name}`].dev, true)
  const hook = readFileSync(resolve(root, pkg.build.afterPack), 'utf8')
  assert.match(hook, /verify-packaged-runtime\.mjs/)
  assert.match(hook, /verifyAfterPack\(context\)/)
})

test('notification WebSocket transport is a direct production dependency', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  assert.ok(pkg.dependencies.ws, 'externalized ws must be available from the application root')
  assert.equal(lock.packages[''].dependencies.ws, pkg.dependencies.ws)
  assert.notEqual(lock.packages['node_modules/ws'].dev, true)
})

test('stable builder config preserves packaging settings and passes the installed builder schema', async () => {
  const dir = fixture()
  const original = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')).build
  for (const channel of ['stable']) {
    assert.equal(run(dir, 'generate-builder-config.mjs', [channel]).status, 0)
    const path = resolve(dir, `.release/electron-builder.${channel}.json`)
    const config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.publish, [{ provider: 'generic', url: `https://sep.longdaoec.com/sep-client/${channel}/`, channel: 'latest' }])
    assert.equal(config.directories.output, `dist/local/${channel}`)
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
    const effective = await getConfig(dir, path)
    await validateConfiguration(effective, new DebugLogger(false))
    assert.deepEqual(effective.publish, config.publish)
    assert.equal(effective.appId, original.appId)
    assert.equal(effective.directories.output, config.directories.output)
  }
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

test('builder CLI rejects retired beta generation before writing unsigned or signed configs', () => {
  const dir = fixture()
  for (const args of [['beta'], ['beta', '--signed']]) {
    const result = run(dir, 'generate-builder-config.mjs', args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /retired/)
  }
  assert.equal(existsSync(resolve(dir, '.release')), false)
})

test('signed builder CLI fails before writing config without explicit release identity and rejects unknown flags', () => {
  const dir = fixture()
  const result = run(dir, 'generate-builder-config.mjs', ['stable', '--signed'])
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(resolve(dir, '.release/electron-builder.stable.signed.json')), false)
  for (const args of [['beta', '--unsigned'], ['beta', '--signed', '--extra']]) {
    const invalid = run(dir, 'generate-builder-config.mjs', args)
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /usage/)
  }
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

test('default packaging selects local stable and update tooling has a pinned YAML parser', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.scripts.package, 'npm run package:local:stable')
  assert.equal(pkg.devDependencies['js-yaml'], '4.3.0')
  assert.equal(lock.packages[''].devDependencies['js-yaml'], pkg.devDependencies['js-yaml'])
  assert.equal(lock.packages['node_modules/js-yaml'].version, pkg.devDependencies['js-yaml'])
})
