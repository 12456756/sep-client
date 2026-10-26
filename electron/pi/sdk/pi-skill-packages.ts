import { canUseSkillVersion } from '../../common/platform/skill-version-policy'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { SkillVersionStore } from '../../data/skill-version-store'
import { WriteChain } from '../../data/write-chain'
import { getEmployeeSkills, previewSkill, type SkillVersion } from '../../common/platform/platform-api'
import { employeeRuntimeSkillSchema, type EmployeeRuntimeSkill, type PreparedEmployeeSkill } from '../../common/platform/employee-runtime-contract'
import { downloadSkillArtifact } from '../../common/platform/skill-artifact-api'
import { skillArtifactSchema, skillArtifactNameSchema, skillArtifactFrontmatterSchema, skillNameComparisonKey, maxSkillEntryBytes, type SkillArtifactAvailable } from '../../common/platform/skill-artifact-contract'
import { z } from 'zod'
import { AppError } from '../../errors/app-error'
import { parseSkillMarkdown, validatedSkillMarkdown, validateSkillResources, approvedPackageBody, matchesApprovedSkillMarkdown } from './skill-package-parser'
import { logger } from '../../common/logger'
import { readSkillZip, packageCache, packageManifestName, packageSha256, safePackagePath, verifyPackageCache, assertSkillPathParents, type SkillPackageFile } from './skill-package-zip'

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
    }).nullable(),
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

export async function publishSkillDirectory(
  source: string,
  target: string,
  verifyExisting: () => Promise<void>,
  move: typeof rename = rename,
): Promise<void> {
  try {
    await move(source, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    let collision = code === 'EEXIST' || code === 'ENOTEMPTY'
    if (code === 'EPERM') {
      try {
        const destination = await lstat(target)
        collision = destination.isDirectory() && !destination.isSymbolicLink()
      } catch {
        collision = false
      }
    }
    if (!collision) throw error
    await verifyExisting()
  }
}

function fallbackName(capabilityId: string): string {
  if (skillArtifactNameSchema.safeParse(capabilityId).success) return capabilityId
  return `skill-${createHash('sha256').update(capabilityId).digest('hex').slice(0, 24)}`
}

function skillEntry(content: string, skill: SkillMetadata): { content: string; name: string; description: string } {
  const parsed = parseSkillMarkdown(content)
  const hasFrontmatter = parsed.hasFrontmatter
  const metadata = hasFrontmatter ? parsed.frontmatter : {
    name: fallbackName(skill.capability.id),
    description: skill.capability.description?.trim() || skill.capability.name,
  }
  const valid = skillArtifactFrontmatterSchema.safeParse(metadata)
  if (!valid.success) throw new Error('Skill frontmatter requires a valid name and description.')
  if (!parsed.body.trim()) throw new Error('Approved skill entry is empty.')
  validateSkillResources(parsed.body)
  const entry = hasFrontmatter ? content : `---\nname: ${JSON.stringify(valid.data.name)}\ndescription: ${JSON.stringify(valid.data.description)}\n---\n\n${content}`
  validatedSkillMarkdown(entry)
  return { content: entry, name: valid.data.name, description: valid.data.description }
}

function safeSegment(value: string): string {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid subscription runtime identifier.')
  return value
}

function approvedEntry(bytes: Buffer, artifact: SkillArtifactAvailable, approvedContent: string): { content: string; name: string; description: string; files: SkillPackageFile[] } {
  if (bytes.length !== artifact.byteLength || packageSha256(bytes) !== artifact.artifactSha256) {
    throw new Error('Approved skill artifact integrity mismatch.')
  }
  const files = artifact.format === 'zip' ? readSkillZip(bytes, artifact) : [{ path: 'SKILL.md', bytes }]
  const entry = files.find(file => file.path === artifact.entryPath)
  if (!entry || entry.bytes.length > maxSkillEntryBytes || packageSha256(entry.bytes) !== artifact.entrySha256 ||
    artifact.format === 'single-file' && (artifact.entryPath !== 'SKILL.md' || artifact.fileCount !== 1)) {
    throw new Error('Approved skill artifact integrity mismatch.')
  }
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.bytes) }
  catch { throw new Error('Approved skill entry is not valid UTF-8.') }
  const parsed = validatedSkillMarkdown(content)
  const metadata = parsed.metadata
  if (content !== approvedContent && !matchesApprovedSkillMarkdown(content, approvedContent)
    && !(artifact.format === 'zip' && approvedPackageBody(content) === approvedContent)) {
    logger.child('skill-packages').warn('approved skill content comparison failed', {
      capabilityId: artifact.capabilityId, versionId: artifact.versionId, format: artifact.format,
      approvedContentSha256: artifact.approvedContentSha256, entrySha256: artifact.entrySha256,
      approvedByteLength: Buffer.byteLength(approvedContent, 'utf8'), entryByteLength: entry.bytes.length,
    })
    throw new AppError('SKILL_CONTENT_MISMATCH', {
      cause: new Error('Approved skill artifact content mismatch.'),
      details: { capabilityId: artifact.capabilityId, versionId: artifact.versionId, format: artifact.format },
    })
  }
  if (!safePackagePath(metadata.name) || skillNameComparisonKey(metadata.name) !== skillNameComparisonKey(artifact.installationDirectory)
    || artifact.format === 'zip' && dirname(artifact.entryPath) !== '.' && skillNameComparisonKey(basename(dirname(artifact.entryPath))) !== skillNameComparisonKey(metadata.name)) throw new Error('Invalid approved skill frontmatter or directory.')
  validateSkillResources(parsed.body, artifact.entryPath, new Set(files.filter(file => !file.directory).map(file => file.path)))
  // Validate normalized metadata, but install and freeze the exact authenticated bytes.
  return { content, name: metadata.name, description: metadata.description, files }
}

const preparations = new WriteChain()

async function reusePackage(packageRoot: string, entryPath: string, cache: Buffer): Promise<boolean> {
  assertSkillPathParents(packageRoot)
  let directory: Awaited<ReturnType<typeof lstat>>
  try { directory = await lstat(packageRoot) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const entryFile = join(packageRoot, entryPath)
    if (!directory.isDirectory() || directory.isSymbolicLink() || !(await readFile(join(dirname(entryFile), packageManifestName))).equals(cache)) throw new Error()
    verifyPackageCache(entryFile, cache)
  } catch { throw new Error('Immutable skill entry integrity mismatch.') }
  return true
}

export class SkillStore {
  private generation = 0
  private readonly revisions = new Map<string, number>()
  constructor(private readonly rootDir: string, private readonly versions?: SkillVersionStore) {}

  prepare(input: SkillStoreRequest): Promise<SkillStoreResult> {
    const generation = this.generation, revision = this.revisions.get(input.subscriptionId)
    const current = { ...input, isCurrent: () => generation === this.generation && revision === this.revisions.get(input.subscriptionId) && (input.isCurrent?.() ?? true) }
    const key = JSON.stringify([resolve(this.rootDir), input.enterpriseId, input.memberId ?? 'anonymous', input.subscriptionId, generation, revision])
    // Each authorization keeps its own input; queued preparations reuse the installed package.
    return preparations.run(key, () => this.install(current))
  }

  invalidate(subscriptionId?: string): void {
    if (subscriptionId) this.revisions.set(subscriptionId, (this.revisions.get(subscriptionId) ?? 0) + 1)
    else { this.generation++; this.revisions.clear() }
  }

  private async artifactEntry(input: SkillStoreRequest, skillRoot: string, artifact: SkillArtifactAvailable, content: string): Promise<ReturnType<typeof approvedEntry>> {
    const parent = join(skillRoot, safeSegment(artifact.capabilityId))
    const versionKey = createHash('sha256').update(JSON.stringify([artifact.versionId, artifact.artifactSha256])).digest('hex')
    const path = join(parent, `${versionKey}.artifact`)
    assertSkillPathParents(path)
    let cached = false
    try {
      const file = await lstat(path)
      if (!file.isFile() || file.nlink !== 1 || file.size !== artifact.byteLength) throw new Error('Approved skill artifact integrity mismatch.')
      cached = true
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const bytes = cached ? await readFile(path) : await downloadSkillArtifact(input.subscriptionId, artifact, input.accessToken, { assertCurrent: () => checkCurrent(input) })
    checkCurrent(input)
    const entry = approvedEntry(bytes, artifact, content)
    if (!cached) {
      await mkdir(parent, { recursive: true, mode: 0o700 })
      assertSkillPathParents(parent)
      const temporary = await mkdtemp(join(parent, '.artifact-'))
      try {
        await writeFile(join(temporary, 'package'), bytes, { mode: 0o600, flag: 'wx' })
        checkCurrent(input)
        await rename(join(temporary, 'package'), path)
      } finally { await rm(temporary, { recursive: true, force: true }) }
    }
    return entry
  }

  private async install(input: SkillStoreRequest): Promise<SkillStoreResult> {
    checkCurrent(input)
    const response = metadataSchema.safeParse(await getEmployeeSkills(input.employeeId, input.accessToken))
    checkCurrent(input)
    if (!response.success) throw new Error('Invalid employee skill metadata.')
    const skillsResponse = response.data
    if (skillsResponse.subscriptionId !== input.subscriptionId) throw new Error('The employee skills response does not match the subscription.')
    if (new Set(skillsResponse.skills.map(skill => skill.capability.id)).size !== skillsResponse.skills.length) throw new Error('Duplicate employee skill metadata.')
    let approvedSkills = skillsResponse.skills.filter(
      (skill): skill is SkillMetadata & { currentVersion: NonNullable<SkillMetadata['currentVersion']> } => skill.currentVersion !== null,
    )
    if (input.runtimeSkills) {
      const runtimeSkills = z.array(employeeRuntimeSkillSchema).parse(input.runtimeSkills)
      if (new Set(runtimeSkills.map(skill => skill.capabilityId)).size !== runtimeSkills.length) throw new Error('Duplicate runtime skill.')
      approvedSkills = runtimeSkills.map(runtime => {
        const metadata = skillsResponse.skills.find(skill => skill.capability.id === runtime.capabilityId)
        const version = metadata && [metadata.currentVersion, ...metadata.versions].find(version => version?.id === runtime.versionId)
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
    assertSkillPathParents(skillRoot)
    await mkdir(skillRoot, { recursive: true })
    const paths: string[] = []
    const installed: PreparedEmployeeSkill[] = []
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
        if (!isOwnerLocalVersion && selected && selected !== platformVersionId && !isAutomaticSelection) throw new Error('Selected skill version is not the currently approved runtime version.')
        const entry = await this.artifactEntry(input, skillRoot, artifact, runtimeSkill.content)
        checkCurrent(input)
        if (!isOwnerLocalVersion) {
          const versionKey = createHash('sha256').update(JSON.stringify([artifact.versionId, artifact.artifactSha256])).digest('hex')
          const parent = join(skillRoot, safeSegment(skill.capability.id), versionKey)
          const packageRoot = join(parent, entry.name)
          const target = join(packageRoot, dirname(artifact.entryPath))
          const snapshot: PreparedEmployeeSkill = {
            capabilityId: skill.capability.id, versionId: platformVersionId, baseSkillVersionId: artifact.versionId,
            version: runtimeSkill.version, source: 'approved', name: entry.name, description: entry.description,
            content: entry.content, sha256: artifact.entrySha256, path: target, artifact,
          }
          checkCurrent(input)
          assertSkillPathParents(parent)
          await mkdir(parent, { recursive: true, mode: 0o700 })
          assertSkillPathParents(parent)
          const installedFiles = artifact.format === 'single-file'
            ? [...entry.files, { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(snapshot)) }]
            : entry.files
          const cache = Buffer.from(JSON.stringify({ ...snapshot, ...packageCache(installedFiles, artifact.entryPath) }))
          if (!await reusePackage(packageRoot, artifact.entryPath, cache)) {
            const temporary = await mkdtemp(join(parent, '.staging-'))
            try {
              for (const file of installedFiles) {
                const path = join(temporary, file.path)
                if (file.directory) { await mkdir(path, { recursive: true, mode: 0o700 }); continue }
                await mkdir(dirname(path), { recursive: true, mode: 0o700 })
                await writeFile(path, file.bytes, { mode: 0o600, flag: 'wx' })
              }
              const stagedEntry = join(temporary, artifact.entryPath)
              await writeFile(join(dirname(stagedEntry), packageManifestName), cache, { mode: 0o600, flag: 'wx' })
              verifyPackageCache(stagedEntry, cache)
              checkCurrent(input)
              await publishSkillDirectory(temporary, packageRoot, async () => {
                if (!await reusePackage(packageRoot, artifact.entryPath, cache)) throw new Error('Immutable skill entry integrity mismatch.')
              })
            } finally { await rm(temporary, { recursive: true, force: true }) }
          }
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
      if (!safePackagePath(entry.name)) throw new Error('Invalid skill installation directory.')
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
      assertSkillPathParents(parent)
      await mkdir(parent, { recursive: true })
      assertSkillPathParents(parent)
      const temporary = await mkdtemp(join(parent, '.staging-'))
      try {
        await writeFile(join(temporary, 'SKILL.md'), entry.content, { encoding: 'utf8', mode: 0o600 })
        await writeFile(join(temporary, 'manifest.json'), JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
        checkCurrent(input)
        await publishSkillDirectory(temporary, target, async () => {
          const existing = await readFile(join(target, 'SKILL.md'), 'utf8')
          if (existing !== entry.content) throw new Error('Immutable skill entry integrity mismatch.')
        })
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
    if (!skill.currentVersion?.id) return null
    const preview = await previewSkill(skill.currentVersion.id, accessToken)
    if (!preview || typeof preview.content !== 'string' || !preview.content.trim()) throw new Error('Approved skill preview is empty or unavailable.')
    return preview.content
  }
}

