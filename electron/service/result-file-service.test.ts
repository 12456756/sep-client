import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { ResultFileService } from './result-file-service'
import type { TaskOwnerScope } from '../data/scope-path'
import type { OpenResultFile } from '../data/result-file-store'

const input = { taskId: 'task', nodeId: 'node', deliverableId: 'file' }
function fixture() {
  let scope: TaskOwnerScope | null = { memberId: 'member', enterpriseId: 'enterprise' }
  let closes = 0
  let changed = false
  const revealed: string[] = []
  const file: OpenResultFile = {
    mime: 'video/mp4', kind: 'video', size: 10,
    async validate() { if (changed) throw new Error('changed') },
    async close() { closes++ },
    stream(start, end, signal, check) { return new ReadableStream({ pull(controller) { signal.throwIfAborted(); check(); controller.enqueue(new TextEncoder().encode('0123456789'.slice(start, end + 1))); controller.close() } }, { highWaterMark: 0 }) },
  }
  const service = new ResultFileService({ scope: { currentScope: () => scope }, store: {
    async open() { return file }, async revealPath() { return '/workspace/final.mp4' },
  }, reveal: path => { revealed.push(path) } })
  return { service, revealed, closes: () => closes, setScope: (next: typeof scope) => { scope = next }, change: () => { changed = true } }
}

test('issues opaque media URLs and serves bounded GET, HEAD and byte ranges', async () => {
  const { service } = fixture()
  const preview = await service.preview(input)
  assert.match(preview.url, /^sep-result:\/\/preview\/[a-f0-9]{64}$/)
  assert.equal(preview.kind, 'video')
  const full = await service.handle(new Request(preview.url))
  assert.equal(full.status, 200); assert.equal(await full.text(), '0123456789')
  for (const [range, expected, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10']]) {
    const response = await service.handle(new Request(preview.url, { headers: { Range: range! } }))
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), contentRange); assert.equal(await response.text(), expected)
  }
  const head = await service.handle(new Request(preview.url, { method: 'HEAD' }))
  assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '')
  assert.equal(head.headers.get('cache-control'), 'no-store')
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=-', 'bytes=-999999999999999999999999999999', 'garbage']) {
    const response = await service.handle(new Request(preview.url, { headers: { Range: range } }))
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */10')
  }
  assert.equal((await service.handle(new Request(preview.url, { method: 'POST' }))).status, 405)
  await service.release({ url: preview.url })
})

test('release and authentication cleanup revoke media access and close handles', async () => {
  const f = fixture(), preview = await f.service.preview(input)
  await f.service.release({ url: preview.url })
  assert.equal(f.closes(), 1); assert.equal((await f.service.handle(new Request(preview.url))).status, 404)
  const next = await f.service.preview(input)
  f.service.clear()
  assert.equal(f.closes(), 2); assert.equal((await f.service.handle(new Request(next.url))).status, 404)
})

test('scope changes and file edits deny requests, including an already created stream', async () => {
  const f = fixture(), preview = await f.service.preview(input)
  f.setScope({ memberId: 'other', enterpriseId: 'enterprise' })
  assert.equal((await f.service.handle(new Request(preview.url))).status, 403)
  assert.equal(f.closes(), 1)
  const edited = fixture(), second = await edited.service.preview(input)
  edited.change()
  assert.equal((await edited.service.handle(new Request(second.url))).status, 403)
  const streaming = fixture(), third = await streaming.service.preview(input)
  const response = await streaming.service.handle(new Request(third.url))
  streaming.setScope(null)
  await assert.rejects(response.arrayBuffer())
})

test('rejects untrusted paths and only reveals a path resolved by the store', async () => {
  const f = fixture()
  await assert.rejects(f.service.reveal({ ...input, path: '/etc/passwd' } as typeof input))
  await f.service.reveal(input)
  assert.deepEqual(f.revealed, ['/workspace/final.mp4'])
  f.setScope(null)
  await assert.rejects(f.service.reveal(input))
  await assert.rejects(f.service.release({ url: 'file:///etc/passwd' }))
})
