import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { qqMailCredentialsSchema } from '../../src/shared/connectors'
import { ConnectorStore } from '../data/connector-store'
import { ScopePath, type TaskOwnerScope } from '../data/scope-path'
import { qqMailRequest, qqMailSchema } from './qq-mail-command'
import { QQMailApi, QQMailError } from './qq-mail-api'
import { QQMailWorkspaceRuntime } from './qq-mail-workspace'

const owner = { enterpriseId: 'e', memberId: 'm' }
const credentials = { email: 'sample@qq.com', authorizationCode: 'abcdefghijklmnop' }
const argv = (method: string, data: unknown = {}): string[] => [...method.split('.'), '--json', JSON.stringify(data)]
async function fixture() {
  const base = process.env.CSEP_TEST_TEMP ?? tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'qqmail-'))
  const store = new ConnectorStore(root, { available: () => true, encrypt: v => Buffer.from(v).toString('base64'), decrypt: v => Buffer.from(v, 'base64').toString() }, 'qqmail')
  let scope: TaskOwnerScope | null = owner
  const calls: string[] = []
  const api: Pick<QQMailApi, 'verify' | 'execute'> = {
    verify: async (_credentials, signal) => { signal.throwIfAborted(); calls.push('verify') },
    execute: async (_credentials, request, signal) => { signal.throwIfAborted(); calls.push(request.method); return { email: credentials.email } },
  }
  const runtime = new QQMailWorkspaceRuntime({ store, api, currentScope: () => scope })
  return { root, store, runtime, api, calls, set scope(value: TaskOwnerScope | null) { scope = value } }
}

test('mail credentials and command schemas reject overrides, header injection and stale cursor forms', () => {
  assert.equal(qqMailCredentialsSchema.parse({ ...credentials, email: ' Name@Foxmail.com ' }).email, 'name@foxmail.com')
  for (const value of [{ ...credentials, email: 'a@evil.example' }, { ...credentials, authorizationCode: 'password' }, { ...credentials, host: 'evil' }]) assert.equal(qqMailCredentialsSchema.safeParse(value).success, false)
  for (const method of ['qqmail', 'folder', 'message', 'message.list', 'message.reply', 'message.send']) assert.doesNotThrow(() => JSON.parse(qqMailSchema(method)))
  for (const args of [argv('auth.export'), argv('message.send', { to: ['a@example.com'], subject: 'Hi', text: 'x', from: 'other@qq.com' }), argv('message.send', { to: ['a@example.com\r\nBcc:b@example.com'], subject: 'Hi', text: 'x' }), argv('message.send', { to: ['a@example.com'], subject: 'Hi\r\nBcc:x', text: 'x' }), argv('message.list', { before_uid: 10 }), argv('message.list', { limit: 51 }), argv('message.get', { uid: 1 }), argv('message.get', { uid: 1, uid_validity: '2', folder: 'INBOX\r\n' }), ['message', 'list', '--json', '{}', '--host=evil']]) assert.throws(() => qqMailRequest(args))
})

test('mail login verifies services and saves scoped credentials before exposing a connected state', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner, credentials)
  assert.deepEqual(f.calls, ['verify'])
  assert.equal((await f.runtime.state(owner)).coverage, 'mail')
  assert.equal((await f.runtime.state(owner)).accountLabel, credentials.email)
  assert.doesNotMatch(JSON.stringify(await f.runtime.state(owner)), /abcdefghijklmnop|authorizationCode/)
  const disk = await readFile(join(new ScopePath(f.root).ownerRoot(owner), 'connectors/qqmail.json'), 'utf8')
  assert.doesNotMatch(disk, /abcdefghijklmnop|authorizationCode/)
  assert.equal(await f.store.read({ enterpriseId: 'e', memberId: 'other' }), undefined)
  const command = (await f.runtime.binding(owner))!.commands![0]
  await command.execute(argv('identity.whoami'), '.')
  await f.runtime.disconnect(owner)
  assert.equal((await f.runtime.state(owner)).status, 'disconnected')
  assert.equal((await command.execute(argv('message.list'), '.')).isError, true)
  assert.deepEqual(f.calls, ['verify', 'identity.whoami'])
})

test('disconnect and account cancellation discard delayed verification and invalidate old bindings', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  let finish!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  f.api.verify = async () => { started(); await new Promise<void>(resolve => { finish = resolve }) }
  const pending = assert.rejects(f.runtime.connect(owner, credentials))
  await ready
  assert.equal((await f.runtime.state(owner)).status, 'authorizing')
  const disconnected = f.runtime.disconnect(owner)
  finish(); await pending; await disconnected
  assert.equal(await f.store.read(owner), null)
  f.api.verify = async () => {}
  await f.runtime.connect(owner, credentials)
  const command = (await f.runtime.binding(owner))!.commands![0]
  f.runtime.cancel(); f.scope = null
  assert.equal((await command.execute(argv('message.list'), '.')).isError, true)
  assert.equal((await f.runtime.state(owner)).status, 'disconnected')
  f.scope = owner
  assert.ok(await f.runtime.binding(owner))
  assert.equal((await command.execute(argv('message.list'), '.')).isError, true)
})

test('mail errors redact upstream details, distinguish auth, preserve uncertainty and require secure persistence', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  f.api.verify = async () => { throw Object.assign(new Error(credentials.authorizationCode), { code: 'EAUTH' }) }
  await assert.rejects(f.runtime.connect(owner, credentials), /验证未通过/)
  assert.equal((await f.runtime.state(owner)).status, 'disconnected')
  assert.doesNotMatch(JSON.stringify(await f.runtime.state(owner)), /abcdefghijklmnop/)
  f.api.verify = async () => {}
  await f.runtime.connect(owner, credentials)
  const command = (await f.runtime.binding(owner))!.commands![0]
  f.api.verify = async () => { throw Object.assign(new Error(credentials.authorizationCode), { code: 'EAUTH' }) }
  await assert.rejects(f.runtime.connect(owner, { ...credentials, email: 'wrong@qq.com' }), /验证未通过/)
  assert.equal((await f.runtime.state(owner)).accountLabel, credentials.email)
  assert.equal((await command.execute(argv('identity.whoami'), '.')).isError, false)
  f.api.verify = async () => {}
  f.api.execute = async () => { throw new Error(credentials.authorizationCode) }
  const failure = await command.execute(argv('message.send', { to: ['a@example.com'], subject: 'Test', text: 'Body' }), '.')
  assert.equal(failure.executionUncertain, true)
  assert.doesNotMatch(failure.text, /abcdefghijklmnop/)
  f.api.execute = async () => { throw new QQMailError('auth', '邮箱验证未通过。') }
  assert.equal((await command.execute(argv('message.list'), '.')).executionUncertain, undefined)
  assert.equal(await f.store.read(owner), null)
  const broken = new QQMailWorkspaceRuntime({ currentScope: () => owner, api: f.api, store: { read: async () => null, write: async () => { throw new Error('disk-secret') } } })
  await assert.rejects(broken.connect(owner, credentials), /无法安全保存/)
  assert.equal((await broken.state(owner)).status, 'disconnected')
})

test('mail reports explicit recipient rejections without requiring a message ID', async t => {
  const f = await fixture(); t.after(() => f.runtime.cancel())
  await f.runtime.connect(owner, credentials)
  const command = (await f.runtime.binding(owner))!.commands![0]
  const args = argv('message.send', { to: ['a@example.com', 'b@example.com'], subject: 'Test', text: 'Body' })
  f.api.execute = async () => ({ accepted: ['a@example.com'], rejected: ['b@example.com'], status: 'submitted' })
  const partial = await command.execute(args, '.')
  assert.equal(partial.isError, true)
  assert.equal(partial.executionUncertain, undefined)
  assert.deepEqual(JSON.parse(partial.text).rejected, ['b@example.com'])
  f.api.execute = async () => ({ accepted: ['a@example.com', 'b@example.com'], rejected: [], status: 'submitted' })
  assert.equal((await command.execute(args, '.')).isError, false)
})

async function wireServer(greeting: string, handler: (line: string, socket: Socket) => void) {
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    socket.write(greeting)
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString()
      let at: number
      while ((at = buffer.indexOf('\r\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 2); handler(line, socket) }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return { port: address.port, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

test('real IMAP/SMTP libraries read MIME without Seen, paginate UIDs, thread replies and fix sender', async t => {
  const commands: string[] = []
  const mail = Buffer.from('From: Sender <sender@example.com>\r\nReply-To: reply@example.com\r\nTo: sample@qq.com\r\nSubject: Test mail\r\nMessage-ID: <original@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello mail\r\n--part\r\nContent-Type: text/plain; name="note.txt"\r\nContent-Disposition: attachment; filename="note.txt"\r\n\r\nAttachment\r\n--part--\r\n')
  let validity = '7'
  const imap = await wireServer('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] Fixture\r\n', (line, socket) => {
    commands.push(line)
    const tag = line.split(' ')[0]
    const upper = line.toUpperCase()
    if (upper.includes(' CAPABILITY')) socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n${tag} OK done\r\n`)
    else if (upper.includes(' AUTHENTICATE') || upper.includes(' LOGIN')) socket.write(`${tag} OK authenticated\r\n`)
    else if (upper.includes(' LIST')) socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK done\r\n`)
    else if (upper.includes(' EXAMINE') || upper.includes(' SELECT')) socket.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY ${validity}] valid\r\n* OK [UIDNEXT 501] next\r\n* FLAGS (\\Seen)\r\n${tag} OK [READ-ONLY] done\r\n`)
    else if (upper.includes(' SEARCH')) socket.write(`* SEARCH 499\r\n${tag} OK done\r\n`)
    else if (upper.includes(' FETCH')) {
      if (upper.includes('BODY.PEEK[]')) socket.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID 499 BODY[]<0> {${mail.length}}\r\n`), mail, Buffer.from(`)\r\n${tag} OK done\r\n`)]))
      else socket.write(`* 1 FETCH (UID 499 RFC822.SIZE ${mail.length} FLAGS () ENVELOPE ("Mon, 16 Nov 2026 09:00:00 +0800" "Test mail" (("Sender" NIL "sender" "example.com")) NIL ((NIL NIL "reply" "example.com")) ((NIL NIL "sample" "qq.com")) NIL NIL NIL "<original@example.com>"))\r\n${tag} OK done\r\n`)
    } else if (upper.includes(' LOGOUT')) socket.end(`* BYE\r\n${tag} OK logout\r\n`)
    else socket.write(`${tag} OK done\r\n`)
  })
  const sent: string[] = []
  const envelope: string[] = []
  const dataMode = new Set<Socket>()
  const smtp = await wireServer('220 fixture ESMTP\r\n', (line, socket) => {
    if (dataMode.has(socket)) { if (line === '.') { dataMode.delete(socket); socket.write('250 accepted\r\n') } else sent.push(line); return }
    if (/^EHLO/i.test(line)) socket.write('250-fixture\r\n250 AUTH PLAIN\r\n')
    else if (/^AUTH/i.test(line)) socket.write('235 authenticated\r\n')
    else if (/^(MAIL FROM|RCPT TO)/i.test(line)) { envelope.push(line); socket.write('250 OK\r\n') }
    else if (/^DATA/i.test(line)) { dataMode.add(socket); socket.write('354 continue\r\n') }
    else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n')
    else socket.write('250 OK\r\n')
  })
  t.after(async () => { await imap.close(); await smtp.close() })
  const api = new QQMailApi({
    imap: () => new ImapFlow({ host: '127.0.0.1', port: imap.port, secure: false, auth: { user: credentials.email, pass: credentials.authorizationCode }, logger: false, disableAutoIdle: true }),
    smtp: () => nodemailer.createTransport({ host: '127.0.0.1', port: smtp.port, secure: false, auth: { user: credentials.email, pass: credentials.authorizationCode } }),
  })
  const signal = AbortSignal.timeout(15000)
  await api.verify(credentials, signal)
  const list = await api.execute(credentials, qqMailRequest(argv('message.search', { query: 'Hello', unread: true })), signal) as { uid_validity: string; messages: { uid: number }[]; next_before_uid: number }
  assert.equal(list.uid_validity, '7'); assert.equal(list.messages[0].uid, 499); assert.equal(list.next_before_uid, 301)
  assert.ok(commands.some(v => /UID SEARCH.*UID 301:500.*TEXT/i.test(v)))
  const detail = await api.execute(credentials, qqMailRequest(argv('message.get', { uid: 499, uid_validity: '7' })), signal) as { text: string; attachments: { filename: string }[] }
  assert.match(detail.text, /Hello mail/); assert.equal(detail.attachments[0].filename, 'note.txt')
  assert.ok(commands.some(v => /BODY.PEEK\[\]/.test(v)))
  assert.ok(commands.every(v => !/ STORE | SELECT /i.test(v)))
  await assert.rejects(api.execute(credentials, qqMailRequest(argv('message.reply', { uid: 499, uid_validity: '7', to: ['wrong@example.com'], text: 'Reply body' })), signal), /不一致/)
  assert.equal(envelope.length, 0)
  await api.execute(credentials, qqMailRequest(argv('message.reply', { uid: 499, uid_validity: '7', to: ['reply@example.com'], text: 'Reply body' })), signal)
  assert.ok(envelope.includes('MAIL FROM:<sample@qq.com>')); assert.ok(envelope.includes('RCPT TO:<reply@example.com>'))
  assert.match(sent.join('\n'), /In-Reply-To: <original@example.com>/)
  assert.match(sent.join('\n'), /Subject: Re: Test mail/)
  validity = '8'
  await assert.rejects(api.execute(credentials, qqMailRequest(argv('message.get', { uid: 499, uid_validity: '7' })), signal), /索引已更新/)
})
