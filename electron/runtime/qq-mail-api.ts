import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { simpleParser } from 'mailparser'
import type { QQMailCredentials } from '../../src/shared/connectors'
import { qqMailCommands, type QQMailRequest } from './qq-mail-command'

const MAX_SOURCE = 2 * 1024 * 1024
const messageId = /^<[^<>\s\p{Cc}]{1,990}>$/u
export class QQMailError extends Error {
  constructor(readonly kind: 'auth' | 'network' | 'mail' | 'uncertain', message: string) { super(message); this.name = 'QQMailError' }
}
export function qqMailFailure(error: unknown): QQMailError {
  if (error instanceof QQMailError) return error
  const value = error as { authenticationFailed?: boolean; code?: string }
  if (value?.authenticationFailed || value?.code === 'EAUTH') return new QQMailError('auth', '邮箱验证未通过，请检查邮箱地址、授权码及 IMAP/SMTP 服务是否已开启。')
  return new QQMailError('network', '邮箱服务连接未完成，请检查网络和邮箱服务设置后重试。')
}

export class QQMailApi {
  constructor(private readonly clients = {
    imap: (credentials: QQMailCredentials) => new ImapFlow({ host: 'imap.qq.com', port: 993, secure: true,
      auth: { user: credentials.email, pass: credentials.authorizationCode }, logger: false, disableAutoIdle: true,
      tls: { rejectUnauthorized: true }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    }),
    smtp: (credentials: QQMailCredentials) => nodemailer.createTransport({ host: 'smtp.qq.com', port: 465, secure: true,
      auth: { user: credentials.email, pass: credentials.authorizationCode }, tls: { rejectUnauthorized: true },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, logger: false, debug: false,
      disableFileAccess: true, disableUrlAccess: true, forceAuth: true,
    } as SMTPTransport.Options),
  }) {}

  private async imap<T>(credentials: QQMailCredentials, signal: AbortSignal, run: (client: ImapFlow) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const client = this.clients.imap(credentials)
    // ImapFlow emits socket errors as well as rejecting the outstanding command.
    client.on('error', () => {})
    const close = (): void => { client.close() }
    signal.addEventListener('abort', close, { once: true })
    try {
      await client.connect(); signal.throwIfAborted()
      return await run(client)
    } finally { signal.removeEventListener('abort', close); client.close() }
  }
  private async smtp<T>(credentials: QQMailCredentials, signal: AbortSignal, run: (client: ReturnType<typeof nodemailer.createTransport>) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const client = this.clients.smtp(credentials)
    const close = (): void => { client.close() }
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const abort = (): void => { close(); rejectAbort(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try { return await Promise.race([run(client), aborted]) }
    finally { signal.removeEventListener('abort', abort); close() }
  }
  async verify(credentials: QQMailCredentials, signal: AbortSignal): Promise<void> {
    try {
      await this.imap(credentials, signal, async () => {})
      await this.smtp(credentials, signal, client => client.verify())
      signal.throwIfAborted()
    } catch (error) { throw qqMailFailure(error) }
  }
  private async source(client: ImapFlow, uid: number) {
    const metadata = await client.fetchOne(uid, { uid: true, size: true, envelope: true, flags: true }, { uid: true })
    if (!metadata || metadata.uid !== uid) throw new QQMailError('mail', '未找到邮件，请重新查询邮件列表。')
    if (typeof metadata.size !== 'number' || !Number.isSafeInteger(metadata.size) || metadata.size < 1) throw new QQMailError('mail', '未能确认邮件大小，请稍后重试。')
    if (metadata.size > MAX_SOURCE) throw new QQMailError('mail', '邮件超过 2 MB，暂不能读取正文或回复，请在 QQ 邮箱中处理。')
    const full = await client.fetchOne(uid, { uid: true, source: { start: 0, maxLength: MAX_SOURCE + 1 } }, { uid: true })
    if (!full || full.uid !== uid || !full.source || full.source.length !== metadata.size || full.source.length > MAX_SOURCE) throw new QQMailError('mail', '未能完整读取邮件，请稍后重试。')
    const parsed = await simpleParser(full.source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: MAX_SOURCE })
    return { metadata, parsed }
  }
  private async send(credentials: QQMailCredentials, data: { to: string[]; cc?: string[]; subject: string; text: string; inReplyTo?: string; references?: string[] }, signal: AbortSignal): Promise<unknown> {
    return this.smtp(credentials, signal, async client => {
      try {
        const options = { ...data, from: credentials.email, disableFileAccess: true, disableUrlAccess: true, signal }
        const info = await client.sendMail(options)
        const submitted = [...data.to, ...(data.cc ?? [])]
        const accepted = submitted.filter(address => Array.isArray(info.accepted) && info.accepted.includes(address))
        const rejected = submitted.filter(address => !accepted.includes(address))
        if (!accepted.length) throw new QQMailError('uncertain', '邮件提交结果尚未确认，请在 QQ 邮箱中核实，勿自动重发。')
        return { message_id: String(info.messageId).slice(0, 998), accepted, rejected, status: 'submitted' }
      } catch (error) {
        const failure = qqMailFailure(error)
        if (failure.kind === 'auth') throw failure
        const smtp = error as { responseCode?: number }
        if (smtp.responseCode && smtp.responseCode >= 400 && smtp.responseCode < 600) throw new QQMailError('mail', 'QQ 邮箱拒绝了本次邮件提交，请检查收件地址或发送限制。')
        throw new QQMailError('uncertain', '邮件提交结果尚未确认，请在 QQ 邮箱中核实，勿自动重发。')
      }
    })
  }
  async execute(credentials: QQMailCredentials, request: QQMailRequest, signal: AbortSignal): Promise<unknown> {
    if (request.method === 'identity.whoami') return { email: credentials.email, transport: 'IMAP/SMTP' }
    if (request.method === 'message.send') return this.send(credentials, request.data, signal)
    const result = await this.imap(credentials, signal, async client => {
      if (request.method === 'folder.list') {
        const folders = await client.list()
        return { folders: folders.slice(0, 100).map(v => ({ path: v.path, name: v.name, special_use: v.specialUse, selectable: !v.flags.has('\\Noselect') })), truncated: folders.length > 100 }
      }
      const { data } = request
      const mailbox = await client.mailboxOpen(data.folder, { readOnly: true })
      const validity = mailbox.uidValidity.toString()
      if (data.uid_validity && data.uid_validity !== validity) throw new QQMailError('mail', '邮箱索引已更新，请重新查询邮件列表。')
      if (request.method === 'message.list' || request.method === 'message.search') {
        const { data: page } = request
        const high = Math.min(mailbox.uidNext - 1, (page.before_uid ?? mailbox.uidNext) - 1)
        if (high < 1 || mailbox.exists === 0) return { folder: page.folder, uid_validity: validity, messages: [], next_before_uid: null }
        // Search only one bounded UID window. Empty pages can still have a next cursor.
        const low = Math.max(1, high - 199)
        const found = await client.search({ uid: `${low}:${high}`, ...(request.method === 'message.search' ? { text: request.data.query, ...(request.data.unread === undefined ? {} : { seen: !request.data.unread }) } : {}) }, { uid: true })
        if (!Array.isArray(found) || found.length > 200 || found.some(v => !Number.isInteger(v) || v < low || v > high)) throw new QQMailError('mail', '邮件查询结果异常，请重试。')
        const sorted = [...new Set(found)].sort((a, b) => b - a)
        const ids = sorted.slice(0, page.limit)
        const messages = ids.length ? await client.fetchAll(ids.join(','), { uid: true, envelope: true, flags: true, size: true }, { uid: true }) : []
        const cursor = sorted.length > page.limit ? ids.at(-1)! : low
        return { folder: page.folder, uid_validity: validity, messages: messages.sort((a, b) => b.uid - a.uid).map(v => ({ uid: v.uid, subject: v.envelope?.subject?.slice(0, 1000), from: v.envelope?.from?.slice(0, 20), to: v.envelope?.to?.slice(0, 20), date: v.envelope?.date, unread: !v.flags?.has('\\Seen'), size: v.size })), next_before_uid: cursor > 1 ? cursor : null, scanned_uid_range: [low, high] }
      }
      const { metadata, parsed } = await this.source(client, request.data.uid)
      signal.throwIfAborted()
      if (request.method === 'message.reply') {
        const targets = (metadata.envelope?.replyTo?.length ? metadata.envelope.replyTo : metadata.envelope?.from)?.map(v => v.address)
        const subject = /^re:/i.test(parsed.subject ?? '') ? parsed.subject! : `Re: ${parsed.subject ?? ''}`
        const validated = qqMailCommands['message.send'].safeParse({ to: targets, subject, text: request.data.text })
        if (!validated.success || !parsed.messageId || !messageId.test(parsed.messageId)) throw new QQMailError('mail', '原邮件缺少有效的回复地址或邮件标识，请在 QQ 邮箱中回复。')
        const expected = [...new Set(validated.data.to)].sort()
        if (JSON.stringify(expected) !== JSON.stringify([...new Set(request.data.to)].sort())) throw new QQMailError('mail', '回复地址与确认的收件地址不一致，请重新读取原邮件并确认收件人。')
        const refs = [typeof parsed.references === 'string' ? parsed.references : parsed.references ?? []].flat().filter(v => messageId.test(v)).slice(-19)
        return { reply: { ...validated.data, inReplyTo: parsed.messageId, references: [...refs, parsed.messageId] } }
      }
      const text = parsed.text ?? ''
      return { folder: data.folder, uid_validity: validity, uid: metadata.uid, subject: parsed.subject, from: metadata.envelope?.from, reply_to: metadata.envelope?.replyTo, to: metadata.envelope?.to, date: metadata.envelope?.date,
        text: text.slice(0, 100000), text_truncated: text.length > 100000,
        attachments: parsed.attachments.slice(0, 100).map(v => ({ filename: v.filename, content_type: v.contentType, size: v.size })), attachments_truncated: parsed.attachments.length > 100,
      }
    })
    if (request.method === 'message.reply') {
      const reply = result as { reply: Parameters<QQMailApi['send']>[1] }
      signal.throwIfAborted()
      return this.send(credentials, reply.reply, signal)
    }
    return result
  }
}
