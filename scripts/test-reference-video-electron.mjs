import assert from 'node:assert/strict'
import { log } from 'node:console'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { openAsBlob } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'

if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  const result = await promisify(execFile)(electron, [fileURLToPath(import.meta.url)], {
    windowsHide: true, timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  log(result.stdout.trim())
} else {
  const root = await mkdtemp(join(tmpdir(), 'sep-reference-stream-'))
  const source = join(root, 'reference.mp4')
  const bytes = Buffer.alloc(256 * 1024, 42)
  await writeFile(source, bytes)
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] } }).formData()
    const file = form.get('file')
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
    res.end('ok')
  })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const url = `http://127.0.0.1:${server.address().port}`
    const form = new FormData()
    form.append('file', await openAsBlob(source, { type: 'video/mp4' }), 'reference.mp4')
    const encoded = new Request(url, { method: 'POST', body: form })
    let transferred = 0
    const body = encoded.body.pipeThrough(new TransformStream({ transform(chunk, controller) { transferred += chunk.length; controller.enqueue(chunk) } }))
    const response = await fetch(url, { method: 'POST', headers: encoded.headers, body, duplex: 'half' })
    assert.equal(await response.text(), 'ok')
    assert.ok(transferred > bytes.length)
    log(`Electron ${process.versions.electron} / Node ${process.versions.node}: file-backed multipart streaming passed.`)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}
