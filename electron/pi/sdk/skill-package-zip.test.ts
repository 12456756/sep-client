import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maxSkillEntryBytes } from '../../common/platform/skill-artifact-contract'
import { packageCrc32, packageSha256, readSkillZip, maxSkillPackageExpandedBytes, packageCache, packageManifestName, verifyPackageCache } from './skill-package-zip'
import { zipFixture, zipDescriptor } from './skill-package-zip.fixture'

const entry = { path: 'SKILL.md', bytes: Buffer.from('---\nname: orders\ndescription: Orders\n---\n# Work') }
const guide = { path: 'references/guide.md', bytes: Buffer.from('Guide') }

describe('bounded authenticated ZIP reader', () => {
  it('matches known CRC32 and preserves store/deflate/descriptor/directory contents', () => {
    assert.equal(packageCrc32(Buffer.from('123456789')), 0xcbf43926)
    for (const deflate of [false, true]) for (const descriptor of [false, true]) {
      const files = [entry, { path: 'references/', bytes: Buffer.alloc(0) }, guide]
      const bytes = zipFixture(files, { deflate, descriptor })
      assert.deepEqual(readSkillZip(bytes, zipDescriptor(bytes, files)), [entry, { path: 'references', bytes: Buffer.alloc(0), directory: true }, guide])
    }
  })

  for (const path of ['../escape', '/absolute', 'C:/escape', 'a\\b', 'a//b', './a', 'a/../b', 'a/./b', 'a\u0000b', 'a\nb', 'a\u007fb',
    'a/．．/b', 'a/／b', 'a/CON.txt', 'a/COM¹.txt', 'a/ＣＯＭ１', 'a/ｎｕｌ.txt', 'a?', 'a|', 'a＜', 'a.', 'a/\u202efile', '.sep-package-manifest.json']) {
    it('rejects unsafe package path ' + JSON.stringify(path), () => {
      const files = [entry, { path, bytes: Buffer.from('x') }]
      const bytes = zipFixture(files)
      assert.throws(() => readSkillZip(bytes, zipDescriptor(bytes, files)), /unsafe/)
    })
  }

  for (const paths of [
    ['references/a.md', 'references/a.md'], ['references/a.md', 'references/A.md'], ['references/a.md', 'references/ａ.md'],
    ['references/a.md', 'References/b.md'], ['scripts', 'scripts/run.py'], ['extra/SKILL.md'], ['skill.md'],
  ]) {
    it('rejects duplicate, normalization, parent and entry collisions: ' + paths.join(', '), () => {
      const files = [entry, ...paths.map(path => ({ path, bytes: Buffer.from('x') }))]
      const bytes = zipFixture(files)
      assert.throws(() => readSkillZip(bytes, zipDescriptor(bytes, files)), /unsafe/)
    })
  }

  it('rejects links and special filesystem node types', () => {
    for (const mode of [0xa1ff, 0x21ff, 0x11ff, 0x61ff]) {
      const files = [entry]
      const bytes = zipFixture(files, { mode })
      assert.throws(() => readSkillZip(bytes, zipDescriptor(bytes, files)), /unsafe/)
    }
  })

  it('rejects count, artifact and entry mismatches; approval-body identity is validated by the installer', () => {
    const files = [entry, guide]
    const bytes = zipFixture(files)
    const artifact = zipDescriptor(bytes, files)
    for (const override of [{ fileCount: 1 }, { byteLength: bytes.length + 1 }, { artifactSha256: 'a'.repeat(64) },
      { entrySha256: 'a'.repeat(64) }, { entryPath: 'other/SKILL.md' }]) {
      assert.throws(() => readSkillZip(bytes, { ...artifact, ...override }), /unsafe/)
    }
    assert.deepEqual(readSkillZip(bytes, { ...artifact, approvedContentSha256: 'a'.repeat(64) }), files)
  })

  it('rejects CRC, central/local identity, encryption, unsupported codecs, split disks, overlap and truncated bytes', () => {
    const files = [entry, guide]
    const base = zipFixture(files)
    const central = base.readUInt32LE(base.length - 6)
    const end = base.length - 22
    const mutations: Array<(bytes: Buffer) => void> = [
      bytes => { bytes[30 + Buffer.byteLength(entry.path)] ^= 1 },
      bytes => { bytes[30] ^= 1 },
      bytes => { bytes.writeUInt16LE(1, central + 8) },
      bytes => { bytes.writeUInt16LE(12, central + 10) },
      bytes => { bytes.writeUInt16LE(1, end + 4) },
      bytes => { bytes.writeUInt16LE(1, central + 34) },
      bytes => { bytes.writeUInt32LE(0xffffffff, central + 24) },
      bytes => { bytes.writeUInt32LE(1, central + 42) },
      bytes => { bytes.writeUInt32LE(0, central + 46 + Buffer.byteLength(entry.path) + 42) },
      bytes => { bytes.writeUInt16LE(3, end + 10) },
    ]
    for (const mutate of mutations) {
      const bytes = Buffer.from(base)
      mutate(bytes)
      assert.throws(() => readSkillZip(bytes, { ...zipDescriptor(base, files), artifactSha256: packageSha256(bytes) }), /unsafe/)
    }
    const truncated = base.subarray(0, base.length - 1)
    assert.throws(() => readSkillZip(truncated, zipDescriptor(truncated, files)), /unsafe/)
  })

  it('enforces file count, per-entry and total inflation budgets before publication', () => {
    for (const files of [
      [entry, ...Array.from({ length: 500 }, (_, i) => ({ path: `files/${i}`, bytes: Buffer.alloc(0) }))],
      [{ ...entry, bytes: Buffer.alloc(maxSkillEntryBytes + 1) }],
      [entry, { path: 'huge.bin', bytes: Buffer.alloc(maxSkillPackageExpandedBytes) }],
    ]) {
      const bytes = zipFixture(files, { deflate: true })
      assert.throws(() => readSkillZip(bytes, zipDescriptor(bytes, files)), /unsafe/)
    }
  })

  it('checks empty directories, complete inventory, manifest tampering and attachment/ancestor symlinks', async t => {
    const root = await mkdtemp(join(tmpdir(), 'sep-zip-cache-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const directory = join(root, 'package')
    const files = [entry, guide, { path: 'output/empty', bytes: Buffer.alloc(0), directory: true as const }]
    const manifest = Buffer.from(JSON.stringify(packageCache(files, entry.path)))
    await mkdir(join(directory, 'references'), { recursive: true })
    await mkdir(join(directory, 'output/empty'), { recursive: true })
    await writeFile(join(directory, entry.path), entry.bytes)
    await writeFile(join(directory, guide.path), guide.bytes)
    const manifestPath = join(directory, packageManifestName)
    await writeFile(manifestPath, manifest)
    const verify = () => verifyPackageCache(join(directory, entry.path), manifest)
    assert.doesNotThrow(verify)
    await writeFile(join(directory, 'unexpected'), 'extra')
    assert.throws(verify, /unsafe/)
    await rm(join(directory, 'unexpected'))
    await writeFile(manifestPath, '{}')
    assert.throws(verify, /unsafe/)
    await writeFile(manifestPath, manifest)
    await rm(join(directory, guide.path))
    await symlink(join(directory, entry.path), join(directory, guide.path))
    assert.throws(verify, /unsafe/)
    await rm(join(directory, guide.path))
    await writeFile(join(directory, guide.path), guide.bytes)
    await symlink(directory, join(root, 'alias'))
    assert.throws(() => verifyPackageCache(join(root, 'alias/SKILL.md'), manifest), /unsafe/)
    await rm(join(directory, 'output/empty'), { recursive: true })
    assert.throws(verify, /unsafe/)
  })
})
