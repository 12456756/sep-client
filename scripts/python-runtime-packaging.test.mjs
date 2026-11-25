import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { pythonRelease, verifyPythonArchive } from './python-runtime-packaging.mjs'

test('Python release pins the Windows and both macOS payloads', async () => {
  for (const target of ['win32-x64', 'darwin-x64', 'darwin-arm64']) {
    const spec = pythonRelease(target)
    assert.match(spec.python.version, /^3\.15\.\d+$/)
    assert.match(spec.archive, /^wasmtime-.+\.(?:zip|tar\.xz)$/)
    for (const asset of [spec, spec.python]) {
      assert.match(asset.sha256, /^[a-f0-9]{64}$/)
      assert.ok(asset.size > 0)
    }
    assert.equal(spec.executable, target === 'win32-x64' ? 'wasmtime.exe' : 'wasmtime')
  }
  assert.notEqual(pythonRelease('darwin-x64').archive, pythonRelease('darwin-arm64').archive)
  assert.equal(pythonRelease('win32-arm64'), undefined)
  const hook = await readFile(new URL('./speech-after-pack.cjs', import.meta.url), 'utf8')
  assert.match(hook, /python-runtime-packaging\.mjs.+afterPythonRuntimePack/)
})

test('archive integrity requires the exact length and checksum', () => {
  const bytes = Buffer.from('example archive')
  const spec = { archive: 'example', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.doesNotThrow(() => verifyPythonArchive(spec, bytes))
  assert.throws(() => verifyPythonArchive(spec, Buffer.alloc(bytes.length)), /SHA-256 mismatch/)
  assert.throws(() => verifyPythonArchive(spec, bytes.subarray(1)), /SHA-256 mismatch/)
})
