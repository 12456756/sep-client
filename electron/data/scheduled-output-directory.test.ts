import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { checkScheduledOutputPaths, inspectScheduledOutputDirectory, publishScheduledOutputs } from './scheduled-output-directory'

test('publishes only approved bytes, reconciles an existing result, and rejects a replaced directory', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'csep-scheduled-output-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'work'), output = join(root, 'out')
  await Promise.all([mkdir(workspace), mkdir(output)])
  const file = { id: 'report', path: 'report.txt', format: 'txt', size: 6, sha256: createHash('sha256').update('report').digest('hex'), nodeRunId: 'run', validatedAt: 1 }
  await writeFile(join(workspace, file.path), 'report')
  const destination = await inspectScheduledOutputDirectory(output)
  const upcoming = ['sub/new.txt', 'sub/report.txt']
  const preflight = () => checkScheduledOutputPaths(workspace, upcoming, destination, () => {})
  const previousName = '1970-01-01-0000-previous-1-report.txt'
  await writeFile(join(output, previousName), 'historical delivery')
  await preflight()
  const input = { workspace, destination, files: [file], taskDirectory: workspace, occurrenceId: 'run', assertCurrent() {} }
  await assert.rejects(publishScheduledOutputs({ ...input, files: [{ ...file, sha256: '0'.repeat(64) }] }))
  assert.deepEqual(await readdir(output), [previousName])
  await publishScheduledOutputs(input)
  const target = join(output, file.path)
  assert.equal(await readFile(target, 'utf8'), 'report')
  assert.equal(await readFile(join(output, previousName), 'utf8'), 'historical delivery')
  const source = join(workspace, file.path)
  await rename(source, join(workspace, 'relocated.txt'))
  await publishScheduledOutputs(input)
  await rename(join(workspace, 'relocated.txt'), source)
  await writeFile(target, 'manual')
  await assert.rejects(publishScheduledOutputs(input), { reason: 'changed' })
  assert.equal(await readFile(target, 'utf8'), 'manual')
  await rename(output, join(root, 'original-directory'))
  await mkdir(output)
  await assert.rejects(publishScheduledOutputs(input), /directory changed/)
  assert.deepEqual(await readdir(output), [])
  assert.equal(await readFile(join(workspace, file.path), 'utf8'), 'report')
})

async function replacementFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'csep-scheduled-output-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'work'), output = join(root, 'out'), taskDirectory = join(root, 'task')
  await Promise.all([mkdir(workspace), mkdir(output), mkdir(taskDirectory)])
  const destination = await inspectScheduledOutputDirectory(output)
  const path = 'report.txt'
  const deliver = async (body: string, occurrenceId: string, assertCurrent: () => void | Promise<void> = () => {}) => {
    const bytes = Buffer.from(body)
    await writeFile(join(workspace, path), bytes)
    return publishScheduledOutputs({ workspace, destination, taskDirectory, occurrenceId, assertCurrent,
      files: [{ id: 'report', path, format: 'txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), nodeRunId: 'run', validatedAt: 1 }] })
  }
  const backups = async () => (await readdir(output)).filter(name => name.startsWith('CSEP-备份-'))
  return { workspace, output, destination, path, target: join(output, path), deliver, backups }
}

test('publishes by name and keeps an independent backup for each different replaced version', async t => {
  const f = await replacementFixture(t)
  await f.deliver('first', 'first')
  assert.equal(await readFile(f.target, 'utf8'), 'first')
  assert.deepEqual(await f.backups(), [])
  await checkScheduledOutputPaths(f.workspace, ['sub/report.txt'], f.destination, () => {})
  await f.deliver('next!', 'second') // Same-size original exercises backup after hash comparison.
  assert.equal(await readFile(f.target, 'utf8'), 'next!')
  const firstBackup = (await f.backups())[0]!
  assert.equal(await readFile(join(f.output, firstBackup), 'utf8'), 'first')
  await f.deliver('next!', 'second')
  assert.deepEqual(await f.backups(), [firstBackup])
  await f.deliver('third version', 'third')
  await assert.rejects(f.deliver('next!', 'second'), { reason: 'changed' })
  assert.equal(await readFile(f.target, 'utf8'), 'third version')
  assert.deepEqual((await Promise.all((await f.backups()).map(name => readFile(join(f.output, name), 'utf8')))).sort(), ['first', 'next!'])
})

test('never replaces a file if backup creation is interrupted or if the original changes during backup', async t => {
  const f = await replacementFixture(t)
  await writeFile(f.target, 'original bytes')
  const backupStaged = async () => (await readdir(f.output)).filter(name => name.endsWith('.tmp')).length === 2
  await assert.rejects(f.deliver('new', 'cancelled', async () => {
    if (await backupStaged()) throw new Error('stopped before publishing backup')
  }), /stopped before publishing backup/)
  assert.equal(await readFile(f.target, 'utf8'), 'original bytes')
  assert.deepEqual(await readdir(f.output), [f.path])

  let edited = false
  await assert.rejects(f.deliver('new', 'edited', async () => {
    if (!edited && await backupStaged()) {
      edited = true
      await writeFile(f.target, 'concurrent edit')
    }
  }), { reason: 'changed' })
  assert.equal(await readFile(f.target, 'utf8'), 'concurrent edit')
  assert.deepEqual(await readdir(f.output), [f.path])
})

test('replacement rejects ambiguous names and non-regular targets', async t => {
  const f = await replacementFixture(t)
  await assert.rejects(checkScheduledOutputPaths(f.workspace, ['sub/report.txt', 'another/Report.txt'], f.destination, () => {}), /相同的文件名/)
  await mkdir(f.target)
  await assert.rejects(f.deliver('new', 'run'), { reason: 'notFile' })
  assert.deepEqual(await readdir(f.target), [])
  assert.deepEqual(await f.backups(), [])
})

test('an interruption after the backup leaves the original and prevents unsafe replay', async t => {
  const f = await replacementFixture(t)
  const original = 'large original\n'.repeat(20_000)
  await writeFile(f.target, original)
  await assert.rejects(f.deliver('new', 'run', async () => {
    if ((await f.backups()).length) throw new Error('interrupted before replacement')
  }), /interrupted before replacement/)
  assert.equal(await readFile(f.target, 'utf8'), original)
  const [backup] = await f.backups()
  assert.ok(backup)
  assert.equal(await readFile(join(f.output, backup), 'utf8'), original)
  await writeFile(f.target, 'manual edit after interruption')
  await assert.rejects(f.deliver('new', 'run'), { reason: 'changed' })
  assert.equal(await readFile(f.target, 'utf8'), 'manual edit after interruption')
  assert.deepEqual(await f.backups(), [backup])
})
