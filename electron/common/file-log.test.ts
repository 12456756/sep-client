import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installFileLogging } from './file-log'
import { logger, setLogSink } from './logger'

test('persists bounded, redacted warning/error diagnostics and rotates old files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sep-error-log-'))
  const restore = setLogSink(() => {})
  const stop = installFileLogging(directory, 8192)
  try {
    logger.child('test').info('business body', { content: 'DO_NOT_PERSIST' })
    for (let index = 0; index < 20; index++) logger.child('test').warn('failure', {
      error: new Error('request failed', { cause: Object.assign(new Error('Bearer PRIVATE_VALUE'), { code: 'ENOTFOUND', refreshToken: 'PRIVATE_VALUE' }) }),
    })
    assert.deepEqual((await readdir(directory)).sort(), ['errors.jsonl', 'errors.jsonl.1', 'errors.jsonl.2'])
    for (const file of await readdir(directory)) assert.ok((await stat(join(directory, file))).size <= 8192)
    const contents = (await Promise.all((await readdir(directory)).map(file => readFile(join(directory, file), 'utf8')))).join('')
    assert.match(contents, /ENOTFOUND/)
    assert.match(contents, /stack/)
    assert.doesNotMatch(contents, /PRIVATE_VALUE|DO_NOT_PERSIST/)
    const before = await readFile(join(directory, 'errors.jsonl'), 'utf8')
    stop()
    logger.child('test').error('after stop')
    assert.equal(await readFile(join(directory, 'errors.jsonl'), 'utf8'), before)
  } finally { stop(); restore(); await rm(directory, { recursive: true, force: true }) }
})

test('an unwritable log destination cannot fail or recurse into a business operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sep-error-log-'))
  const file = join(directory, 'file')
  await writeFile(file, '')
  const records: string[] = []
  const restore = setLogSink(record => { records.push(record.message) })
  const stop = installFileLogging(file)
  try {
    assert.doesNotThrow(() => { logger.child('test').error('first'); logger.child('test').error('second') })
    assert.equal(records.filter(message => message === 'diagnostic file logging unavailable').length, 1)
  } finally { stop(); restore(); await rm(directory, { recursive: true, force: true }) }
})
