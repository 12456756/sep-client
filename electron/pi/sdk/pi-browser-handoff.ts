import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright-core'
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

/** Observe the handed-off page only. Never read secrets, make a request or interact with the site. */
export async function prepareHandoffDetection(page: Page, completion: z.infer<typeof handoffCompletionSchema> | undefined) {
  const initial = webUrl(page.url())
  const destination = completion && webUrl(completion.url)
  const marker = completion
    ? page.getByText(completion.text, { exact: true })
    : page.getByRole('button', { name: signOut }).or(page.getByRole('link', { name: signOut })).or(page.getByRole('menuitem', { name: signOut }))
  const visible = marker.filter({ visible: true }).first()
  // Do not treat a marker already on the page as evidence that the user finished.
  const alreadyVisible = await visible.isVisible().catch(() => true)
  const observation = async (): Promise<string | undefined> => {
    const url = webUrl(page.url())
    if (!url || !initial || alreadyVisible || url.origin !== (destination ?? initial).origin ||
      (destination && url.pathname !== destination.pathname)) return
    if (await visible.isVisible() && !await page.locator(blockingControls).count() &&
      !await page.getByText(blockingText).filter({ visible: true }).count() && webUrl(page.url())?.href === url.href) return url.href
  }

  return async (signal: AbortSignal): Promise<void> => {
    let previous: string | undefined
    for (;;) {
      signal.throwIfAborted()
      const now = await observation().catch(() => undefined) // Redirects can invalidate a DOM read.
      signal.throwIfAborted()
      if (now && now === previous) return
      previous = now
      await delay(500, undefined, { signal })
    }
  }
}
