import { posix } from 'node:path'
import { skillArtifactFrontmatterSchema, maxSkillEntryBytes } from '../../common/platform/skill-artifact-contract'
// @ts-expect-error The existing js-yaml dependency has no TypeScript declarations.
import { load as loadYaml, CORE_SCHEMA } from 'js-yaml'

export function parseSkillMarkdown(content: string): { frontmatter: unknown; body: string; hasFrontmatter: boolean; compatibilityPrefix: boolean } {
  if (Buffer.byteLength(content, 'utf8') > maxSkillEntryBytes || !content.trim() || Buffer.from(content, 'utf8').toString('utf8') !== content) throw new Error('Approved skill entry is empty, invalid UTF-8 or exceeds the byte limit.')
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^(?:[\t ]*\n)+/, '')
  if (!/^---[\t ]*(?:\n|$)/.test(normalized)) return { frontmatter: {}, body: normalized, hasFrontmatter: false, compatibilityPrefix: normalized !== content.replace(/\r\n?/g, '\n') }
  const match = /^---[\t ]*\n([\s\S]*?)\n---[\t ]*(?:\n|$)/.exec(normalized)
  if (!match) throw new Error('Invalid skill YAML frontmatter.')
  try {
    const frontmatter: unknown = loadYaml(match[1], { schema: CORE_SCHEMA })
    return { frontmatter: frontmatter ?? {}, body: normalized.slice(match[0].length).trim(), hasFrontmatter: true,
      compatibilityPrefix: normalized !== content.replace(/\r\n?/g, '\n') }
  } catch { throw new Error('Invalid skill YAML frontmatter.') }
}

/** Legacy package approval stores the raw body with trimStart, not a rewritten entry. */
export function approvedPackageBody(content: string): string {
  validatedSkillMarkdown(content)
  const input = content.replace(/^\uFEFF/, '').replace(/^(?:[\t ]*(?:\r\n?|\n))+/, '')
  const match = /^---[\t ]*(?:\r\n?|\n)[\s\S]*?(?:\r\n?|\n)---[\t ]*(?:(?:\r\n?|\n)|$)([\s\S]*)$/.exec(input)
  if (!match) throw new Error('Invalid skill YAML frontmatter.')
  return match[1].trimStart()
}

export function validatedSkillMarkdown(content: string) {
  const parsed = parseSkillMarkdown(content)
  const metadata = skillArtifactFrontmatterSchema.safeParse(parsed.frontmatter)
  if (!parsed.hasFrontmatter || !metadata.success || !parsed.body.trim()) throw new Error('Invalid skill frontmatter or body.')
  return { ...parsed, metadata: metadata.data }
}

/** Only concrete input resources are dependencies; output instructions are not attachments. */
export function validateSkillResources(body: string, entryPath = 'SKILL.md', files: ReadonlySet<string> = new Set(['SKILL.md'])): void {
  const external = (value: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)
  const references = [
    ...body.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+[^)]*)?\)/g),
    ...body.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+).*$/gm),
    ...body.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi),
  ].map(match => match[1])
  // Remove URLs before looking for package paths inside prose or inline code.
  const prose = body.replace(/(?:[a-z][a-z0-9+.-]*:|\/\/)[^\s`"'<>]+/gi, '')
  for (const match of prose.matchAll(/(?:\b(?:read|load|run|execute|source|include|import|open|use|python3?|node|bash|sh)\s+|(?:读取|加载|运行|执行|引用|打开|使用)\s*)[`"']?([^\s`"'<>，。；)]+)/gi)) {
    const value = match[1].replace(/[.,;:]+$/, '')
    if (external(value) || value.endsWith('/')) continue
    if (!/^(?:\.\.?\/|(?:references|scripts|assets)\/)/.test(value) && !/^[\p{L}\p{N}_.-]+\.(?:md|py|sh|js|ts|json|ya?ml|png|jpe?g|webp|csv|pdf|txt)$/u.test(value)) continue
    references.push(value)
  }
  for (const reference of references) {
    const target = reference.replace(/^<|>$/g, '')
    if (external(target) || target.split(/[?#]/)[0].endsWith('/')) continue
    let value: string
    try { value = decodeURIComponent(target.split(/[?#]/)[0]) } catch { throw new Error('Invalid local skill resource.') }
    if (!value) continue
    if (/[\\:\p{Cc}\p{Cf}]/u.test(value) || value.startsWith('/')) throw new Error('Invalid local skill resource.')
    const path = posix.normalize(posix.join(posix.dirname(entryPath), value))
    if (path === '..' || path.startsWith('../') || !files.has(path)) throw new Error('Skill entry references a missing local resource; an approved package is required.')
  }
}
