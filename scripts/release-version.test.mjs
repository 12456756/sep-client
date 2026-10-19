import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createReleaseVersionPlan } from './release-version.mjs'

const script = fileURLToPath(new URL('./release-version.mjs', import.meta.url))
function manifests(version = '1.2.3-beta.2') {
  return {
    packageJson: { name: 'sep-client', version },
    packageLock: { version, lockfileVersion: 3, packages: { '': { name: 'sep-client', version } } },
  }
}
function fixture(t, data = manifests()) {
  const cwd = mkdtempSync(join(tmpdir(), 'sep-version-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(data.packageJson))
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(data.packageLock))
  return cwd
}
function run(cwd, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
}

test('pure version plan lists only root version changes and leaves inputs untouched', () => {
  const data = manifests()
  data.packageLock.packages['node_modules/example'] = { version: '9.0.0' }
  const before = structuredClone(data)
  const plan = createReleaseVersionPlan({ ...data, targetVersion: '1.2.3+build.4' })
  assert.deepEqual(plan, {
    dryRun: true,
    currentVersion: '1.2.3-beta.2',
    targetVersion: '1.2.3+build.4',
    changes: [
      { file: 'package.json', field: 'version', from: '1.2.3-beta.2', to: '1.2.3+build.4' },
      { file: 'package-lock.json', field: 'version', from: '1.2.3-beta.2', to: '1.2.3+build.4' },
      { file: 'package-lock.json', field: 'packages[""].version', from: '1.2.3-beta.2', to: '1.2.3+build.4' },
    ],
  })
  assert.deepEqual(data, before)
})

test('version plan requires canonical SemVer and strictly increasing precedence', () => {
  for (const targetVersion of [undefined, null, 123, '', '1.2', 'v1.2.4', '=1.2.4', ' 1.2.4', '1.2.4\n', '01.2.4', '1.2.4-beta.01', '1.2.3-beta.2', '1.2.3-beta.1', '1.2.2', '1.2.3-beta.2+new']) {
    assert.throws(() => createReleaseVersionPlan({ ...manifests(), targetVersion }))
  }
  for (const [from, to] of [['1.2.3-beta.2', '1.2.3-beta.10'], ['1.2.3-beta.10', '1.2.3'], ['1.2.3', '1.2.4-beta.0'], ['1.2.3+old', '1.2.4+new']]) {
    assert.equal(createReleaseVersionPlan({ ...manifests(from), targetVersion: to }).targetVersion, to)
  }
  assert.throws(() => createReleaseVersionPlan({ ...manifests('1.2.3+old'), targetVersion: '1.2.3+new' }))
  assert.throws(() => createReleaseVersionPlan({ ...manifests('v1.2.3'), targetVersion: '1.2.4' }))
})

test('version plan rejects missing or inconsistent lockfile root versions', () => {
  for (const packageLock of [undefined, null, {}, { version: '1.2.3-beta.2' }, { ...manifests().packageLock, version: '1.2.2' }, { version: '1.2.3-beta.2', packages: { '': { version: '1.2.2' } } }]) {
    assert.throws(() => createReleaseVersionPlan({ packageJson: manifests().packageJson, packageLock, targetVersion: '1.2.4' }))
  }
  assert.throws(() => createReleaseVersionPlan({ packageJson: null, packageLock: manifests().packageLock, targetVersion: '1.2.4' }))
})

test('version CLI outputs a dry-run plan without modifying manifests or writing Git/files', t => {
  const cwd = fixture(t)
  const before = ['package.json', 'package-lock.json'].map(file => readFileSync(join(cwd, file), 'utf8'))
  const result = run(cwd, ['1.2.3'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).dryRun, true)
  assert.equal(JSON.parse(result.stdout).targetVersion, '1.2.3')
  assert.deepEqual(readdirSync(cwd).sort(), ['package-lock.json', 'package.json'])
  assert.deepEqual(['package.json', 'package-lock.json'].map(file => readFileSync(join(cwd, file), 'utf8')), before)
})

test('version CLI requires an explicit target and redacts invalid input and malformed files', t => {
  const cwd = fixture(t)
  const secret = 'PRIVATE-TOKEN-DO-NOT-PRINT'
  for (const args of [[], [secret], ['1.2.4', secret], ['--write'], ['patch']]) {
    const result = run(cwd, args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stderr, new RegExp(secret))
    assert.doesNotMatch(result.stderr, /\n\s+at |file:\/\//)
  }
  writeFileSync(join(cwd, 'package-lock.json'), secret)
  const result = run(cwd, ['1.2.4'])
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, new RegExp(secret))
})

test('importing the version module performs no CLI work or filesystem writes', t => {
  const cwd = fixture(t)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./release-version.mjs', import.meta.url).href)})`], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout + result.stderr, '')
  assert.deepEqual(readdirSync(cwd).sort(), ['package-lock.json', 'package.json'])
})

test('version CLI also runs when invoked through a symlink', t => {
  const cwd = fixture(t)
  const entry = join(cwd, 'version.mjs')
  symlinkSync(script, entry)
  const result = spawnSync(process.execPath, [entry, '1.2.4'], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).targetVersion, '1.2.4')
})
