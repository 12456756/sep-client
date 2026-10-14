import { canUseSkillVersion } from '../../common/platform/skill-version-policy'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SkillVersionStore } from '../../data/skill-version-store'
import { getEmployeeSkills, previewSkill, type SkillVersion } from '../../common/platform/platform-api'
import { employeeRuntimeSkillSchema, type EmployeeRuntimeSkill, type PreparedEmployeeSkill } from '../../common/platform/employee-runtime-contract'
import { downloadSkillArtifact } from '../../common/platform/skill-artifact-api'
import { skillArtifactSchema, type SkillArtifactAvailable } from '../../common/platform/skill-artifact-contract'
import { z } from 'zod'
// @ts-expect-error The existing js-yaml dependency does not ship TypeScript declarations.
import { load as loadYaml, CORE_SCHEMA } from 'js-yaml'

export interface SkillStoreRequest {
  enterpriseId: string
  subscriptionId: string
  employeeId: string
  memberId?: string
  accessToken: string
  runtimeSkills?: readonly EmployeeRuntimeSkill[]
  skillArtifactProtocolVersion?: 1
  isCurrent?: () => boolean
}

export interface SkillStoreResult {
  skillPaths: string[]
  skills: PreparedEmployeeSkill[]
}

const metadataSchema = z.object({
  subscriptionId: z.string().min(1),
  skills: z.array(z.object({
    capability: z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().nullable(), type: z.literal('SKILL') }),
    currentVersion: z.object({
      id: z.string().min(1), capabilityId: z.string().min(1), scope: z.string(), status: z.string(),
      version: z.string().min(1), ownerId: z.string().nullable().optional(),
      parentVersionId: z.string().nullable().optional(),
    }),
    versions: z.array(z.object({
      id: z.string().min(1), capabilityId: z.string().min(1), scope: z.string(), status: z.string(),
      version: z.string().min(1), ownerId: z.string().nullable().optional(),
      parentVersionId: z.string().nullable().optional(),
    })),
  })),
})

type SkillMetadata = z.infer<typeof metadataSchema>['skills'][number]

function checkCurrent(input: SkillStoreRequest): void {
  if (input.isCurrent && !input.isCurrent()) throw new Error('Employee preparation scope changed.')
}

function fallbackName(capabilityId: string): string {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capabilityId) && capabilityId.length <= 64) return capabilityId
  return `skill-${createHash('sha256').update(capabilityId).digest('hex').slice(0, 24)}`
}

function validateSelfContained(body: string): void {
  const references = [
    ...body.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g),
    ...body.matchAll(/^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm),
    ...body.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi),
    ...body.matchAll(/(?:^|[\s`"'(])((?:\.\.?\/)?(?:references|scripts|assets)\/[^\s`"'<>()[\]]+)/g),
    ...body.matchAll(/`(\.\.?\/[^`\n]+|[A-Za-z0-9_-]+\.(?:md|py|sh|js|ts|json|ya?ml|png|jpe?g|webp))`/g),
  ]
  for (const reference of references) {
    const path = reference[1]
    if (/^(?:https?:\/\/|mailto:|data:|#)/i.test(path)) continue
    if (/^(?:\.\/)?SKILL\.md(?:#.*)?$/.test(path)) continue
    throw new Error('Skill entry references a missing local resource; an approved package is required.')
  }
}

function parseSkillFrontmatter(content: string): { frontmatter: unknown; body: string } {
  if (!content.startsWith('---')) return { frontmatter: {}, body: content }
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content)
  if (!match) throw new Error('Invalid skill YAML frontmatter.')
  try {
    // YAML 1.2 core types match Pi; dates stay strings and merge keys cannot supply metadata.
    const frontmatter: unknown = loadYaml(match[1], { schema: CORE_SCHEMA })
    return { frontmatter: frontmatter ?? {}, body: content.slice(match[0].length).trim() }
  } catch {
    throw new Error('Invalid skill YAML frontmatter.')
  }
}

function skillEntry(content: string, skill: SkillMetadata): { content: string; name: string; description: string } {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.trim()) throw new Error('Approved skill entry is empty.')
  const parsed = parseSkillFrontmatter(normalized)
  const hasFrontmatter = normalized.startsWith('---\n')
  const metadata = hasFrontmatter ? parsed.frontmatter : {
    name: fallbackName(skill.capability.id),
    description: skill.capability.description?.trim() || skill.capability.name,
  }
  const valid = z.object({
    name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().min(1).max(1024).refine(value => Boolean(value.trim())),
    'disable-model-invocation': z.literal(false).optional(),
  }).safeParse(metadata)
  if (!valid.success) throw new Error('Skill frontmatter requires a valid name and description.')
  if (!parsed.body.trim()) throw new Error('Approved skill entry is empty.')
  validateSelfContained(parsed.body)
  const entry = hasFrontmatter ? normalized : `---\nname: ${JSON.stringify(valid.data.name)}\ndescription: ${JSON.stringify(valid.data.description)}\n---\n\n${normalized}`
  parseSkillFrontmatter(entry)
  return { content: entry, name: valid.data.name, description: valid.data.description }
}

function safeSegment(value: string): string {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid subscription runtime identifier.')
  return value
}

function approvedEntry(bytes: Buffer, artifact: SkillArtifactAvailable): { content: string; name: string; description: string } {
  if (artifact.format !== 'single-file') throw new Error('Approved ZIP skill installation is not supported yet; no content fallback is permitted.')
  if (artifact.entryPath !== 'SKILL.md' || artifact.fileCount !== 1 || bytes.length > 500 * 1024 || bytes.length !== artifact.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.artifactSha256 || artifact.entrySha256 !== artifact.artifactSha256) {
    throw new Error('Approved skill artifact integrity mismatch.')
  }
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new Error('Approved skill entry is not valid UTF-8.') }
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) throw new Error('Approved skill entry requires frontmatter.')
  const parsed = parseSkillFrontmatter(content.replace(/\r\n?/g, '\n'))
  const metadata = z.object({
    name: z.literal(artifact.installationDirectory),
    description: z.string().min(1).max(1024).refine(value => Boolean(value.trim())),
    'disable-model-invocation': z.literal(false).optional(),
  }).safeParse(parsed.frontmatter)
  if (!metadata.success || !parsed.body.trim()) throw new Error('Invalid approved skill frontmatter or body.')
  validateSelfContained(parsed.body)
  // Validate normalized metadata, but install and freeze the exact authenticated bytes.
  return { content, name: metadata.data.name, description: metadata.data.description }
}

export class SkillStore {
  constructor(private readonly rootDir: string, private readonly versions?: SkillVersionStore) {}

  prepare(input: SkillStoreRequest): Promise<SkillStoreResult> {
    // Refresh platform skill metadata on every authorization; no skill update event exists.
    return this.install(input)
  }

  invalidate(_subscriptionId?: string): void {
    // Kept for the provisioner contract; installed local versions remain immutable.
  }

  private async install(input: SkillStoreRequest): Promise<SkillStoreResult> {
    checkCurrent(input)
    const response = metadataSchema.safeParse(await getEmployeeSkills(input.employeeId, input.accessToken))
    checkCurrent(input)
    if (!response.success) throw new Error('Invalid employee skill metadata.')
    const skillsResponse = response.data
    if (skillsResponse.subscriptionId !== input.subscriptionId) throw new Error('The employee skills response does not match the subscription.')
    if (new Set(skillsResponse.skills.map(skill => skill.capability.id)).size !== skillsResponse.skills.length) throw new Error('Duplicate employee skill metadata.')
    let approvedSkills = skillsResponse.skills
    if (input.runtimeSkills) {
      const runtimeSkills = z.array(employeeRuntimeSkillSchema).parse(input.runtimeSkills)
      if (new Set(runtimeSkills.map(skill => skill.capabilityId)).size !== runtimeSkills.length) throw new Error('Duplicate runtime skill.')
      approvedSkills = runtimeSkills.map(runtime => {
        const metadata = skillsResponse.skills.find(skill => skill.capability.id === runtime.capabilityId)
        const version = metadata && [metadata.currentVersion, ...metadata.versions].find(version => version.id === runtime.versionId)
        if (!metadata || !version || version.capabilityId !== runtime.capabilityId || version.version !== runtime.version || !canUseSkillVersion(version, input.memberId ?? '')) {
          throw new Error('Runtime skill version is not approved or is no longer available.')
        }
        return { ...metadata, capability: { ...metadata.capability, name: runtime.name, description: runtime.description }, currentVersion: version }
      })
    }
    const base = resolve(
      this.rootDir,
      safeSegment(input.enterpriseId),
      safeSegment(input.memberId ?? 'anonymous'),
      safeSegment(input.subscriptionId),
      'skills',
    )
    const skillRoot = base
    checkCurrent(input)
    await mkdir(skillRoot, { recursive: true })
    const paths: string[] = []
    const installed: PreparedEmployeeSkill[] = []
    const names = new Set<string>()
    for (const skill of approvedSkills) {
      checkCurrent(input)
      const scope = input.memberId ? { enterpriseId: input.enterpriseId, memberId: input.memberId } : null
      const selection = scope && this.versions ? (await this.versions.selections(scope, input.subscriptionId))[skill.capability.id] : undefined
      const selected = selection?.versionId ?? null
      const selectedVersion = selected && scope && this.versions
        ? await this.versions.load(scope, input.subscriptionId, skill.capability.id, selected)
        : null
      const isOwnerLocalVersion = Boolean(input.memberId && selectedVersion?.localSubmissionId)
      const isAutomaticSelection = selection?.automatic === true && !isOwnerLocalVersion
        && selected === `platform-${selectedVersion?.baseSkillVersionId}`
      if (!canUseSkillVersion(skill.currentVersion, input.memberId ?? '') && !isOwnerLocalVersion) continue
      const platformVersionId = `platform-${skill.currentVersion.id}`
      const cachedPlatform = scope && this.versions
        ? await this.versions.load(scope, input.subscriptionId, skill.capability.id, platformVersionId)
        : null
      const runtimeSkill = input.runtimeSkills?.find(runtime => runtime.capabilityId === skill.capability.id)
      if (input.skillArtifactProtocolVersion === 1 && runtimeSkill?.artifact === undefined) {
        throw new Error('Negotiated approved skill artifact descriptor is missing.')
      }
      if (runtimeSkill?.artifact !== undefined) {
        const artifact = skillArtifactSchema.parse(runtimeSkill.artifact)
        if (artifact.status !== 'AVAILABLE') throw new Error('Approved skill artifact is BLOCKED; preparation cannot continue.')
        if (artifact.capabilityId !== runtimeSkill.capabilityId || artifact.versionId !== runtimeSkill.versionId ||
          artifact.approvedContentSha256 !== createHash('sha256').update(runtimeSkill.content).digest('hex')) {
          throw new Error('Approved skill artifact identity or content mismatch.')
        }
        if (artifact.format !== 'single-file') throw new Error('Approved ZIP skill installation is not supported yet; no content fallback is permitted.')
        const bytes = await downloadSkillArtifact(input.subscriptionId, artifact, input.accessToken)
        checkCurrent(input)
        const entry = approvedEntry(bytes, artifact)
        if (!isOwnerLocalVersion) {
          if (selected && selected !== platformVersionId && !isAutomaticSelection) throw new Error('Selected skill version is not the currently approved runtime version.')
          if (names.has(entry.name)) throw new Error('Installed skill names collide.')
          names.add(entry.name)
          const versionKey = createHash('sha256').update(JSON.stringify([artifact.versionId, artifact.artifactSha256])).digest('hex')
          const parent = join(skillRoot, safeSegment(skill.capability.id), versionKey)
          const target = join(parent, entry.name)
          const snapshot: PreparedEmployeeSkill = {
            capabilityId: skill.capability.id, versionId: platformVersionId, baseSkillVersionId: artifact.versionId,
            version: runtimeSkill.version, source: 'approved', name: entry.name, description: entry.description,
            content: entry.content, sha256: artifact.entrySha256, path: target, artifact,
          }
          checkCurrent(input)
          await mkdir(parent, { recursive: true, mode: 0o700 })
          const temporary = await mkdtemp(join(parent, '.staging-'))
          try {
            await writeFile(join(temporary, 'SKILL.md'), bytes, { mode: 0o600 })
            await writeFile(join(temporary, 'manifest.json'), JSON.stringify(snapshot), { mode: 0o600 })
            checkCurrent(input)
            try { await rename(temporary, target) }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code
              if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
              const directory = await lstat(target)
              const file = await lstat(join(target, 'SKILL.md'))
              if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() ||
                !(await readFile(join(target, 'SKILL.md'))).equals(bytes)) throw new Error('Immutable skill entry integrity mismatch.')
            }
          } finally { await rm(temporary, { recursive: true, force: true }) }
          checkCurrent(input)
          if (scope && this.versions) {
            await this.versions.savePlatform(scope, { subscriptionId: input.subscriptionId, employeeId: input.employeeId,
              capabilityId: skill.capability.id, baseSkillVersionId: artifact.versionId, version: runtimeSkill.version, content: runtimeSkill.content })
            checkCurrent(input)
            await this.versions.selectDefault(scope, input.subscriptionId, skill.capability.id, platformVersionId)
          }
          checkCurrent(input)
          paths.push(target)
          installed.push(snapshot)
          continue
        }
      }
      const platformContent = runtimeSkill ? runtimeSkill.content : cachedPlatform?.content.trim()
        ? cachedPlatform.content
        : isOwnerLocalVersion
          ? null
          : await this.resolveSkillContent(skill, input.accessToken)
      checkCurrent(input)
      const platform = scope && this.versions && platformContent !== null
        ? (cachedPlatform && cachedPlatform.content === platformContent ? cachedPlatform : await this.versions.savePlatform(scope, {
          subscriptionId: input.subscriptionId,
          employeeId: input.employeeId,
          capabilityId: skill.capability.id,
          baseSkillVersionId: skill.currentVersion.id,
          version: skill.currentVersion.version,
          content: platformContent,
        }))
        : null
      checkCurrent(input)
      if (scope && this.versions && platform) await this.versions.selectDefault(scope, input.subscriptionId, skill.capability.id, platform.versionId)
      const activeVersionId = (isAutomaticSelection ? platform?.versionId : selected) ?? platform?.versionId ?? null
      const activeVersion = (isAutomaticSelection || selectedVersion?.versionId === platform?.versionId ? platform : selectedVersion) ?? (activeVersionId && scope && this.versions
        ? await this.versions.load(scope, input.subscriptionId, skill.capability.id, activeVersionId)
        : null)
      const availableVersions: SkillVersion[] = [skill.currentVersion, ...skill.versions]
      const selectedMetadata = activeVersion
        ? availableVersions.find(version => version.id === activeVersion.baseSkillVersionId)
        : null
      if (selected && (!activeVersion || (!isOwnerLocalVersion && !isAutomaticSelection && (
        selected !== `platform-${activeVersion.baseSkillVersionId}` ||
        !selectedMetadata ||
        !canUseSkillVersion(selectedMetadata, input.memberId ?? '')
      )))) {
        throw new Error('Selected skill version is not approved or is no longer available.')
      }
      // Personal versions track their public ancestor; a personal version ID is not a public update.
      let baseline = selectedMetadata
      const seen = new Set<string>()
      while (baseline?.scope === 'PERSONAL' && baseline.parentVersionId && !seen.has(baseline.id)) {
        seen.add(baseline.id)
        const parentId = baseline.parentVersionId
        baseline = availableVersions.find(version => version.id === parentId)
        if (!baseline) break
      }
      const publicBaseId = baseline?.id ?? selectedMetadata?.parentVersionId ?? selectedVersion?.baseSkillVersionId
      if (scope && this.versions && platform && activeVersion && !isAutomaticSelection && publicBaseId !== platform.baseSkillVersionId) {
        checkCurrent(input)
        await this.versions.markPending(scope, input.subscriptionId, skill.capability.id, platform.versionId)
      }
      const content = selected ? activeVersion?.content : platform?.content ?? platformContent
      if (!content?.trim()) throw new Error('Approved skill entry is empty or unavailable.')
      const entry = skillEntry(content, skill)
      if (names.has(entry.name)) throw new Error('Installed skill names collide.')
      names.add(entry.name)
      const versionId = activeVersion?.versionId ?? platform?.versionId ?? `platform-${skill.currentVersion.id}`
      const version = activeVersion?.version ?? platform?.version ?? skill.currentVersion.version
      const sha256 = createHash('sha256').update(entry.content).digest('hex')
      const versionKey = createHash('sha256').update(JSON.stringify([versionId, version])).digest('hex')
      const parent = join(skillRoot, safeSegment(skill.capability.id), `${versionKey}-${sha256}`)
      const target = join(parent, entry.name)
      const snapshot: PreparedEmployeeSkill = {
        capabilityId: skill.capability.id, versionId,
        baseSkillVersionId: activeVersion?.baseSkillVersionId ?? skill.currentVersion.id,
        version, source: isOwnerLocalVersion ? 'owner-local' : 'approved',
        name: entry.name, description: entry.description, content: entry.content, sha256, path: target,
      }
      checkCurrent(input)
      await mkdir(parent, { recursive: true })
      const temporary = await mkdtemp(join(parent, '.staging-'))
      try {
        await writeFile(join(temporary, 'SKILL.md'), entry.content, { encoding: 'utf8', mode: 0o600 })
        await writeFile(join(temporary, 'manifest.json'), JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
        checkCurrent(input)
        try {
          await rename(temporary, target)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
          const existing = await readFile(join(target, 'SKILL.md'), 'utf8')
          if (existing !== entry.content) throw new Error('Immutable skill entry integrity mismatch.')
        }
      } finally {
        // Only this operation's private staging tree can be deleted; published paths stay alive.
        await rm(temporary, { recursive: true, force: true })
      }
      checkCurrent(input)
      paths.push(target)
      installed.push(snapshot)
    }
    return { skillPaths: paths, skills: installed }
  }

  private async resolveSkillContent(skill: SkillMetadata, accessToken: string): Promise<string | null> {
    if (!skill.currentVersion.id) return null
    const preview = await previewSkill(skill.currentVersion.id, accessToken)
    if (!preview || typeof preview.content !== 'string' || !preview.content.trim()) throw new Error('Approved skill preview is empty or unavailable.')
    return preview.content
  }
}

