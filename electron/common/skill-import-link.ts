import { z } from 'zod'
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)
export const SkillImportLinkSchema = z.object({ instanceId: id, sessionId: id }).strict()
export function parseSkillImportLink(raw: string, trustedInstances: ReadonlySet<string>): { instanceId: string; sessionId: string } | null {
  if (typeof raw !== 'string' || raw.length > 2048 || [...raw].some(character => { const code = character.charCodeAt(0); return code < 0x20 || code === 0x7f })) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'sep-import:' || url.hostname !== 'skills' || url.pathname !== '/v1' || url.username || url.password || url.port || url.hash || !trustedInstances.has(url.searchParams.get('instanceId') ?? '')) return null
  const keys = [...url.searchParams.keys()]
  if (keys.length !== 2 || keys.some(k => k !== 'instanceId' && k !== 'sessionId') || new Set(keys).size !== 2) return null
  const parsed = SkillImportLinkSchema.safeParse({ instanceId: url.searchParams.get('instanceId'), sessionId: url.searchParams.get('sessionId') })
  return parsed.success ? parsed.data : null
}
