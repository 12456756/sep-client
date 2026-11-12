import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { FEISHU_PRODUCTS } from './feishu-command'

const accounts = 'https://accounts.feishu.cn'
const registration = `${accounts}/oauth/v1/app/registration`
const tokenEndpoint = `${accounts}/oauth/v3/token`
export const feishuAppSchema = z.object({ clientId: z.string().min(1).max(256), clientSecret: z.string().min(1).max(4096) })
export type FeishuApp = z.infer<typeof feishuAppSchema>
export const feishuTokenSchema = z.object({
  accessToken: z.string().min(1).max(16384), refreshToken: z.string().max(16384),
  expiresAt: z.number(), refreshExpiresAt: z.number(), scope: z.string().max(64000),
})
export type FeishuToken = z.infer<typeof feishuTokenSchema>
type Payload = Record<string, unknown>
const payloadSchema = z.record(z.string(), z.unknown())
const field = (value: Payload, name: string): string => z.string().min(1).max(16384).parse(value[name])
const seconds = (value: unknown, fallback: number, max: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback

/** Fixed official endpoints; redirects never receive application credentials. */
export class FeishuOAuth {
  constructor(private readonly request: typeof fetch = fetch) {}
  private async post(url: string, form: Record<string, string>, signal: AbortSignal, basic?: FeishuApp): Promise<Payload> {
    const response = await this.request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(basic ? { Authorization: `Basic ${Buffer.from(`${basic.clientId}:${basic.clientSecret}`).toString('base64')}` } : {}) },
      body: new URLSearchParams(form).toString() })
    const text = await response.text()
    if (text.length > 1024 * 1024) throw new Error('Invalid Feishu authorization response.')
    const value = payloadSchema.parse(JSON.parse(text))
    if (!response.ok && !value.error) throw new Error('Feishu authorization request failed.')
    return value
  }
  async register(open: (url: string) => Promise<void>, signal: AbortSignal): Promise<FeishuApp> {
    const begin = await this.post(registration, { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand' }, signal)
    const deviceCode = field(begin, 'device_code')
    const url = `https://open.feishu.cn/page/cli?user_code=${encodeURIComponent(field(begin, 'user_code'))}`
    await open(url)
    const data = await this.poll(registration, { action: 'poll', device_code: deviceCode }, begin, signal, value => {
      if (value.user_info && typeof value.user_info === 'object' && 'tenant_brand' in value.user_info && value.user_info.tenant_brand !== 'feishu') throw new Error('Use a Feishu account for this connector.')
      return typeof value.client_id === 'string' && typeof value.client_secret === 'string'
    })
    return feishuAppSchema.parse({ clientId: data.client_id, clientSecret: data.client_secret })
  }
  async login(app: FeishuApp, open: (url: string) => Promise<void>, signal: AbortSignal): Promise<FeishuToken> {
    // Same published user-scope catalog used by the official CLI's --domain all.
    const response = await this.request('https://open.feishu.cn/lark-cli/apis/scopes.json', { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) })
    if (!response.ok) throw new Error('Feishu permission catalog unavailable.')
    const text = await response.text()
    if (text.length > 10 * 1024 * 1024) throw new Error('Invalid Feishu permission catalog.')
    const catalog = z.object({ scopes: z.record(z.string(), z.object({ user_scopes: z.array(z.string().regex(/^[a-z0-9_.]+(?::[a-z0-9_.]+)+$/)).max(2048) })) }).parse(JSON.parse(text))
    const scopes = [...new Set(['offline_access', ...Object.entries(catalog.scopes).filter(([domain]) => FEISHU_PRODUCTS.has(domain)).flatMap(([, domain]) => domain.user_scopes)])].sort().join(' ')
    if (scopes.length > 64000 || scopes === 'offline_access') throw new Error('Feishu permission catalog unavailable.')
    const begin = await this.post(`${accounts}/oauth/v1/device_authorization`, { client_id: app.clientId, scope: scopes }, signal, app)
    const verification = field(begin, begin.verification_uri_complete ? 'verification_uri_complete' : 'verification_uri')
    const url = new URL(verification)
    if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Unexpected Feishu authorization address.')
    await open(verification)
    const data = await this.poll(tokenEndpoint, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: field(begin, 'device_code'), client_id: app.clientId, client_secret: app.clientSecret }, begin, signal, value => typeof value.access_token === 'string')
    return this.token(data)
  }
  async refresh(app: FeishuApp, previous: FeishuToken, signal: AbortSignal): Promise<FeishuToken> {
    const value = await this.post(tokenEndpoint, { grant_type: 'refresh_token', client_id: app.clientId, client_secret: app.clientSecret, refresh_token: previous.refreshToken }, signal)
    if (value.error) throw new Error('Feishu authorization expired.')
    return this.token(value, previous)
  }
  async revoke(app: FeishuApp, token: FeishuToken): Promise<void> {
    const result = await this.post(`${accounts}/oauth/v1/revoke`, { client_id: app.clientId, client_secret: app.clientSecret,
      token: token.refreshToken || token.accessToken, token_type_hint: token.refreshToken ? 'refresh_token' : 'access_token' }, AbortSignal.timeout(15000))
    if (result.error || (typeof result.code === 'number' && result.code !== 0)) throw new Error('Feishu remote revocation incomplete.')
  }
  private token(data: Payload, previous?: FeishuToken): FeishuToken {
    if (data.token_type && String(data.token_type).toLowerCase() !== 'bearer') throw new Error('Unsupported Feishu token binding.')
    const now = Date.now()
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : previous?.refreshToken ?? ''
    return feishuTokenSchema.parse({ accessToken: field(data, 'access_token'), refreshToken,
      expiresAt: now + seconds(data.expires_in, 7200, 86400) * 1000,
      refreshExpiresAt: refreshToken ? (data.refresh_token_expires_in ? now + seconds(data.refresh_token_expires_in, 604800, 31536000) * 1000 : previous?.refreshExpiresAt ?? now + 604800000) : now,
      scope: typeof data.scope === 'string' ? data.scope : previous?.scope ?? '',
    })
  }
  private async poll(url: string, form: Record<string, string>, begin: Payload, signal: AbortSignal, complete: (value: Payload) => boolean): Promise<Payload> {
    const deadline = Date.now() + seconds(begin.expire_in ?? begin.expires_in, 600, 900) * 1000
    let interval = Math.max(1, seconds(begin.interval, 5, 60))
    while (Date.now() < deadline) {
      await delay(interval * 1000, undefined, { signal })
      const value = await this.post(url, form, signal)
      if (!value.error && complete(value)) return value
      if (value.error === 'slow_down') interval = Math.min(60, interval + 5)
      else if (value.error && value.error !== 'authorization_pending') throw new Error('Feishu authorization was not completed.')
    }
    throw new Error('Feishu authorization timed out.')
  }
}
