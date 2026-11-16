import { randomInt } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { isSensitiveModelTraceKey, redactModelTraceText } from '../common/redact'

// Protocol: TencentCloud/tencentmeeting-cli@bd9ab5357abb17b669e5cda33b73d547f0132ae1 (MIT).
export const meetingIdentitySchema = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9]{48}$/),
  sdkId: z.string().min(1).max(256), openId: z.string().min(1).max(256),
  accessToken: z.string().min(1).max(16384), refreshToken: z.string().min(1).max(16384),
  expiresAt: z.number().positive(), refreshExpiresAt: z.number().positive(),
})
export type MeetingIdentity = z.infer<typeof meetingIdentitySchema>
const tokenResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1),
  access_token_expire_time: z.string().regex(/^\d+$/), refresh_token_expire_time: z.string().regex(/^\d+$/),
  open_id: z.string().min(1), sdk_id: z.string().min(1),
})

export class MeetingApiError extends Error {
  constructor(readonly code: number, readonly status: number) { super(`腾讯会议接口返回错误（HTTP ${status}，代码 ${code}）。`) }
}
export interface MeetingRequest { method: 'GET' | 'POST' | 'PUT'; path: string; data: Record<string, unknown> }

/** Fixed official origins, bounded responses, no redirects or automatic business retries. */
export class TencentMeetingApi {
  constructor(private readonly request: typeof fetch = fetch, private readonly pause: (signal: AbortSignal) => Promise<void> = signal => delay(5000, undefined, { signal })) {}
  private async json(url: URL, init: RequestInit, signal: AbortSignal): Promise<{ response: Response; value: unknown }> {
    const response = await this.request(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) })
    if (!response.body) throw new Error('Empty Tencent Meeting response.')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.length
        if (length > 2 * 1024 * 1024) throw new Error('Tencent Meeting response too large; narrow the query.')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => undefined) }
    return { response, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  }
  private async auth(action: 'init' | 'poll' | 'refresh-token', body: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const path = action === 'refresh-token' ? 'cli-refresh-token' : `cli-oauth-${action}`
    const { response, value } = await this.json(new URL(`https://work.medialab.qq.com/v2/oauth2/oauth/${path}`), {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
    }, signal)
    const result = z.object({ code: z.number().default(0), data: z.unknown() }).parse(value)
    if (!response.ok || result.code !== 0) throw new MeetingApiError(result.code, response.status)
    return result.data
  }
  private identity(data: unknown, deviceId: string): MeetingIdentity {
    const value = tokenResponse.parse(data)
    const identity = meetingIdentitySchema.parse({ deviceId, sdkId: value.sdk_id, openId: value.open_id,
      accessToken: value.access_token, refreshToken: value.refresh_token,
      expiresAt: Number(value.access_token_expire_time) * 1000, refreshExpiresAt: Number(value.refresh_token_expire_time) * 1000,
    })
    if (identity.expiresAt <= Date.now() || identity.refreshExpiresAt <= Date.now()) throw new Error('Expired Tencent Meeting authorization.')
    return identity
  }
  async login(deviceId: string, open: (url: string) => Promise<void>, signal: AbortSignal): Promise<MeetingIdentity> {
    const result = z.object({ auth_code: z.string().min(1).max(4096) }).parse(await this.auth('init', { device_id: deviceId }, signal))
    const url = new URL('https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html')
    url.searchParams.set('code', result.auth_code)
    await open(url.href)
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
      await this.pause(signal)
      signal.throwIfAborted()
      const data = await this.auth('poll', { device_id: deviceId, auth_code: result.auth_code }, signal)
      if (data && typeof data === 'object' && 'open_id' in data && data.open_id) return this.identity(data, deviceId)
    }
    throw new Error('Tencent Meeting authorization timed out.')
  }
  async refresh(previous: MeetingIdentity, signal: AbortSignal): Promise<MeetingIdentity> {
    const next = this.identity(await this.auth('refresh-token', { device_id: previous.deviceId, refresh_token: previous.refreshToken,
      open_id: previous.openId, sdk_id: previous.sdkId }, signal), previous.deviceId)
    if (next.openId !== previous.openId || next.sdkId !== previous.sdkId) throw new Error('Tencent Meeting identity changed during refresh.')
    return next
  }
  async execute(identity: MeetingIdentity, command: MeetingRequest, signal: AbortSignal): Promise<unknown> {
    if (!/^\/v1\/(?:meetings(?:\/|$)|mcp\/records\/search$|smart\/minutes\/|records\/mcp\/transcripts\/details$|cli\/get-user-info$)/.test(command.path) || command.path.includes('..') || /[?#\\]/.test(command.path)) throw new Error('Invalid Tencent Meeting endpoint.')
    const url = new URL(command.path, 'https://api.meeting.qq.com')
    if (command.method === 'GET') for (const [name, value] of Object.entries(command.data)) url.searchParams.set(name, String(value))
    const { response, value } = await this.json(url, { method: command.method,
      headers: { 'Content-Type': 'application/json; charset=utf-8', AccessToken: identity.accessToken, OpenId: identity.openId,
        'X-TC-Nonce': String(randomInt(100000, 1000000)), 'X-TC-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Tmeet-Unique-ID': `${identity.openId}*${identity.deviceId}`, 'Tmeet-Device-Info': `${process.platform};CSEP;`,
        'Tmeet-Open-Source': 'CLI', 'Tmeet-Cli-Ver': '1.1.0',
      }, ...(command.method !== 'GET' ? { body: JSON.stringify(command.data) } : {}),
    }, signal)
    const error = z.object({ error_info: z.object({ new_error_code: z.number().optional(), error_code: z.number().optional() }) }).safeParse(value)
    if (!response.ok || error.success) throw new MeetingApiError(error.success ? error.data.error_info.new_error_code ?? error.data.error_info.error_code ?? 0 : 0, response.status)
    return value
  }
}

export function meetingPublicResult(value: unknown, identity: MeetingIdentity): string {
  const clean = (item: unknown, depth = 0): unknown => {
    if (depth > 64) return '[max-depth]'
    if (typeof item === 'string') return [identity.accessToken, identity.refreshToken].reduce((result, secret) => result.split(secret).join('[redacted]'), redactModelTraceText(item))
    if (Array.isArray(item)) return item.map(entry => clean(entry, depth + 1))
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, isSensitiveModelTraceKey(name) ? '[redacted]' : clean(entry, depth + 1)]))
    return item
  }
  return JSON.stringify(clean(value))
}
