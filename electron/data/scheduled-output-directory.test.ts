import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkScheduledOutputPaths, inspectScheduledOutputDirectory, publishScheduledOutputs } from './scheduled-output-directory'

test('publishes approved bytes only, supports reconciliation, and never overwrites a collision', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'csep-scheduled-output-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'work'), output = join(root, 'out')
  await Promise.all([mkdir(workspace), mkdir(output)])
  const file = { id: 'report', path: 'report.txt', format: 'txt', size: 6, sha256: createHash('sha256').update('report').digest('hex'), nodeRunId: 'run', validatedAt: 1 }
  await writeFile(join(workspace, file.path), 'report')
  const destination = await inspectScheduledOutputDirectory(output)
  const upcoming = ['sub/new.txt', 'sub/report.txt']
  const preflight = () => checkScheduledOutputPaths(workspace, upcoming, destination, 'run', 1, () => {})
  await writeFile(join(output, 'report.txt'), 'unrelated')
  await preflight()
  const occupied = join(output, '1970-01-01-0000-run-2-report.txt')
  await writeFile(occupied, 'manual')
  await assert.rejects(preflight(), /同名文件已存在/)
  assert.equal(await readFile(occupied, 'utf8'), 'manual')
  const input = { workspace, destination, files: [file], taskDirectory: workspace, occurrenceId: 'run', scheduledAt: 1, assertCurrent() {} }
  await publishScheduledOutputs(input)
  const name = (await readdir(output)).find(item => item.endsWith('-run-1-report.txt'))
  assert.match(name!, /-run-1-report\.txt$/)
  assert.equal(await readFile(join(output, name!), 'utf8'), 'report')
  await publishScheduledOutputs(input)
  await writeFile(join(output, name!), 'manual')
  await assert.rejects(publishScheduledOutputs(input), /already exists/)
  assert.equal(await readFile(join(output, name!), 'utf8'), 'manual')
  await rename(output, join(root, 'original-directory'))
  await mkdir(output)
  await assert.rejects(publishScheduledOutputs(input), /directory changed/)
  assert.deepEqual(await readdir(output), [])
  assert.equal(await readFile(join(workspace, file.path), 'utf8'), 'report')
})
