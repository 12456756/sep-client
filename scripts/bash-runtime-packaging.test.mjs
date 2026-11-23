import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { afterBashRuntimePack, runtimePackages, verifyArchive } from './bash-runtime-packaging.mjs'

test('non-Windows and non-x64 builds do not stage Bash', async () => {
  for (const [electronPlatformName, arch] of [['linux', 1], ['darwin', 1], ['win32', 3]]) {
    await afterBashRuntimePack({ electronPlatformName, arch, get appOutDir() { assert.fail('must not run') } })
  }
})

test('Bash lock pins the shell, runtime and commands; archive integrity is mandatory', async () => {
  const lock = JSON.parse(await readFile(new URL('../resources/bash-runtime/packages.json', import.meta.url), 'utf8'))
  const specs = runtimePackages(lock)
  const names = specs.flatMap(spec => spec.files)
  for (const name of ['bash.exe', 'sh.exe', 'msys-2.0.dll', 'ls.exe', 'cat.exe', 'grep.exe', 'sed.exe', 'awk.exe', 'find.exe']) {
    assert.ok(names.includes(name), name)
  }
  assert.ok(!names.includes('git.exe'))
  assert.throws(() => runtimePackages({ ...lock, extras: ['1-1', '0'.repeat(64), ['../bash.exe']] }), /Invalid Bash package lock/)
  assert.throws(() => runtimePackages({ ...lock, extras: ['1-1', '0'.repeat(64), ['bash.exe']] }), /Duplicate Bash runtime file/)
  const bytes = Buffer.from('fixture')
  const spec = { ...specs[0], sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.doesNotThrow(() => verifyArchive(spec, bytes))
  assert.throws(() => verifyArchive(spec, Buffer.from('different')), /checksum mismatch/)
})
