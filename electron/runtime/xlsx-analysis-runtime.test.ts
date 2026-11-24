import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { XlsxAnalysisRuntime } from './xlsx-analysis-runtime'

const query = { operation: 'xlsx_inspect' } as const
const reply = { result: { operation: 'xlsx_inspect', visibleSheets: 0, omittedSheets: 0, sheets: [] } }
function setup(timeoutMs?: number) {
  const workers: { killed: boolean; reply?: (message: unknown) => void }[] = []
  const runtime = new XlsxAnalysisRuntime(() => {
    const worker: (typeof workers)[number] = { killed: false }
    workers.push(worker)
    return { postMessage() {}, kill() { worker.killed = true }, once() {}, on(_event, reply) { worker.reply = reply } }
  }, timeoutMs)
  return { runtime, workers }
}

test('aborts and kills the worker, ignores late replies, and refuses concurrent memory-heavy parses', async () => {
  const { runtime, workers } = setup()
  const controller = new AbortController()
  const bytes = Buffer.from('workbook')
  const active = runtime.run(bytes, query, controller.signal)
  await assert.rejects(runtime.run(bytes, query), /XLSX_BUSY/)
  controller.abort(new Error('stop requested'))
  await assert.rejects(active, /stop requested/)
  assert.equal(workers[0].killed, true)
  const next = runtime.run(bytes, query)
  workers[0].reply?.(reply)
  workers[1].reply?.(reply)
  assert.deepEqual(await next, reply.result)
  assert.equal(workers[1].killed, true)
})

test('timeout, lifecycle stop, invalid response and wrong response operation do not return results', async () => {
  const { runtime, workers } = setup(10)
  const bytes = Buffer.from('workbook')
  await assert.rejects(runtime.run(bytes, query), /XLSX_TIMEOUT/)
  assert.equal(workers[0].killed, true)
  const active = runtime.run(bytes, query)
  runtime.stop()
  await assert.rejects(active, /XLSX_CANCELLED/)
  const third = runtime.run(bytes, { operation: 'xlsx_read_range', sheet: 'Data', range: 'A1:A1' })
  workers[2].reply?.(reply)
  await assert.rejects(third, /XLSX_WORKER_FAILED/)
  const fourth = runtime.run(bytes, query)
  workers[3].reply?.({ result: { ...reply.result, sheets: ['not a valid sheet'] } })
  await assert.rejects(fourth, /XLSX_WORKER_FAILED/)
  assert.ok(workers.every(worker => worker.killed))
})
