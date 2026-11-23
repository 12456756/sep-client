import * as assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { test } from 'node:test'
import { createEncodingBashOperations } from './pi-bash-operations'
import { bashEnvironment, resolveBashShell } from './pi-bash-shell'

const resources = () => String.raw`C:\Program Files\CSEP\resources`
const bundled = String.raw`C:\Program Files\CSEP\resources\bash-runtime\usr\bin\bash.exe`
const wsl = String.raw`C:\Windows\System32\bash.exe`
const git = String.raw`D:\Program Files\Git`
const sdk = (shell = wsl) => ({ shell, args: ['-c'] })
const windows = { platform: 'win32', resources, env: {}, isFile: (_: string) => false }

test('packaged Bash wins regardless of PATH or SDK defaults', () => {
  const config = resolveBashShell(() => assert.fail('should not resolve SDK shell'), {
    ...windows, isFile: path => path === bundled,
  })
  assert.equal(config.shell, bundled)
  assert.deepEqual(config.args, ['--noprofile', '--norc', '-c'])
  assert.equal(config.binPath, bundled.slice(0, -'\\bash.exe'.length))
})

test('Windows development finds a non-default Git installation without selecting WSL', () => {
  assert.equal(resolveBashShell(sdk, {
    ...windows,
    env: { Path: `relative;C:/Windows/System32;"${git}\\cmd"` },
    isFile: path => [`${git}\\cmd\\git.exe`, `${git}\\bin\\bash.exe`].includes(path),
  }).shell, `${git}\\bin\\bash.exe`)
  assert.throws(() => resolveBashShell(sdk, windows), /Bash is unavailable/)
})

test('non-Windows and existing non-WSL SDK shells retain their behavior', () => {
  assert.deepEqual(resolveBashShell(() => sdk('/bin/bash'), {
    ...windows, platform: 'darwin', resources: () => assert.fail('should not resolve resources'),
  }), sdk('/bin/bash'))
  assert.deepEqual(resolveBashShell(() => sdk(`${git}\\bin\\bash.exe`), windows), sdk(`${git}\\bin\\bash.exe`))
})

test('only the bundled shell child PATH is prefixed and its BASH_ENV is cleared', () => {
  const env = { Path: 'ambient', BASH_ENV: 'init.sh', LANG: 'C.UTF-8' }
  assert.deepEqual(bashEnvironment(env, 'bundled'), { Path: 'bundled;ambient', LANG: 'C.UTF-8' })
  assert.equal(env.Path, 'ambient')
  assert.equal(env.BASH_ENV, 'init.sh')
  assert.deepEqual(bashEnvironment({ PATH: '' }, 'bundled'), { PATH: 'bundled' })
})

const stagedResources = process.env.SEP_TEST_BASH_RESOURCES
test('staged Windows runtime runs through project Bash operations without system Bash on PATH', {
  skip: process.platform !== 'win32' || !stagedResources,
}, async () => {
  assert.ok(stagedResources)
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const env = { SystemRoot: systemRoot, Path: `${systemRoot}\\System32`, LANG: 'C.UTF-8', TEMP: process.env.TEMP }
  const operations = createEncodingBashOperations(() => resolveBashShell(() => assert.fail('used system Bash'), {
    ...windows, resources: () => stagedResources, env,
    isFile: path => statSync(path, { throwIfNoEntry: false })?.isFile() === true,
  }))
  const chunks: Buffer[] = []
  const { exitCode } = await operations.exec(
    "set -euo pipefail; test -d /tmp; pwd -W; printf 'hello\\n' | grep hello | sed 's/hello/ok/' | awk '{print $1}'; exit 7",
    process.cwd(), { env, onData: chunk => chunks.push(chunk), timeout: 10 },
  )
  assert.equal(exitCode, 7)
  const output = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/)
  assert.equal(output.length, 2)
  assert.equal(output[0].toLowerCase(), process.cwd().replaceAll('\\', '/').toLowerCase())
  assert.equal(output[1], 'ok')
})
