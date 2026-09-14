/**
 * 原子写与恢复语义的回归测试。
 *
 * 方案要求归并三套原子写时**保留 task-store 的 `.bak` + quarantine 语义为默认行为**
 * 这些行为是数据层所有 JSON 存储共同依赖的持久化约束。
 */
import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  backupPath,
  pathExists,
  readJsonFile,
  readJsonWithBackup,
  writeJsonAtomic,
} from './atomic-file'

const directories: string[] = []

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sep-atomic-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** 只接受形如 `{ ok: true }` 的内容，其余当不可信。 */
function parseOk(value: unknown): { ok: true; n: number } | null {
  const record = value as { ok?: unknown; n?: unknown }
  return record?.ok === true && typeof record.n === 'number' ? { ok: true, n: record.n } : null
}

describe('writeJsonAtomic', () => {
  it('creates the file and its parent directories', async () => {
    const file = join(await workDir(), 'nested', 'deep', 'value.json')
    await writeJsonAtomic(file, { ok: true, n: 1 })
    assert.deepEqual(await readJsonFile(file), { ok: true, n: 1 })
  })

  it('keeps the previous content in .bak by default', async () => {
    const file = join(await workDir(), 'value.json')
    await writeJsonAtomic(file, { ok: true, n: 1 })
    await writeJsonAtomic(file, { ok: true, n: 2 })

    assert.deepEqual(await readJsonFile(file), { ok: true, n: 2 })
    assert.deepEqual(await readJsonFile(backupPath(file)), { ok: true, n: 1 })
  })

  it('writes no .bak when backup is turned off', async () => {
    const file = join(await workDir(), 'value.json')
    await writeJsonAtomic(file, { ok: true, n: 1 }, { backup: false })
    await writeJsonAtomic(file, { ok: true, n: 2 }, { backup: false })
    assert.equal(await pathExists(backupPath(file)), false)
  })

  it('leaves no temporary files behind', async () => {
    const dir = await workDir()
    await writeJsonAtomic(join(dir, 'value.json'), { ok: true, n: 1 })
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
  })
})

describe('readJsonWithBackup', () => {
  it('returns null when neither the file nor its backup exists', async () => {
    const file = join(await workDir(), 'missing.json')
    assert.equal(await readJsonWithBackup(file, parseOk), null)
  })

  it('recovers from .bak when the primary file is corrupt, and repairs it', async () => {
    const file = join(await workDir(), 'value.json')
    await writeJsonAtomic(file, { ok: true, n: 1 })
    await writeJsonAtomic(file, { ok: true, n: 2 }) // 现在 .bak 里是 n:1
    await writeFile(file, 'not json at all', 'utf8')

    assert.deepEqual(await readJsonWithBackup(file, parseOk), { ok: true, n: 1 })
    // 恢复之后主文件必须被修好，否则每次读都要走一遍回退。
    assert.deepEqual(await readJsonFile(file), { ok: true, n: 1 })
  })

  it('treats content that fails parse as unreadable, not as data', async () => {
    const file = join(await workDir(), 'value.json')
    // 合法 JSON，但不是我们要的形状——不能就这么交给调用方。
    await writeFile(file, JSON.stringify({ ok: false }), 'utf8')
    assert.equal(await readJsonWithBackup(file, parseOk), null)
  })

  it('quarantines the file when nothing can be recovered', async () => {
    const dir = await workDir()
    const file = join(dir, 'value.json')
    await writeFile(file, 'broken', 'utf8')

    assert.equal(await readJsonWithBackup(file, parseOk), null)

    const quarantined = (await readdir(dir)).filter(name => name.includes('.corrupt-store-'))
    assert.equal(quarantined.length, 1, '损坏文件必须被隔离保留，供排查')
    assert.equal(await readFile(join(dir, quarantined[0]!), 'utf8'), 'broken')
    assert.equal(await pathExists(file), false, '隔离之后原路径不该还留着坏文件')
  })

  it('quarantines a corrupt backup when the primary is missing', async () => {
    const dir = await workDir()
    const file = join(dir, 'value.json')
    await writeFile(backupPath(file), 'broken', 'utf8')

    assert.equal(await readJsonWithBackup(file, parseOk), null)
    assert.equal((await readdir(dir)).filter(name => name.includes('.corrupt-backup-')).length, 1)
  })
})

