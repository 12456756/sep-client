import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createReleaseNotes, MAX_CHANGES_BYTES, parseReleaseNotesArguments } from './generate-release-notes.mjs'

const script = fileURLToPath(new URL('./generate-release-notes.mjs', import.meta.url))
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'sep-notes-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '1.2.3-beta.4' }))
  return cwd
}
function run(cwd, args = [], extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SEP_')))
  return spawnSync(process.execPath, [script, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8' })
}

test('pure release notes preserve SEP Client title and avoid unverified build/signing/publication claims', () => {
  const options = { version: '1.2.3', channel: 'stable', environment: 'production', generatedAt: '2026-10-09T00:00:00.000Z', changes: '- Fixed cancellation.\n' }
  const before = structuredClone(options)
  const notes = createReleaseNotes(options)
  assert.match(notes, /^# SEP Client 1\.2\.3 \(stable\)/)
  assert.match(notes, /说明生成时间：2026-10-09T00:00:00.000Z/)
  assert.match(notes, /Fixed cancellation/)
  assert.match(notes, /未验证/)
  assert.doesNotMatch(notes, /未包含.*签名|构建时间|已签名|已公证|已发布|发布完成|DMG\/ZIP|Windows x64 NSIS/)
  assert.deepEqual(options, before)
  assert.match(createReleaseNotes({ version: '1.2.3', generatedAt: options.generatedAt }), /尚未提供变更清单/)
})

test('pure release notes reject invalid metadata and oversized or binary changes', () => {
  const options = { version: '1.2.3', generatedAt: '2026-10-09T00:00:00.000Z' }
  for (const override of [{ version: '1.2.3\n# injected' }, { channel: 'preview' }, { environment: 'production\ninjected' }, { environment: '' }, { generatedAt: 'invalid' }, { changes: '\0binary' }, { changes: 'a'.repeat(MAX_CHANGES_BYTES + 1) }]) {
    assert.throws(() => createReleaseNotes({ ...options, ...override }))
  }
})

test('release notes argument parser keeps beta default and rejects conflicting channels and unsupported flags', () => {
  assert.deepEqual(parseReleaseNotesArguments([], {}), { channel: 'beta', outputDir: 'dist', changesFile: undefined })
  assert.equal(parseReleaseNotesArguments([], { SEP_RELEASE_CHANNEL: 'stable' }).channel, 'stable')
  assert.deepEqual(parseReleaseNotesArguments(['beta', 'dist/beta', '--changes-file', 'changes.txt'], { SEP_RELEASE_CHANNEL: 'beta' }), { channel: 'beta', outputDir: 'dist/beta', changesFile: 'changes.txt' })
  assert.equal(parseReleaseNotesArguments(['--changes-file', 'changes.txt'], {}).channel, 'beta')
  assert.throws(() => parseReleaseNotesArguments(['stable'], { SEP_RELEASE_CHANNEL: 'beta' }), /conflict/)
  for (const args of [['invalid'], ['beta', 'dist', 'extra'], ['--unknown'], ['beta', '--changes-file'], ['--changes-file', 'a', '--changes-file', 'b']]) {
    assert.throws(() => parseReleaseNotesArguments(args, {}))
  }
  assert.throws(() => parseReleaseNotesArguments([], { SEP_RELEASE_CHANNEL: 'invalid' }))
})

test('importing release notes is silent and does not read package.json or create dist', t => {
  const cwd = fixture(t)
  writeFileSync(join(cwd, 'package.json'), 'not-json')
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./generate-release-notes.mjs', import.meta.url).href)})`], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout + result.stderr, '')
  assert.deepEqual(readdirSync(cwd), ['package.json'])
})

test('release notes CLI preserves legacy channel/output paths and environment-only selection', t => {
  const cwd = fixture(t)
  assert.equal(run(cwd).status, 0)
  assert.match(readFileSync(join(cwd, 'dist/RELEASE-NOTES-beta.md'), 'utf8'), /SEP Client 1\.2\.3-beta\.4 \(beta\)/)
  assert.equal(run(cwd, ['stable', 'dist/stable']).status, 0)
  assert.match(readFileSync(join(cwd, 'dist/stable/RELEASE-NOTES-stable.md'), 'utf8'), /production/)
  assert.equal(run(cwd, [], { SEP_RELEASE_CHANNEL: 'stable' }).status, 0)
  assert.ok(existsSync(join(cwd, 'dist/RELEASE-NOTES-stable.md')))
})

test('release notes CLI also runs when invoked through a symlink', t => {
  const cwd = fixture(t)
  const entry = join(cwd, 'notes.mjs')
  symlinkSync(script, entry)
  const result = spawnSync(process.execPath, [entry, 'beta'], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(existsSync(join(cwd, 'dist/RELEASE-NOTES-beta.md')))
})

test('release notes CLI reads bounded UTF-8 changes without altering source files', t => {
  const cwd = fixture(t)
  const changes = '- 修复取消流程。\n- Preserve sessions.\n'
  writeFileSync(join(cwd, 'changes.txt'), changes)
  const before = readFileSync(join(cwd, 'package.json'), 'utf8')
  const result = run(cwd, ['beta', 'out', '--changes-file', 'changes.txt'])
  assert.equal(result.status, 0, result.stderr)
  assert.ok(readFileSync(join(cwd, 'out/RELEASE-NOTES-beta.md'), 'utf8').includes(changes))
  assert.equal(readFileSync(join(cwd, 'package.json'), 'utf8'), before)
  assert.equal(readFileSync(join(cwd, 'changes.txt'), 'utf8'), changes)
})

test('release notes accept exactly 64 KiB and measure multibyte content by UTF-8 bytes', t => {
  const cwd = fixture(t)
  const changes = 'a'.repeat(MAX_CHANGES_BYTES)
  writeFileSync(join(cwd, 'changes.txt'), changes)
  assert.equal(run(cwd, ['beta', 'out', '--changes-file', 'changes.txt']).status, 0)
  assert.ok(readFileSync(join(cwd, 'out/RELEASE-NOTES-beta.md'), 'utf8').includes(changes))
  writeFileSync(join(cwd, 'changes.txt'), '修'.repeat(Math.floor(MAX_CHANGES_BYTES / 3) + 1))
  assert.equal(run(cwd, ['stable', 'rejected', '--changes-file', 'changes.txt']).status, 1)
  assert.equal(existsSync(join(cwd, 'rejected')), false)
})

test('release notes reject oversized, malformed UTF-8, binary and non-file changes before writing', t => {
  const cwd = fixture(t)
  assert.ok(MAX_CHANGES_BYTES > 0 && MAX_CHANGES_BYTES <= 1024 * 1024)
  for (const content of [Buffer.alloc(MAX_CHANGES_BYTES + 1, 'a'), Buffer.from([0xc3, 0x28]), Buffer.from('binary\0data'), Buffer.from('\x1b[31msecret')]) {
    writeFileSync(join(cwd, 'changes.txt'), content)
    const result = run(cwd, ['beta', 'out', '--changes-file', 'changes.txt'])
    assert.equal(result.status, 1)
    assert.equal(existsSync(join(cwd, 'out')), false)
  }
  for (const path of ['.', 'missing.txt']) {
    assert.equal(run(cwd, ['beta', 'out', '--changes-file', path]).status, 1)
    assert.equal(existsSync(join(cwd, 'out')), false)
  }
})

test('release notes failures redact arguments, environment, paths and JSON details', t => {
  const cwd = fixture(t)
  const secret = 'PRIVATE-TOKEN-DO-NOT-PRINT'
  for (const [args, env] of [[[secret], {}], [['beta'], { SEP_RELEASE_CHANNEL: secret }], [['stable'], { SEP_RELEASE_CHANNEL: 'beta' }], [['beta', 'out', '--changes-file', secret], {}], [[], { SEP_RELEASE_ENVIRONMENT: `${secret}\n` }]]) {
    const result = run(cwd, args, env)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stderr, new RegExp(secret))
    assert.doesNotMatch(result.stderr, /\n\s+at |file:\/\//)
    assert.equal(existsSync(join(cwd, 'dist')), false)
  }
  writeFileSync(join(cwd, 'package.json'), secret)
  const result = run(cwd)
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, new RegExp(secret))
})
