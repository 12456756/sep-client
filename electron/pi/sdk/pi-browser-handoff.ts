import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import type { CDPSession, Page } from 'playwright-core'
import { z } from 'zod'

function webUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url
  } catch { /* Not an HTTP page. */ }
}

export const handoffCompletionSchema = z.object({
  url: z.string().max(2048).refine(value => {
    const parsed = webUrl(value)
    return !!parsed && !parsed.search && !parsed.hash
  }),
  text: z.string().trim().min(3).max(100),
}).strict()

const signOut = /^(?:退出登录|登出|注销登录|退出账号|sign\s*out|log\s*out)$/i
const blockingText = /^(?:扫码登录|密码登录|请先登录|请输入验证码|请拖动滑块|请完成安全验证|验证失败|scan to (?:sign|log) in|verify (?:that )?you are human|enter (?:the |your )?verification code)[。.!！]?$/i
const blockingControls = 'input[type="password"]:visible, input[autocomplete="one-time-code"]:visible, iframe[title*="challenge" i]:visible, iframe[src*="/bframe"]:visible'
const bilibiliPassport = 'https://passport.bilibili.com'
const bilibiliHome = 'https://www.bilibili.com'
const bilibiliLoginState = z.object({ code: z.literal(0), data: z.object({ isLogin: z.literal(true) }) })
const maxStatusBytes = 64 * 1024

function isBilibiliPage(value: string): boolean {
  const origin = webUrl(value)?.origin
  return origin === bilibiliPassport || origin === bilibiliHome
}

function isBilibiliStatusUrl(value: string): boolean {
  const url = webUrl(value)
  return url?.origin === 'https://api.bilibili.com' && url.pathname === '/x/web-interface/nav'
}

async function observeBilibiliStatus(page: Page, confirm: () => void): Promise<() => void> {
  let cdp: CDPSession | undefined
  let active = true
  const stop = () => {
    if (!active) return
    active = false
    void cdp?.detach().catch(() => undefined)
  }
  try {
    const session = cdp = await page.context().newCDPSession(page)
    const frameId = (await session.send('Page.getFrameTree')).frameTree.frame.id
    const pending = new Map<string, boolean>()
    session.on('Network.requestWillBeSent', event => {
      pending.delete(event.requestId)
      if (active && event.frameId === frameId && !event.redirectResponse && event.request.method === 'GET' &&
        (event.type === 'Fetch' || event.type === 'XHR') && isBilibiliPage(event.documentURL) && isBilibiliStatusUrl(event.request.url) && pending.size < 16) {
        pending.set(event.requestId, false)
      }
    })
    session.on('Network.responseReceived', event => {
      if (!pending.has(event.requestId)) return
      const r = event.response
      if (r.status === 200 && r.mimeType === 'application/json' && !r.fromDiskCache && !r.fromServiceWorker &&
        !r.fromPrefetchCache && isBilibiliStatusUrl(r.url)) pending.set(event.requestId, true)
      else pending.delete(event.requestId)
    })
    session.on('Network.requestServedFromCache', event => { pending.delete(event.requestId) })
    session.on('Network.loadingFailed', event => { pending.delete(event.requestId) })
    session.on('Network.loadingFinished', event => {
      const eligible = pending.get(event.requestId)
      pending.delete(event.requestId)
      if (!eligible || !active || event.encodedDataLength > maxStatusBytes || page.isClosed() || !isBilibiliPage(page.url())) return
      // CDP reads the already-loaded bytes; Playwright Response.body() can refetch.
      void session.send('Network.getResponseBody', { requestId: event.requestId }).then(response => {
        if (!active || page.isClosed() || !isBilibiliPage(page.url()) || response.body.length > maxStatusBytes) return
        const bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8')
        if (bytes.length <= maxStatusBytes && bilibiliLoginState.safeParse(JSON.parse(bytes.toString('utf8'))).success) confirm()
      }).catch(() => undefined)
    })
    await session.send('Network.enable', { maxTotalBufferSize: 4 * maxStatusBytes, maxResourceBufferSize: maxStatusBytes })
  } catch { stop() } // No API evidence: the user can still confirm manually.
  return stop
}

/** Inspect the handed-off page or its loaded login status only. Never send requests or handle credentials. */
export async function prepareHandoffDetection(page: Page, completion: z.infer<typeof handoffCompletionSchema> | undefined) {
  const initial = webUrl(page.url())
  const observed = new EventTarget()
  let evidence: 'site-login' | 'page-marker' | undefined
  const confirm = (kind: NonNullable<typeof evidence>) => {
    if (evidence) return
    evidence = kind
    observed.dispatchEvent(new Event('confirmed'))
  }
  if (initial?.origin === bilibiliPassport || initial?.origin === bilibiliHome) {
    const dispose = await observeBilibiliStatus(page, () => confirm('site-login'))
    return { get evidence() { return evidence }, dispose, async waitForCompletion(signal: AbortSignal) {
      signal.throwIfAborted()
      if (!evidence) await once(observed, 'confirmed', { signal })
    } }
  }
  const destination = completion && webUrl(completion.url)
  const marker = (completion
    ? page.getByText(completion.text, { exact: true })
    : page.getByRole('button', { name: signOut }).or(page.getByRole('link', { name: signOut })).or(page.getByRole('menuitem', { name: signOut })))
    .filter({ visible: true }).first()
  // Do not treat a marker already on the page as evidence that the user finished.
  const alreadyVisible = await marker.isVisible().catch(() => true)
  const observation = async (): Promise<string | undefined> => {
    const url = webUrl(page.url())
    if (!url || !initial) return
    const success = !alreadyVisible && url.origin === (destination ?? initial).origin &&
      (!destination || url.pathname === destination.pathname) && await marker.isVisible()
    if (success && !await page.locator(blockingControls).count() &&
      !await page.getByText(blockingText).filter({ visible: true }).count() && webUrl(page.url())?.href === url.href) return url.href
  }

  return { get evidence() { return evidence }, dispose() {}, async waitForCompletion(signal: AbortSignal): Promise<void> {
    let previous: string | undefined
    for (;;) {
      signal.throwIfAborted()
      const now = await observation().catch(() => undefined) // Redirects can invalidate a DOM read.
      signal.throwIfAborted()
      if (now && now === previous) { confirm('page-marker'); return }
      previous = now
      await delay(500, undefined, { signal })
    }
  } }
}
