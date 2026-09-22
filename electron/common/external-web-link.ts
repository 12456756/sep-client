/** 外部网页只能进入系统浏览器，不能继承客户端窗口的 preload 能力。 */
export function externalWebLink(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
