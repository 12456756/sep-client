import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

  async clear(subscriptionId?: string): Promise<void> {
    if (!subscriptionId) return
    const root = join(this.userDataDir, 'runtime', subscriptionId)
    await rm(root, { recursive: true, force: true })
  }

  private async prepareInternal(subscription: SubscriptionSnapshot, accessToken: string, enterpriseId: string): Promise<PreparedSubscriptionRuntime> {
    const packageInfo = await getPackageInfo(accessToken, subscription.subscriptionId)
    this.assertPackageVersion(subscription, packageInfo)
    const runtimeRoot = join(this.userDataDir, 'runtime', safeSegment(enterpriseId), safeSegment(subscription.subscriptionId))
    const versionRoot = join(runtimeRoot, safeSegment(packageInfo.version))
    const manifestPath = join(versionRoot, 'runtime-manifest.json')
    const cached = await this.readManifest(manifestPath)
    if (cached && this.matchesManifest(cached, subscription, packageInfo)) {
      return this.toPrepared(versionRoot, cached)
    }

    const stagingRoot = join(runtimeRoot, `.install-${randomUUID()}`)
    const backupRoot = join(runtimeRoot, `.backup-${randomUUID()}`)
    await mkdir(runtimeRoot, { recursive: true })
    try {
      await mkdir(stagingRoot, { recursive: true })
      const packageSha256 = await this.installPackage(stagingRoot, packageInfo, subscription, accessToken)
      const skills = await this.syncSkills(stagingRoot, accessToken, subscription)
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
    if (packageInfo.packageRef?.type === 'npm' && !EXACT_NPM_SPEC.test(packageInfo.packageRef.spec)) {
      throw new SubscriptionRuntimeError('SEP returned a non-pinned npm package reference.')
    }
    if (packageInfo.packageRef?.type === 'git') {
      const hash = packageInfo.packageRef.spec.split('#').pop() ?? ''
      if (!FULL_GIT_COMMIT.test(hash)) throw new SubscriptionRuntimeError('SEP returned a git package without an immutable commit.')
    }
  }

  private async installPackage(stagingRoot: string, packageInfo: PackageInfo, subscription: SubscriptionSnapshot, accessToken: string): Promise<string | null> {
    if (packageInfo.packageRef?.type === 'npm' || packageInfo.packageRef?.type === 'git') {
      await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', stagingRoot, packageInfo.packageRef.spec], {
        timeout: 5 * 60 * 1000,
        maxBuffer: 2 * 1024 * 1024,
      })
      return await hashPackageFiles(stagingRoot)
    }
    if (!packageInfo.zipAvailable) throw new SubscriptionRuntimeError('SEP has no installable package reference or ZIP fallback.')
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
    await execFile('unzip', ['-q', archive, '-d', stagingRoot], { timeout: 2 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 })
    await rm(archive, { force: true })
    return digest
  }

  private async syncSkills(stagingRoot: string, accessToken: string, subscription: SubscriptionSnapshot): Promise<InstalledSkill[]> {
    const response = await getEmployeeSkills(accessToken, subscription.employeeId)
    const skillsRoot = join(stagingRoot, 'skills')
    await mkdir(skillsRoot, { recursive: true })
    const installed: InstalledSkill[] = []
    for (const entry of response.skills) {
      const version = entry.currentVersion
      if (!version || !APPROVED_STATUSES.has(version.status)) continue
      const preview = await getSkillPreview(accessToken, version.id)
      if (!APPROVED_STATUSES.has(preview.version.status)) continue
      const name = safeSegment(entry.capability.name || entry.capability.id)
      const skillDir = join(skillsRoot, name)
      const skillPath = join(skillDir, 'SKILL.md')
      await mkdir(skillDir, { recursive: true })
      const content = `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(entry.capability.description || entry.capability.name)}\n---\n\n${limitMarkdown(preview.content)}\n`
      await writeFile(skillPath, content, { mode: 0o600 })
      installed.push({ skillVersionId: version.id, capabilityId: entry.capability.id, version: version.version, path: join('skills', name, 'SKILL.md') })
    }
    return installed
  }

  private async readManifest(path: string): Promise<RuntimeManifest | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as RuntimeManifest
      return value?.schemaVersion === 1 && Array.isArray(value.skills) ? value : null
    } catch { return null }
  }

  private matchesManifest(manifest: RuntimeManifest, subscription: SubscriptionSnapshot, packageInfo: PackageInfo): boolean {
    return manifest.subscriptionId === subscription.subscriptionId &&
      manifest.employeeId === subscription.employeeId &&
      manifest.packageVersion === packageInfo.version &&
      JSON.stringify(manifest.packageRef) === JSON.stringify(packageInfo.packageRef)
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
      skillPaths: [...new Set([...packageSkillPaths, ...manifest.skills.map(skill => join(versionRoot, skill.path))])],
      installedSkills: manifest.skills,
      agentsFiles: agentsContent ? [{ path: agentsPath, content: limitMarkdown(agentsContent) }] : [],
      systemPrompt: systemPrompt ? limitMarkdown(systemPrompt) : undefined,
    }
  }
}

async function hashPackageFiles(root: string): Promise<string | null> {
  const hash = createHash('sha256')
  let included = false
  for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
    try {
      hash.update(name)
      hash.update(await readFile(join(root, name)))
      included = true
    } catch {
      // A git package may not have a lockfile; package.json is still enough for a diagnostic hash.
    }
  }
  return included ? hash.digest('hex') : null
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

async function readOptionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch { return null }
}
