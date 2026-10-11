import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { validateConfiguration } from 'app-builder-lib/out/util/config/config.js'
import { DebugLogger } from 'builder-util'
import { createBuilderConfig, generateBuilderConfig } from './generate-builder-config.mjs'
import { preflightSigning, signingConfiguration } from './release-signing.mjs'

const mac = { SEP_MAC_TEAM_ID: 'ABCDE12345', APPLE_KEYCHAIN_PROFILE: 'release-profile' }
const win = { SEP_WINDOWS_PUBLISHER: 'Example Publisher', WIN_CSC_LINK: 'cert.pfx', WIN_CSC_KEY_PASSWORD: 'secret-value' }
const identity = '  1) 1234567890 "Developer ID Application: Example (ABCDE12345)"\n  1 valid identities found'
const ok = { status: 0, stdout: identity, stderr: '' }
const args = (env = mac, platform = 'darwin') => ({ env, platform, arch: platform === 'darwin' ? 'arm64' : 'x64', run: () => ok, read: () => {} })

test('mac release policy pins distribution team, hardened runtime, entitlements, notarization and signed DMG', () => {
  const policy = preflightSigning(args())
  assert.equal(policy.forceCodeSigning, true)
  assert.equal(policy.mac.identity, mac.SEP_MAC_TEAM_ID)
  assert.equal(policy.mac.type, 'distribution')
  assert.equal(policy.mac.hardenedRuntime, true)
  assert.equal(policy.mac.notarize, true)
  assert.equal(policy.mac.entitlementsInherit, policy.mac.entitlements)
  assert.equal(policy.dmg.sign, true)
  const entitlements = readFileSync(policy.mac.entitlements, 'utf8')
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/)
  assert.doesNotMatch(entitlements, /get-task-allow|disable-library-validation/)
})

test('mac requires explicit team and a complete notarization method', () => {
  for (const env of [{}, { ...mac, SEP_MAC_TEAM_ID: 'bad' }, { SEP_MAC_TEAM_ID: mac.SEP_MAC_TEAM_ID }, { ...mac, SEP_MAC_TEAM_ID: ' ABCDE12345' }]) {
    assert.throws(() => signingConfiguration(env, 'darwin'))
  }
  for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    assert.throws(() => signingConfiguration({ ...mac, [key]: 'present' }, 'darwin'), /APPLE_/)
  }
})

test('Apple ID and API key methods match installed builder precedence and check team and readable API key', () => {
  const apple = { ...mac, APPLE_ID: 'release@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'private-password', APPLE_TEAM_ID: mac.SEP_MAC_TEAM_ID }
  assert.doesNotThrow(() => preflightSigning(args(apple)))
  assert.throws(() => preflightSigning(args({ ...apple, APPLE_TEAM_ID: 'OTHER12345' })), /must match/)
  const api = { ...mac, APPLE_API_KEY: '/private/key.p8', APPLE_API_KEY_ID: 'key-id', APPLE_API_ISSUER: 'issuer' }
  const reads = []
  preflightSigning({ ...args(api), read: path => reads.push(path) })
  assert.deepEqual(reads, ['/private/key.p8'])
  assert.throws(() => preflightSigning({ ...args(api), read: () => { throw Error('secret path') } }), /^Error: APPLE_API_KEY must refer to a readable local file$/)
})

test('mac preflight rejects absent, expired, other-team or development-only identities', () => {
  for (const stdout of ['0 valid identities found', identity.replace('ABCDE12345', 'OTHER12345'), identity.replace('Developer ID Application:', 'Apple Development:'), identity.replace('\n', ' CSSMERR_TP_CERT_EXPIRED\n')]) {
    assert.throws(() => preflightSigning({ ...args(), run: (command) => command === 'security' ? { ...ok, stdout } : ok }), /no valid Developer ID/)
  }
})

test('local/imported certificate, base64 and HTTPS sources defer authentication to actual signing without leaking passwords', () => {
  for (const link of ['cert.p12', 'file:///private/cert.p12', 'https://example.test/cert.p12', 'BASE64VALUE']) {
    const env = { ...mac, CSC_LINK: link, CSC_KEY_PASSWORD: 'secret-value' }
    const commands = []
    const reads = []
    const policy = preflightSigning({ ...args(env), run: command => { commands.push(command); return ok }, read: path => reads.push(path) })
    assert.deepEqual(commands, ['xcrun'])
    assert.equal(reads.length, link.startsWith('https:') || link === 'BASE64VALUE' ? 0 : 1)
    assert.doesNotMatch(JSON.stringify(policy), /secret-value|cert\.p12|BASE64VALUE/)
  }
  assert.throws(() => preflightSigning(args({ ...mac, CSC_LINK: 'cert.p12' })), /CSC_KEY_PASSWORD/)
  assert.throws(() => preflightSigning(args({ ...mac, CSC_IDENTITY_AUTO_DISCOVERY: 'false' })), /not allowed/)
})

test('preflight subprocess failures are bounded and redact raw output', () => {
  for (const run of [() => ({ status: 1, stderr: 'private-password', stdout: 'raw identities' }), () => { throw Error('private-password') }]) {
    assert.throws(() => preflightSigning({ ...args(), run }), /^Error: notarytool is required/)
  }
})

test('Windows release policy requires publisher, x64 NSIS, SHA256 and update signature verification', () => {
  const policy = preflightSigning(args(win, 'win32'))
  assert.equal(policy.forceCodeSigning, true)
  assert.equal(policy.win.verifyUpdateCodeSignature, true)
  assert.equal(policy.win.signAndEditExecutable, true)
  assert.deepEqual(policy.win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(policy.win.signtoolOptions.publisherName, win.SEP_WINDOWS_PUBLISHER)
  assert.deepEqual(policy.win.signtoolOptions.signingHashAlgorithms, ['sha256'])
  assert.doesNotMatch(JSON.stringify(policy), /secret-value|cert\.pfx/)
})

test('Windows publisher and certificate are explicit, unambiguous and passwords may be deliberately empty', () => {
  for (const env of [{}, { SEP_WINDOWS_PUBLISHER: 'Example' }, { ...win, SEP_WINDOWS_PUBLISHER: 'Example\nPublisher' }, { ...win, WIN_CSC_KEY_PASSWORD: undefined }, { ...win, SEP_WINDOWS_CERTIFICATE_SHA1: 'A'.repeat(40) }]) {
    assert.throws(() => signingConfiguration(env, 'win32'))
  }
  assert.doesNotThrow(() => signingConfiguration({ ...win, WIN_CSC_KEY_PASSWORD: '' }, 'win32'))
  assert.doesNotThrow(() => signingConfiguration({ SEP_WINDOWS_PUBLISHER: 'Example', CSC_LINK: 'cert.pfx', CSC_KEY_PASSWORD: '' }, 'win32'))
})

test('Windows token/store signing pins exact certificate thumbprint and checks private key/validity without command interpolation', () => {
  const env = { SEP_WINDOWS_PUBLISHER: "Example ' Publisher", SEP_WINDOWS_CERTIFICATE_SHA1: 'a'.repeat(40) }
  let command
  const policy = preflightSigning({ ...args(env, 'win32'), run: (name, values) => { command = [name, values]; return ok } })
  assert.equal(policy.win.signtoolOptions.certificateSha1, 'A'.repeat(40))
  assert.equal(command[0], 'powershell.exe')
  assert.match(command[1].at(-1), /HasPrivateKey/)
  assert.match(command[1].at(-1), /\$env:SEP_WINDOWS_CERTIFICATE_SHA1/)
  assert.doesNotMatch(command[1].at(-1), /Example|aaaaaaaa/)
  assert.throws(() => preflightSigning({ ...args(env, 'win32'), run: () => ({ status: 1, stderr: 'secret' }) }), /Windows certificate store/)
  assert.throws(() => signingConfiguration({ ...env, SEP_WINDOWS_CERTIFICATE_SHA1: 'invalid' }, 'win32'), /thumbprint/)
})

test('release signing rejects unsupported hosts, architectures and pull-request contexts', () => {
  assert.throws(() => preflightSigning({ ...args(), platform: 'linux' }), /native/)
  assert.throws(() => preflightSigning({ ...args(win, 'win32'), arch: 'arm64' }), /x64/)
  assert.throws(() => preflightSigning({ ...args(), arch: 'ia32' }), /architecture/)
  for (const key of ['GITHUB_BASE_REF', 'TRAVIS_PULL_REQUEST', 'CIRCLE_PULL_REQUEST', 'APPVEYOR_PULL_REQUEST_NUMBER', 'BITRISE_PULL_REQUEST']) {
    assert.throws(() => preflightSigning(args({ ...mac, [key]: '123', CSC_FOR_PULL_REQUEST: 'true' })), /pull-request/)
  }
  for (const event of ['pull_request', 'pull_request_target']) assert.throws(() => preflightSigning(args({ ...mac, GITHUB_EVENT_NAME: event })), /pull-request/)
})

test('signed channel configs validate against installed builder schema and never serialize signing secrets', async () => {
  const build = JSON.parse(readFileSync('package.json', 'utf8')).build
  for (const channel of ['beta', 'stable']) {
    for (const [platform, env] of [['darwin', { ...mac, CSC_LINK: 'SECRET_CERT', CSC_KEY_PASSWORD: 'PRIVATE_PASSWORD' }], ['win32', win]]) {
      const config = createBuilderConfig(build, channel, { signed: true, platform, env })
      await validateConfiguration(config, new DebugLogger(false))
      assert.equal(config.forceCodeSigning, true)
      assert.equal(config.directories.output, `dist/${channel}`)
      assert.equal(config.publish[0].url, `https://download.longdaosep.cn/sep-client/${channel}/`)
      assert.doesNotMatch(JSON.stringify(config), /SECRET_CERT|PRIVATE_PASSWORD|secret-value/)
    }
  }
  assert.equal(createBuilderConfig(build, 'beta').forceCodeSigning, undefined)
  assert.equal(createBuilderConfig(build, 'beta').directories.output, 'dist/local/beta')
})

test('signed config rejects custom or deprecated signing overrides', () => {
  const build = JSON.parse(readFileSync('package.json', 'utf8')).build
  for (const key of ['sign', 'certificateFile', 'certificatePassword', 'certificateSubjectName', 'certificateSha1', 'azureSignOptions']) {
    assert.throws(() => createBuilderConfig({ ...build, win: { ...build.win, [key]: 'override' } }, 'beta', { signed: true, env: win, platform: 'win32' }), /must not override/)
  }
  assert.throws(() => createBuilderConfig({ ...build, mac: { ...build.mac, sign: 'override' } }, 'beta', { signed: true, env: mac, platform: 'darwin' }), /must not override/)
})

test('local and signed generated config files coexist with isolated output directories', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'sep-signing-config-'))
  try {
    writeFileSync(resolve(root, 'package.json'), readFileSync('package.json'))
    const localPath = await generateBuilderConfig('beta', root)
    const signedPath = await generateBuilderConfig('beta', root, { signed: true, env: mac, platform: 'darwin' })
    assert.notEqual(localPath, signedPath)
    assert.match(signedPath, /electron-builder\.beta\.signed\.json$/)
    assert.equal(JSON.parse(readFileSync(localPath, 'utf8')).directories.output, 'dist/local/beta')
    const signed = JSON.parse(readFileSync(signedPath, 'utf8'))
    assert.equal(signed.directories.output, 'dist/beta')
    assert.equal(signed.forceCodeSigning, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
