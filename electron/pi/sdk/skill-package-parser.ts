import { isDeepStrictEqual } from 'node:util'
import { skillArtifactNameSchema } from '../../common/platform/skill-artifact-contract'
// @ts-expect-error The existing js-yaml dependency has no TypeScript declarations.
import { load as loadYaml, CORE_SCHEMA } from 'js-yaml'

export function parseSkillMarkdown(content: string): { frontmatter: unknown; body: string; rawBody: string; hasFrontmatter: boolean; compatibilityPrefix: boolean } {
  if (!content.trim() || Buffer.from(content, 'utf8').toString('utf8') !== content) throw new Error('Approved skill entry is empty or invalid UTF-8.')
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^(?:[\t ]*\n)+/, '')
  if (!/^---[\t ]*(?:\n|$)/.test(normalized)) return { frontmatter: {}, body: normalized, rawBody: normalized, hasFrontmatter: false, compatibilityPrefix: normalized !== content.replace(/\r\n?/g, '\n') }
  const match = /^---[\t ]*\n([\s\S]*?)\n---[\t ]*(?:\n|$)/.exec(normalized)
  if (!match) return { frontmatter: {}, body: normalized, rawBody: normalized, hasFrontmatter: false, compatibilityPrefix: true }
  try {
    const frontmatter: unknown = loadYaml(match[1], { schema: CORE_SCHEMA })
    return { frontmatter: frontmatter ?? {}, body: normalized.slice(match[0].length).trim(), rawBody: normalized.slice(match[0].length), hasFrontmatter: true,
      compatibilityPrefix: normalized !== content.replace(/\r\n?/g, '\n') }
  } catch { return { frontmatter: {}, body: normalized, rawBody: normalized, hasFrontmatter: false, compatibilityPrefix: true } }
}

/** Compare meaning-bearing metadata and body, without rewriting authenticated source bytes. */
export function matchesApprovedSkillMarkdown(content: string, approvedContent: string): boolean {
  const actual = parseSkillMarkdown(content)
  const approved = parseSkillMarkdown(approvedContent)
  const metadataMatches = approved.hasFrontmatter
    ? actual.hasFrontmatter && isDeepStrictEqual(actual.frontmatter, approved.frontmatter)
    : !actual.hasFrontmatter || actual.frontmatter !== null && typeof actual.frontmatter === 'object'
      && !Array.isArray(actual.frontmatter) && Object.keys(actual.frontmatter).every(key => key === 'name' || key === 'description')
  // Ignore only outer blank lines; indentation and Markdown hard-break spaces remain significant.
  const body = (value: string): string => value.replace(/^(?:\uFEFF|[\t ]*\n)+/, '').replace(/(?:\n[\t ]*)+$/, '')
  return metadataMatches && body(actual.rawBody) === body(approved.rawBody)
}

/** Extract the approved raw body while retaining its original line endings. */
export function rawSkillMarkdownBody(content: string): string {
  const input = content.replace(/^\uFEFF/, '').replace(/^(?:[\t ]*(?:\r\n?|\n))+/, '')
  const parsed = parseSkillMarkdown(content)
  if (!parsed.hasFrontmatter) return input
  const match = /^---[\t ]*(?:\r\n?|\n)[\s\S]*?(?:\r\n?|\n)---[\t ]*(?:(?:\r\n?|\n)|$)([\s\S]*)$/.exec(input)
  return match?.[1] ?? parsed.rawBody
}

/** Legacy package approval stores the raw body with trimStart, not a rewritten entry. */
export function approvedPackageBody(content: string): string {
  validatedSkillMarkdown(content)
  return rawSkillMarkdownBody(content).trimStart()
}

export interface SkillMarkdownFallback { name: string; description: string }
export interface SkillMarkdownMetadata extends Record<string, unknown> {
  name: string
  description: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function validatedSkillMarkdown(content: string, fallback: SkillMarkdownFallback = { name: 'skill', description: 'Skill instructions' }) {
  const parsed = parseSkillMarkdown(content)
  const fallbackName = skillArtifactNameSchema.safeParse(fallback.name).success ? fallback.name : 'skill'
  const fallbackDescription = fallback.description.trim() ? fallback.description : `Instructions for ${fallbackName}`
  const source = asRecord(parsed.frontmatter)
  const name = typeof source.name === 'string' && skillArtifactNameSchema.safeParse(source.name).success ? source.name : fallbackName
  const description = typeof source.description === 'string' && source.description.trim() ? source.description : fallbackDescription
  const metadata: SkillMarkdownMetadata = { ...source, name, description }
  if (typeof metadata['disable-model-invocation'] !== 'boolean') delete metadata['disable-model-invocation']
  return { ...parsed, metadata }
}
