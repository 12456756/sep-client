import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { bundledPythonExecutable, PYTHON_CODE_LIMIT, runPython } from './python-runtime'

test('Python runner refuses relative interpreters, oversized scripts, NUL and pre-cancelled calls', async () => {
  const absolutePath = join(tmpdir(), 'unused-python')
  await assert.rejects(runPython('python', 'pass'), /Invalid Python input/)
  await assert.rejects(runPython(absolutePath, 'x'.repeat(PYTHON_CODE_LIMIT + 1)), /Invalid Python input/)
  await assert.rejects(runPython(absolutePath, 'pass\0'), /Invalid Python input/)
  await assert.rejects(runPython(absolutePath, 'pass', AbortSignal.abort()), { name: 'AbortError' })
  await assert.rejects(runPython(absolutePath, 'pass', undefined, { outputs: ['../outside.txt'] }), /Invalid Python input/)
})

const native = bundledPythonExecutable()
test('bundled Python reports exit, bounded UTF-8 output, cancellation and timeout', { skip: !process.env.SEP_PYTHON_DEV_RESOURCES }, async () => {
  assert.ok(native, 'A staged WASI runtime is required when SEP_PYTHON_DEV_RESOURCES is set.')
  const output = await runPython(native, "import os, sys\nassert not os.environ\nprint('\\u6d4b\\u8bd5' + 'x' * 32000)\nprint('failure', file=sys.stderr)\nsys.exit(7)")
  assert.equal(output.status, 'finished')
  assert.equal(output.exitCode, 7)
  assert.ok(output.stdout.startsWith('\u6d4b\u8bd5'))
  assert.match(output.stderr.trim(), /(?:^|\n)failure$/)
  assert.equal(output.truncated, true)
  assert.ok(Buffer.byteLength(output.stdout) <= 16 * 1024)
  const timeout = await runPython(native, 'while True: pass', undefined, { timeoutMs: 100 })
  assert.equal(timeout.status, 'timed-out')
  const controller = new AbortController()
  const pending = runPython(native, 'while True: pass', controller.signal)
  setTimeout(() => controller.abort(), 100)
  assert.equal((await pending).status, 'cancelled')
})

test('bundled Python sees copies only and cannot read or write a host file outside the sandbox', { skip: !process.env.SEP_PYTHON_DEV_RESOURCES }, async () => {
  assert.ok(native)
  const root = await mkdtemp(join(tmpdir(), 'csep-python-test-'))
  try {
    const host = join(root, 'private')
    await mkdir(host)
    const file = join(host, 'secret.txt')
    await writeFile(file, 'unchanged')
    const result = await runPython(native, `
from pathlib import Path
import os, sys
assert sys.platform == 'wasi' and not os.environ
for mode in ('r', 'w'):
    try:
        with open(${JSON.stringify(file.replaceAll('\\', '/'))}, mode): pass
    except OSError: pass
    else: raise AssertionError('Host file was reachable')
assert Path('inputs/source.txt').read_text() == 'copy'
Path('inputs/source.txt').write_text('modified copy')
Path('outputs/result.txt').write_text('success')
`, undefined, { inputs: new Map([['source.txt', Buffer.from('copy')]]), outputs: ['result.txt'] })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.files.get('result.txt'), 'success')
    assert.equal(await readFile(file, 'utf8'), 'unchanged')
  } finally { await rm(root, { recursive: true, force: true }) }
})
