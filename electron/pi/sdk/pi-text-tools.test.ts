import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent'
import { encodingToolDefinitions } from './pi-text-tools'

const chinese = '\u4e2d\u6587\u6d4b\u8bd5'

describe('encoding-compatible Pi tools', () => {
  it('reads legacy text through SDK offset/limit rules without rewriting the file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-encoding-'))
    try {
      const bytes = Buffer.from(('d6d0cec4b2e2cad4'.repeat(10) + '0a').repeat(3), 'hex')
      await writeFile(join(cwd, 'legacy.txt'), bytes)
      const tool = encodingToolDefinitions(cwd).find(tool => tool.name === 'read')!
      const result = await tool.execute('call', { path: 'legacy.txt', offset: 2, limit: 1 }, undefined, undefined, {} as never)
      assert.deepEqual(result.content, [{ type: 'text', text: chinese.repeat(10) + '\n\n[2 more lines in file. Use offset=3 to continue.]' }])
      assert.deepEqual(await readFile(join(cwd, 'legacy.txt')), bytes)
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })

  it('leaves image attachments on the SDK path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-encoding-image-'))
    try {
      await writeFile(join(cwd, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=', 'base64'))
      const tool = encodingToolDefinitions(cwd).find(tool => tool.name === 'read')!
      const result = await tool.execute('call', { path: 'pixel.png' }, undefined, undefined, {} as never)
      const baseline = await createReadToolDefinition(cwd).execute('call', { path: 'pixel.png' }, undefined, undefined, {} as never)
      assert.deepEqual(result, baseline)
      assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /image\/png/)
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })

  it('keeps the original unrecoverable read result and real file errors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-encoding-bad-'))
    try {
      const bytes = Buffer.from([0xff, 0x81, 0x0a])
      await writeFile(join(cwd, 'bad.txt'), bytes)
      const tool = encodingToolDefinitions(cwd).find(tool => tool.name === 'read')!
      const result = await tool.execute('call', { path: 'bad.txt' }, undefined, undefined, {} as never)
      assert.deepEqual(result.content, [{ type: 'text', text: bytes.toString('utf8') }])
      await assert.rejects(tool.execute('call', { path: 'missing.txt' }, undefined, undefined, {} as never))
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(tool.execute('call', { path: 'bad.txt' }, controller.signal, undefined, {} as never), /aborted/i)
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })
})
