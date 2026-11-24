import type { BrowserContext, Response } from 'playwright-core'

const rateLimitText = /^(?:(?:抱歉\s*[,，]?\s*)?由于访问频繁\s*(?:导致|[,，])\s*无法搜索(?:\s*[,，]\s*请稍后再试)?|访问过于频繁(?:\s*[,，]\s*请稍后重试)?|(?:请求|操作)过于频繁\s*[,，]\s*请稍后重试|too many requests)[。.!！]?$/i
export const browserRateLimitMessage = '站点提示访问频繁，已停止本次浏览器会话的自动访问。请勿继续刷新、搜索或切换页面重试；请告知用户未能获取的结果。'

function isSiteRateLimit(response: Response): boolean {
  if (response.status() !== 429) return false
  try {
    const request = response.request()
    const frame = request.frame()
    if (frame !== frame.page().mainFrame()) return false
    const kind = request.resourceType()
    if (kind === 'document') return true
    // Ignore third-party metrics and asset throttling.
    return (kind === 'fetch' || kind === 'xhr') && new URL(response.url()).origin === new URL(frame.url()).origin
  } catch { return false }
}

export class BrowserAccessGuard {
  private limited = false

  observe(context: BrowserContext): void {
    context.on('response', response => { if (isSiteRateLimit(response)) this.limited = true })
  }

  async isLimited(context?: BrowserContext): Promise<boolean> {
    if (!this.limited && context) {
      // Read only rendered page text; never refresh or query the site to confirm a limit.
      for (const page of context.pages()) {
        if (await page.getByText(rateLimitText).filter({ visible: true }).first().isVisible().catch(() => false)) {
          this.limited = true
          break
        }
      }
    }
    return this.limited
  }
}
