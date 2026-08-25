import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertPackageRefMatchesVersion,
  assertZipFallbackInstallable,
  runtimeTestInternals,
  SubscriptionRuntimeManager,
} from './subscription-runtime'
import type { PackageInfo } from '../auth/auth-api'

const temporaryDirectories: string[] = []

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sep-client-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function packageInfo(overrides: Partial<PackageInfo>): PackageInfo {
  return { version: '1.2.3', packageRef: null, zipAvailable: false, sha256: null, ...overrides }
}

describe('SubscriptionRuntime package validation', () => {
  it('requires npm package refs to use the locked exact version', () => {
    assert.doesNotThrow(() => assertPackageRefMatchesVersion(packageInfo({ packageRef: { type: 'npm', spec: '@sep/employee-commerce@1.2.3' } })))
    assert.throws(
      () => assertPackageRefMatchesVersion(packageInfo({ packageRef: { type: 'npm', spec: '@sep/employee-commerce@^1.2.3' } })),
      /non-pinned npm package reference/,
    )
    assert.throws(
      () => assertPackageRefMatchesVersion(packageInfo({ packageRef: { type: 'npm', spec: '@sep/employee-commerce@1.2.4' } })),
      /does not match the locked package version/,
    )
  })

  it('requires git package refs to include an immutable commit', () => {
    assert.doesNotThrow(() => assertPackageRefMatchesVersion(packageInfo({
      packageRef: { type: 'git', spec: 'https://example.test/repo.git#0123456789abcdef0123456789abcdef01234567' },
    })))
    assert.throws(
      () => assertPackageRefMatchesVersion(packageInfo({ packageRef: { type: 'git', spec: 'https://example.test/repo.git#main' } })),
      /without an immutable commit/,
    )
  })

  it('requires ZIP fallback packages to carry SHA-256', () => {
    assert.doesNotThrow(() => assertZipFallbackInstallable(packageInfo({ zipAvailable: true, sha256: 'a'.repeat(64) })))
    assert.throws(() => assertZipFallbackInstallable(packageInfo({ zipAvailable: true })), /must provide SHA-256/)
    assert.throws(() => assertZipFallbackInstallable(packageInfo({ zipAvailable: false })), /no installable package reference or ZIP fallback/)
  })

  it('hashes installed package contents beyond package metadata', async () => {
    const root = await makeDirectory()
    await writeFile(join(root, 'package.json'), '{"name":"employee"}')
    const first = await runtimeTestInternals.hashPackageFiles(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'index.js'), 'export const value = 1')
    const second = await runtimeTestInternals.hashPackageFiles(root)
    assert.notEqual(first, second)
  })

  it('accepts ordinary ZIP entries and rejects unsafe archive content', () => {
    assert.doesNotThrow(() => runtimeTestInternals.assertSafeZipEntries(['package/', 'package/index.js']))
    assert.doesNotThrow(() => runtimeTestInternals.assertSafeZipMetadata([
      '-rw-r--r--  3.0 unx        2 tx        2 stor 26-Aug-24 21:10 package/index.js',
      'drwxr-xr-x  3.0 unx        0 bx        0 stor 26-Aug-24 21:10 package/',
    ].join('\n')))
    assert.throws(() => runtimeTestInternals.assertSafeZipEntries(['../escape']), /unsafe path/)
    assert.throws(() => runtimeTestInternals.assertSafeZipEntries(['/absolute']), /unsafe path/)
    assert.throws(() => runtimeTestInternals.assertSafeZipEntries(['C:\\escape']), /unsafe path/)
    assert.throws(() => runtimeTestInternals.assertSafeZipMetadata(
      'lrwxr-xr-x  3.0 unx        4 bx        4 stor 26-Aug-24 21:10 link',
    ), /link or special file/)
    assert.throws(() => runtimeTestInternals.assertSafeZipMetadata(
      '-rw-r--r--  3.0 unx  104857601 bx        4 stor 26-Aug-24 21:10 huge',
    ), /uncompressed size limit/)
  })
})

describe('SubscriptionRuntime cache selection', () => {
  it('treats skill version changes as a cache miss', () => {
    assert.equal(runtimeTestInternals.sameSkillSelection(
      [{ skillVersionId: 'sv_1', capabilityId: 'cap_1', version: '1.0.0', path: 'skills/a/SKILL.md' }],
      [{ skillVersionId: 'sv_1', capabilityId: 'cap_1', capabilityName: 'a', capabilityDescription: null, version: '1.0.0' }],
    ), true)
    assert.equal(runtimeTestInternals.sameSkillSelection(
      [{ skillVersionId: 'sv_1', capabilityId: 'cap_1', version: '1.0.0', path: 'skills/a/SKILL.md' }],
      [{ skillVersionId: 'sv_2', capabilityId: 'cap_1', capabilityName: 'a', capabilityDescription: null, version: '1.1.0' }],
    ), false)
  })

  it('clears runtime directories by enterprise and subscription', async () => {
    const userDataDir = await makeDirectory()
    const manager = new SubscriptionRuntimeManager(userDataDir, 'test')
    const first = join(userDataDir, 'runtime', 'ent_1', 'sub_1', '1.0.0')
    const second = join(userDataDir, 'runtime', 'ent_2', 'sub_1', '1.0.0')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, 'runtime-manifest.json'), '{}')
    await writeFile(join(second, 'runtime-manifest.json'), '{}')

    await manager.clear('sub_1', 'ent_1')

    await assert.rejects(() => readFile(join(first, 'runtime-manifest.json')))
    assert.equal(await readFile(join(second, 'runtime-manifest.json'), 'utf8'), '{}')

    await manager.clear('sub_1')

    await assert.rejects(() => readFile(join(second, 'runtime-manifest.json')))
  })
})
