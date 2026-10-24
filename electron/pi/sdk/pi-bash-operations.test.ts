import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEncodingBashOperations } from './pi-bash-operations'
import { encodingToolDefinitions } from './pi-text-tools'
import { utf8ChildEnvironment } from './pi-text-encoding'

function command(code: string): string {
  const script = Buffer.from(code).toString('base64')
  return `"${process.execPath.replaceAll('\\', '/')}" -e "eval(Buffer.from('${script}','base64').toString())"`
}

describe('encoding bash operations using real child processes', () => {
  it('normalizes legacy bytes and preserves unrecovered output without re-executing commands', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'pi-bash-encoding-'))
    try {
      const chunks: Buffer[] = []
      const result = await createEncodingBashOperations().exec(command(`
        require('fs').appendFileSync('count.txt', '1');
        process.stdout.write(Buffer.from('d6d0cec4b2e2cad4'.repeat(10) + '0a', 'hex'));
        setTimeout(() => process.stdout.write(Buffer.from([0xff,0x81,10])), 100);
      `), cwd, { onData: chunk => chunks.push(chunk), env: utf8ChildEnvironment(process.env) })
      assert.equal(result.exitCode, 0)
      assert.equal(Buffer.concat(chunks).toString('utf8'), '\u4e2d\u6587\u6d4b\u8bd5'.repeat(10) + '\n\ufffd\ufffd\n')
      assert.equal(await readFile(join(cwd, 'count.txt'), 'utf8'), '1')
    } finally { await rm(cwd, { recursive: true, force: true }) }
  })

  it('isolates stdout/stderr UTF-8 fragments and emits updates before command completion', async () => {
    const chunks: Buffer[] = []
    let completed = false
    let observedBeforeCompletion = false
    const pending = createEncodingBashOperations().exec(command(`
      process.stdout.write('start\\n');
      setTimeout(() => process.stdout.write(Buffer.from([0xe4])), 100);
      setTimeout(() => process.stderr.write('stderr\\n'), 200);
      setTimeout(() => process.stdout.write(Buffer.from([0xb8,0xad])), 300);
      setTimeout(() => process.stdout.write('end\\n'), 400);
    `), process.cwd(), { onData: chunk => { chunks.push(chunk); observedBeforeCompletion ||= !completed }, env: process.env })
    const result = await pending.finally(() => { completed = true })
    assert.ok(observedBeforeCompletion)
    assert.equal(result.exitCode, 0)
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'start\n\u4e2dstderr\nend\n')
  })

  it('retains nonzero exit codes, timeout, cancellation and invalid-timeout behavior', async () => {
    const operations = createEncodingBashOperations()
    assert.equal((await operations.exec(command('process.exit(7)'), process.cwd(), { onData() {} })).exitCode, 7)
    for (const timeout of [0, -1, NaN, Infinity, 3_000_000]) {
      await assert.rejects(operations.exec('unused', process.cwd(), { onData() {}, timeout }), /Invalid timeout/)
    }
    await assert.rejects(operations.exec(command('setInterval(()=>{},1000)'), process.cwd(), {
      onData() {}, timeout: 0.8,
    }), /timeout:0.8/)
    const controller = new AbortController()
    await assert.rejects(operations.exec(command("process.stdout.write('ready');setInterval(()=>{},1000)"), process.cwd(), {
      onData() { controller.abort() }, signal: controller.signal,
    }), /aborted/)
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await assert.rejects(operations.exec('unused', process.cwd(), { onData() {}, signal: alreadyAborted.signal }), /aborted/)
    await assert.rejects(operations.exec('unused', join(tmpdir(), 'missing-encoding-cwd', 'none'), { onData() {} }), /Working directory/)
  })

  it('preserves SDK truncation, temp output and failure formatting', async () => {
    const tool = encodingToolDefinitions(process.cwd()).find(tool => tool.name === 'bash')!
    const result = await tool.execute('call', { command: command("process.stdout.write('row\\n'.repeat(6000))") }, undefined, undefined, undefined as never)
    const details = result.details as { fullOutputPath: string; truncation: { truncated: boolean } }
    assert.equal(details.truncation.truncated, true)
    try { assert.equal(await readFile(details.fullOutputPath, 'utf8'), 'row\n'.repeat(6000)) }
    finally { await rm(details.fullOutputPath, { force: true }) }
    await assert.rejects(tool.execute('call', { command: command("process.stdout.write('failed');process.exit(3)") }, undefined, undefined, undefined as never), /failed\n\nCommand exited with code 3/)
  })
})
