import { appError } from '../../errors/app-error'

/** actionUrl is external data, not permission to open arbitrary OS protocols or sites. */
export function resolveNotificationAction(raw: string, webBaseUrl: string): string {
  const reject = (): never => { throw appError('INVALID_ARGUMENT', { message: '通知链接不属于可信的 SEP 平台页面' }) }
  if (!raw || raw.length > 4096 || [...raw].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) || raw.startsWith('//')) reject()
  let target: URL
  let base: URL
  try { base = new URL(webBaseUrl); target = new URL(raw, base) } catch { return reject() }
  if (!['https:', 'http:'].includes(target.protocol) || target.origin !== base.origin || target.username || target.password) reject()
  if (/^\/(api|ws)(\/|$)/i.test(target.pathname)) reject()
  for (const key of target.searchParams.keys()) {
    if (/(token|authorization|password)/i.test(key)) reject()
  }
  return target.toString()
}
