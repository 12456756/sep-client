import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { join, relative } from 'node:path'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import {
  getEmployeeSkills,
  getPackageInfo,
  getSkillPreview,
  type PackageInfo,
  type SubscriptionSnapshot,
} from '../auth/auth-api'
import type { PackageRef } from '../../src/shared/types'
import { config } from '../infrastructure/config'

const execFile = promisify(execFileCallback)
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 10_000
const EXACT_NPM_SPEC = /^(?:@[^/\s]+\/)?[^@\s]+@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/i
const APPROVED_STATUSES = new Set(['PLATFORM_APPROVED', 'APPROVED', 'PUBLISHED'])

export interface InstalledSkill {
  skillVersionId: string
  capabilityId: string
  version: string
  path: string
}

export interface PreparedSubscriptionRuntime {
  subscriptionId: string
  employeeId: string
  packageVersion: string
  packageRef: PackageRef | null
  packageSha256: string | null
  runtimeDir: string
  skillsDir: string
  skillPaths: string[]
  installedSkills: InstalledSkill[]
  agentsFiles: Array<{ path: string; content: string }>
  systemPrompt: string | undefined
}

interface RuntimeManifest {
  schemaVersion: 1
  subscriptionId: string
  employeeId: string
  packageVersion: string
  packageRef: PackageRef | null
  packageSha256: string | null
  installedAt: string
  installerVersion: string
  skills: InstalledSkill[]
}

interface ApprovedSkillVersion {
  skillVersionId: string
  capabilityId: string
  capabilityName: string
  capabilityDescription: string | null | undefined
  version: string
}

export class SubscriptionRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SubscriptionRuntimeError'
  }
}

export class SubscriptionRuntimeManager {
  private readonly inFlight = new Map<string, Promise<PreparedSubscriptionRuntime>>()

  constructor(
    private readonly userDataDir: string,
    private readonly installerVersion: string,
  ) {}

  prepare(subscription: SubscriptionSnapshot, accessToken: string, enterpriseId: string): Promise<PreparedSubscriptionRuntime> {
    const existing = this.inFlight.get(subscription.subscriptionId)
    if (existing) return existing
    const operation = this.prepareInternal(subscription, accessToken, enterpriseId).finally(() => {
      if (this.inFlight.get(subscription.subscriptionId) === operation) this.inFlight.delete(subscription.subscriptionId)
    })
    this.inFlight.set(subscription.subscriptionId, operation)
    return operation
  }

  async clear(subscriptionId?: string, enterpriseId?: string): Promise<void> {
    const runtimeRoot = join(this.userDataDir, 'runtime')
    if (!subscriptionId) {
      await rm(runtimeRoot, { recursive: true, force: true })
      return
    }
    if (enterpriseId) {
      await rm(join(runtimeRoot, safeSegment(enterpriseId), safeSegment(subscriptionId)), { recursive: true, force: true })
      return
    }
    for (const enterprise of await listDirectories(runtimeRoot)) {
      await rm(join(runtimeRoot, enterprise, safeSegment(subscriptionId)), { recursive: true, force: true })
    }
  }

  private async prepareInternal(subscription: SubscriptionSnapshot, accessToken: string, enterpriseId: string): Promise<PreparedSubscriptionRuntime> {
    const packageInfo = await getPackageInfo(accessToken, subscription.subscriptionId)
    this.assertPackageVersion(subscription, packageInfo)
    const runtimeRoot = join(this.userDataDir, 'runtime', safeSegment(enterpriseId), safeSegment(subscription.subscriptionId))
    const versionRoot = join(runtimeRoot, safeSegment(packageInfo.version))
    const manifestPath = join(versionRoot, 'runtime-manifest.json')
    const approvedSkills = await this.listApprovedSkills(accessToken, subscription)
    const cached = await this.readManifest(manifestPath)
    if (cached && this.matchesManifest(cached, subscription, packageInfo, approvedSkills)) {
      return this.toPrepared(versionRoot, cached)
    }

    const stagingRoot = join(runtimeRoot, `.install-${randomUUID()}`)
    const backupRoot = join(runtimeRoot, `.backup-${randomUUID()}`)
    await mkdir(runtimeRoot, { recursive: true })
    try {
      await mkdir(stagingRoot, { recursive: true })
      const packageSha256 = await this.installPackage(stagingRoot, packageInfo, subscription, accessToken)
      const skills = await this.syncSkills(stagingRoot, accessToken, approvedSkills)
      const manifest: RuntimeManifest = {
        schemaVersion: 1,
        subscriptionId: subscription.subscriptionId,
        employeeId: subscription.employeeId,
        packageVersion: packageInfo.version,
        packageRef: packageInfo.packageRef,
        packageSha256,
        installedAt: new Date().toISOString(),
        installerVersion: this.installerVersion,
        skills,
      }
      await writeFile(join(stagingRoot, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
      if (await pathExists(versionRoot)) await rename(versionRoot, backupRoot)
      await rename(stagingRoot, versionRoot)
      await rm(backupRoot, { recursive: true, force: true })
      return this.toPrepared(versionRoot, manifest)
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      if (await pathExists(backupRoot) && !await pathExists(versionRoot)) await rename(backupRoot, versionRoot).catch(() => undefined)
      throw error instanceof SubscriptionRuntimeError
        ? error
        : new SubscriptionRuntimeError('Employee package installation failed.', { cause: error })
    }
  }

  private assertPackageVersion(subscription: SubscriptionSnapshot, packageInfo: PackageInfo): void {
    if (!packageInfo.version || packageInfo.version !== subscription.templateVersion) {
      throw new SubscriptionRuntimeError(`The subscription is locked to package ${subscription.templateVersion}, but SEP returned ${packageInfo.version || 'no version'}.`)
    }
    assertPackageRefMatchesVersion(packageInfo)
  }

  private async installPackage(stagingRoot: string, packageInfo: PackageInfo, subscription: SubscriptionSnapshot, accessToken: string): Promise<string | null> {
    if (packageInfo.packageRef?.type === 'npm' || packageInfo.packageRef?.type === 'git') {
      await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', stagingRoot, packageInfo.packageRef.spec], {
        timeout: 5 * 60 * 1000,
        maxBuffer: 2 * 1024 * 1024,
      })
      return await hashPackageFiles(stagingRoot)
    }
    assertZipFallbackInstallable(packageInfo)
    const response = await fetch(`${config.SEP_BASE_URL}/digital-employees/${encodeURIComponent(subscription.employeeId)}/package/download`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) throw new SubscriptionRuntimeError(`Employee ZIP download failed with HTTP ${response.status}.`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new SubscriptionRuntimeError('Employee ZIP exceeds the client size limit.')
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (packageInfo.sha256 && packageInfo.sha256.toLowerCase() !== digest) throw new SubscriptionRuntimeError('Employee ZIP SHA-256 verification failed.')
    const archive = join(stagingRoot, '.package.zip')
    await writeFile(archive, bytes, { mode: 0o600 })
    await inspectZipArchive(archive)
    await execFile('unzip', ['-q', archive, '-d', stagingRoot], { timeout: 2 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 })
    await rm(archive, { force: true })
    await assertNoSymbolicLinks(stagingRoot)
    return digest
  }

  private async listApprovedSkills(accessToken: string, subscription: SubscriptionSnapshot): Promise<ApprovedSkillVersion[]> {
    const response = await getEmployeeSkills(accessToken, subscription.employeeId)
    const approved: ApprovedSkillVersion[] = []
    for (const entry of response.skills) {
      const version = entry.currentVersion
      if (!version || !APPROVED_STATUSES.has(version.status)) continue
      approved.push({
        skillVersionId: version.id,
        capabilityId: entry.capability.id,
        capabilityName: entry.capability.name || entry.capability.id,
        capabilityDescription: entry.capability.description,
        version: version.version,
      })
    }
    return approved
  }

  private async syncSkills(stagingRoot: string, accessToken: string, approvedSkills: ApprovedSkillVersion[]): Promise<InstalledSkill[]> {
    const skillsRoot = join(stagingRoot, 'skills')
    await mkdir(skillsRoot, { recursive: true })
    const installed: InstalledSkill[] = []
    for (const entry of approvedSkills) {
      const preview = await getSkillPreview(accessToken, entry.skillVersionId)
      if (!APPROVED_STATUSES.has(preview.version.status)) continue
      const name = safeSegment(entry.capabilityName)
      const skillDir = join(skillsRoot, name)
      const skillPath = join(skillDir, 'SKILL.md')
      await mkdir(skillDir, { recursive: true })
      const content = `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(entry.capabilityDescription || entry.capabilityName)}\n---\n\n${limitMarkdown(preview.content)}\n`
      await writeFile(skillPath, content, { mode: 0o600 })
      installed.push({ skillVersionId: entry.skillVersionId, capabilityId: entry.capabilityId, version: entry.version, path: join('skills', name, 'SKILL.md') })
    }
    return installed
  }

  private async readManifest(path: string): Promise<RuntimeManifest | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as RuntimeManifest
      return value?.schemaVersion === 1 && Array.isArray(value.skills) ? value : null
    } catch { return null }
  }

  private matchesManifest(manifest: RuntimeManifest, subscription: SubscriptionSnapshot, packageInfo: PackageInfo, approvedSkills: ApprovedSkillVersion[]): boolean {
    return manifest.subscriptionId === subscription.subscriptionId &&
      manifest.employeeId === subscription.employeeId &&
      manifest.packageVersion === packageInfo.version &&
      manifest.installerVersion === this.installerVersion &&
      JSON.stringify(manifest.packageRef) === JSON.stringify(packageInfo.packageRef) &&
      sameSkillSelection(manifest.skills, approvedSkills)
  }

  private async toPrepared(versionRoot: string, manifest: RuntimeManifest): Promise<PreparedSubscriptionRuntime> {
    const skillsDir = join(versionRoot, 'skills')
    const agentsPath = join(versionRoot, 'AGENTS.md')
    const systemPromptPath = join(versionRoot, 'SYSTEM.md')
    const [agentsContent, systemPrompt] = await Promise.all([
      readOptionalFile(agentsPath),
      readOptionalFile(systemPromptPath),
    ])
    const packageSkillPaths = (await Promise.all([
      pathExists(join(versionRoot, '.pi', 'skills')).then(exists => exists ? join(versionRoot, '.pi', 'skills') : null),
      pathExists(join(versionRoot, 'skills')).then(exists => exists ? skillsDir : null),
    ])).filter((path): path is string => Boolean(path))
    return {
      subscriptionId: manifest.subscriptionId,
      employeeId: manifest.employeeId,
      packageVersion: manifest.packageVersion,
      packageRef: manifest.packageRef,
      packageSha256: manifest.packageSha256,
      runtimeDir: versionRoot,
      skillsDir,
      skillPaths: [...new Set(packageSkillPaths)],
      installedSkills: manifest.skills,
      agentsFiles: agentsContent ? [{ path: agentsPath, content: limitMarkdown(agentsContent) }] : [],
      systemPrompt: systemPrompt ? limitMarkdown(systemPrompt) : undefined,
    }
  }
}

async function hashPackageFiles(root: string): Promise<string | null> {
  const hash = createHash('sha256')
  const files = await listFiles(root)
  for (const file of files) {
    const path = relative(root, file).replaceAll('\\', '/')
    if (path === 'runtime-manifest.json' || path === '.package.zip') continue
    hash.update(path)
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return files.length ? hash.digest('hex') : null
}

function npmSpecVersion(spec: string): string {
  return spec.slice(spec.lastIndexOf('@') + 1)
}

export function assertPackageRefMatchesVersion(packageInfo: PackageInfo): void {
  if (packageInfo.packageRef?.type === 'npm') {
    if (!EXACT_NPM_SPEC.test(packageInfo.packageRef.spec)) {
      throw new SubscriptionRuntimeError('SEP returned a non-pinned npm package reference.')
    }
    if (npmSpecVersion(packageInfo.packageRef.spec) !== packageInfo.version) {
      throw new SubscriptionRuntimeError('SEP returned an npm package reference that does not match the locked package version.')
    }
  }
  if (packageInfo.packageRef?.type === 'git') {
    const hash = packageInfo.packageRef.spec.split('#').pop() ?? ''
    if (!FULL_GIT_COMMIT.test(hash)) throw new SubscriptionRuntimeError('SEP returned a git package without an immutable commit.')
  }
}

export function assertZipFallbackInstallable(packageInfo: PackageInfo): void {
  if (!packageInfo.zipAvailable) throw new SubscriptionRuntimeError('SEP has no installable package reference or ZIP fallback.')
  if (!packageInfo.sha256) throw new SubscriptionRuntimeError('SEP must provide SHA-256 for ZIP package installation.')
}

export const runtimeTestInternals = {
  hashPackageFiles,
  sameSkillSelection,
  assertSafeZipEntries,
  assertSafeZipMetadata,
}

async function inspectZipArchive(archive: string): Promise<void> {
  const [{ stdout: names }, { stdout: metadata }] = await Promise.all([
    execFile('unzip', ['-Z1', archive], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }),
    execFile('zipinfo', ['-l', archive], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }),
  ])
  assertSafeZipEntries(names.split(/\r?\n/).filter(Boolean))
  assertSafeZipMetadata(metadata)
}

function assertSafeZipEntries(entries: string[]): void {
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new SubscriptionRuntimeError('Employee ZIP has an invalid number of entries.')
  }
  for (const rawEntry of entries) {
    const entry = rawEntry.replaceAll('\\', '/')
    const segments = entry.split('/')
    if (
      entry.includes('\0') ||
      entry.length > 1_024 ||
      entry.startsWith('/') ||
      /^[A-Za-z]:\//.test(entry) ||
      segments.some(segment => segment === '..')
    ) {
      throw new SubscriptionRuntimeError('Employee ZIP contains an unsafe path.')
    }
  }
}

function assertSafeZipMetadata(metadata: string): void {
  let entryCount = 0
  let uncompressedBytes = 0
  for (const line of metadata.split(/\r?\n/)) {
    const match = /^([bcdlps-])[rwxStTs-]{9}\s+\S+\s+\S+\s+(\d+)\s/.exec(line)
    if (!match) continue
    entryCount += 1
    if (match[1] !== '-' && match[1] !== 'd') {
      throw new SubscriptionRuntimeError('Employee ZIP contains a link or special file.')
    }
    uncompressedBytes += Number(match[2])
    if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_PACKAGE_BYTES) {
      throw new SubscriptionRuntimeError('Employee ZIP exceeds the uncompressed size limit.')
    }
  }
  if (entryCount === 0 || entryCount > MAX_ARCHIVE_ENTRIES) {
    throw new SubscriptionRuntimeError('Employee ZIP metadata is invalid.')
  }
}

async function assertNoSymbolicLinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new SubscriptionRuntimeError('Employee package contains a symbolic link.')
    if (stats.isDirectory()) await assertNoSymbolicLinks(path)
  }
}

function sameSkillSelection(installed: InstalledSkill[], approved: ApprovedSkillVersion[]): boolean {
  if (installed.length !== approved.length) return false
  const installedIds = new Set(installed.map(skill => `${skill.capabilityId}:${skill.skillVersionId}:${skill.version}`))
  return approved.every(skill => installedIds.has(`${skill.capabilityId}:${skill.skillVersionId}:${skill.version}`))
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.length > 128) throw new SubscriptionRuntimeError('Unsafe runtime path segment.')
  return normalized
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]/g, ' ').slice(0, 500))
}

function limitMarkdown(value: string): string {
  return typeof value === 'string' ? value.slice(0, 512 * 1024) : ''
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

async function listDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries.map(async entry => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return listFiles(path)
    return entry.isFile() ? [path] : []
  }))
  return files.flat().sort()
}

async function readOptionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null }
}
