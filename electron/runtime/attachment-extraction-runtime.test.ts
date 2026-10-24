import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { AttachmentExtractionRuntime } from './attachment-extraction-runtime'
import type { DocumentPreviewWorker } from './document-preview-runtime'

function setup(timeoutMs = 1000) {
  const workers: { receive: (value: unknown) => void; exit: () => void; killed: boolean; input?: unknown }[] = []
  const runtime = new AttachmentExtractionRuntime(() => {
    const worker: (typeof workers)[number] = { receive: () => undefined, exit: () => undefined, killed: false }
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

const tick = () => new Promise(resolve => setImmediate(resolve))

test('extraction runs serially and validates worker results', async () => {
  const { runtime, workers } = setup()
  const first = runtime.extract('text/plain', Buffer.from('first'))
  const second = runtime.extract('text/plain', Buffer.from('second'))
  await tick()
  assert.equal(workers.length, 1)
  workers[0].receive({ status: 'ready', text: 'first', warnings: [] })
  assert.equal((await first).text, 'first')
  await tick()
  assert.equal(workers[0].killed, true)
  assert.equal(workers.length, 2)
  workers[1].receive({ status: 'ready', text: 42, warnings: [] })
  assert.equal((await second).status, 'failed')
  assert.equal(workers[1].killed, true)
})

test('crash and timeout dispose workers while leaving extraction queue usable', async () => {
  const { runtime, workers } = setup(10)
  const crash = runtime.extract('text/plain', Buffer.from('crash'))
  await tick()
  workers[0].exit()
  assert.equal((await crash).status, 'failed')
  const timeout = await runtime.extract('text/plain', Buffer.from('slow'))
  assert.deepEqual(timeout.warnings, ['EXTRACTION_TIMEOUT'])
  assert.equal(workers[1].killed, true)
  const next = runtime.extract('text/plain', Buffer.from('next'))
  await tick()
  workers[2].receive({ status: 'ready', text: 'next', warnings: [] })
  assert.equal((await next).text, 'next')
})

test('logout cancels active and queued extraction without launching another worker', async () => {
  const { runtime, workers } = setup()
  const active = runtime.extract('text/plain', Buffer.from('active'))
  const queued = runtime.extract('text/plain', Buffer.from('queued'))
  await tick()
  runtime.stop()
  assert.equal((await active).status, 'failed')
  assert.equal((await queued).status, 'failed')
  assert.equal(workers.length, 1)
  assert.equal(workers[0].killed, true)
})

test('worker launch failure becomes an extraction failure and permits retry', async () => {
  const runtime = new AttachmentExtractionRuntime(() => { throw new Error('launch failed') })
  assert.equal((await runtime.extract('text/plain', Buffer.from('file'))).status, 'failed')
  assert.equal((await runtime.extract('text/plain', Buffer.from('retry'))).status, 'failed')
})
