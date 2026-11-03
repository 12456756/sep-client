import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocumentPreviewRuntime, type DocumentPreviewWorker } from './document-preview-runtime'
import { toEnvelope } from '../errors/error-mapper'

function setup(timeoutMs = 1000) {
  const workers: { receive: (value: unknown) => void; exit: () => void; killed: boolean; input?: unknown }[] = []
  const runtime = new DocumentPreviewRuntime(() => {
    const worker: (typeof workers)[number] = { receive: (_value: unknown) => undefined, exit: () => undefined, killed: false, input: undefined }
    workers.push(worker)
    return {
      postMessage: value => { worker.input = value },
      kill: () => { worker.killed = true },
      on: (_event, listener) => { worker.receive = listener },
      once: (_event, listener) => { worker.exit = listener },
    } satisfies DocumentPreviewWorker
  }, timeoutMs)
  return { runtime, workers }
}

test('conversion workers run serially, return validated results and dispose after each preview', async () => {
  const { runtime, workers } = setup()
  const first = runtime.render('md', Buffer.from('first'))
  const second = runtime.render('txt', Buffer.from('second'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workers.length, 1)
  workers[0].receive({ kind: 'markdown', text: 'first' })
  assert.deepEqual(await first, { kind: 'markdown', text: 'first' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(workers.length, 2)
  assert.equal(workers[0].killed, true)
  workers[1].receive({ kind: 'text', text: 'second' })
  await second
  assert.equal(workers[1].killed, true)
})

test('worker errors and crashes reject only preview and the queue remains usable', async () => {
  const { runtime, workers } = setup()
  const invalid = runtime.render('docx', Buffer.from('broken'))
  const rejected = assert.rejects(invalid)
  await new Promise(resolve => setImmediate(resolve))
  workers[0].receive({ error: true })
  await rejected
  const crashed = runtime.render('xlsx', Buffer.from('broken'))
  const crashRejected = assert.rejects(crashed)
  await new Promise(resolve => setImmediate(resolve))
  workers[1].exit()
  await crashRejected
  const good = runtime.render('txt', Buffer.from('ok'))
  await new Promise(resolve => setImmediate(resolve))
  workers[2].receive({ kind: 'text', text: 'ok' })
  assert.equal((await good).kind, 'text')
})

test('conversion timeout kills the isolated process without affecting task execution', async () => {
  const { runtime, workers } = setup(10)
  await assert.rejects(runtime.render('xlsx', Buffer.from('slow')), error => {
    assert.equal(toEnvelope(error, { feedbackOperation: 'documentPreview' }).message,
      '文档转换时间过长，暂时无法预览，请稍后重试或打开原文件。')
    return true
  })
  assert.equal(workers[0].killed, true)
})

test('known worker failure reasons survive conversion and unknown diagnostics stay private', async () => {
  const { runtime, workers } = setup()
  const limited = assert.rejects(runtime.render('xlsx', Buffer.from('large')), error => {
    assert.equal(toEnvelope(error, { feedbackOperation: 'documentPreview' }).message,
      'Excel 内容较多，超过 10 万单元格的预览上限，请复制文件路径后使用本地表格软件打开。')
    return true
  })
  await new Promise(resolve => setImmediate(resolve))
  workers[0].receive({ error: 'SPREADSHEET_TOO_LARGE' })
  await limited
  const invalid = assert.rejects(runtime.render('xlsx', Buffer.from('bad')), error => {
    assert.doesNotMatch(toEnvelope(error, { feedbackOperation: 'documentPreview' }).message, /private|secret/)
    return true
  })
  await new Promise(resolve => setImmediate(resolve))
  workers[1].receive({ error: 'private token /secret' })
  await invalid
})

test('logout cancels both active and queued conversions', async () => {
  const { runtime, workers } = setup()
  const active = assert.rejects(runtime.render('docx', Buffer.from('active')))
  const queued = assert.rejects(runtime.render('docx', Buffer.from('queued')))
  await new Promise(resolve => setImmediate(resolve))
  runtime.stop()
  await active; await queued
  assert.equal(workers.length, 1)
  assert.equal(workers[0].killed, true)
})
