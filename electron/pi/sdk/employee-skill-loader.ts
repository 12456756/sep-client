import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PiLoadSkills, PiResourceLoaderOptions, PiSkill } from './pi-coding-agent-adapter'
import { validatedSkillMarkdown } from './skill-package-parser'
import { assertSkillPathParents, packageManifestName, verifyPackageCache } from './skill-package-zip'
import { allocateSkillNames } from './skill-runtime-names'

function integrityMismatch(): never {
  throw new Error('Employee runtime skill loader integrity mismatch.')
}

function canonicalEntry(path: string): string {
  assertSkillPathParents(path)
  return realpathSync(path)
}

/** Constrain employee sessions to the immutable entries prepared by the authorizer. */
export function employeeSkillLoaderOptions(
  cwd: string,
  agentDir: string,
  paths: readonly string[] | undefined,
  loadSkills: PiLoadSkills,
  commonPaths: readonly string[] = [],
): Pick<PiResourceLoaderOptions, 'noSkills' | 'skillsOverride'> {
  // Ordinary sessions retain Pi's workstation/project skill discovery.
  if (paths === undefined && commonPaths.length === 0) return { noSkills: false }

  const directories = [...new Set([...(paths ?? []), ...commonPaths].map(path => resolve(cwd, path)))]
  const entries = directories.map(path => join(path, 'SKILL.md'))
  const common = new Set(commonPaths.map(path => join(resolve(cwd, path), 'SKILL.md')))
  const expected = new Map(entries.map(path => {
    try {
      const stat = lstatSync(path)
      const directory = lstatSync(dirname(path))
      if (!stat.isFile() || stat.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()) integrityMismatch()
      const canonical = canonicalEntry(path)
      const bytes = readFileSync(path)
      const parsed = validatedSkillMarkdown(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
      const manifestPath = join(dirname(path), packageManifestName)
      let manifest: Buffer | undefined
      try {
        const info = lstatSync(manifestPath)
        if (!info.isFile() || info.isSymbolicLink()) integrityMismatch()
        manifest = readFileSync(manifestPath)
        verifyPackageCache(path, manifest)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const skill: PiSkill = {
        name: parsed.metadata.name, description: parsed.metadata.description,
        disableModelInvocation: parsed.metadata['disable-model-invocation'] === true,
        filePath: path, baseDir: dirname(path),
        sourceInfo: { path, source: 'local', scope: 'temporary', origin: 'top-level', baseDir: dirname(path) },
      }
      return [path, { skill, canonical, prefix: parsed.compatibilityPrefix, sha256: createHash('sha256').update(bytes).digest('hex'), dev: stat.dev, ino: stat.ino, manifest }] as const
    } catch { return integrityMismatch() }
  }))
  const aliases = allocateSkillNames([...expected].map(([path, entry]) => ({
    id: path, name: entry.skill.name, source: common.has(path) ? 'common' : 'employee',
  })))
  // Validate entries separately before the SDK's name-based deduplication can discard one.
  for (const path of directories) validateBase(loadSkills({ cwd, agentDir, skillPaths: [path], includeDefaults: false }), false)

  function validateBase(base: ReturnType<PiLoadSkills>, requireAll = true): void {
    const collided = new Set<string>()
    for (const diagnostic of base.diagnostics) {
      const entry = diagnostic.path ? expected.get(resolve(diagnostic.path)) : undefined
      if (entry && diagnostic.type === 'collision' && diagnostic.collision?.resourceType === 'skill') {
        const winner = expected.get(resolve(diagnostic.collision.winnerPath))
        if (!winner || winner.skill.name !== entry.skill.name || diagnostic.collision.name !== entry.skill.name
          || resolve(diagnostic.collision.loserPath) !== resolve(diagnostic.path!)) integrityMismatch()
        collided.add(resolve(diagnostic.path!))
        continue
      }
      if (!entry || diagnostic.type !== 'warning') integrityMismatch()
      const nameWarning = diagnostic.message === 'name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)'
        || diagnostic.message === `name exceeds 64 characters (${entry.skill.name.length})` && Array.from(entry.skill.name).length <= 64
      // Pi 0.83 does not recognize prefixed frontmatter. Our strict parser already validated it.
      if (!nameWarning && !(entry.prefix && diagnostic.message === 'description is required')) integrityMismatch()
    }
    const seen = new Set<string>()
    for (const skill of base.skills) {
      const path = resolve(skill.filePath)
      const entry = expected.get(path)
      if (!entry || seen.has(path) || skill.name !== entry.skill.name || skill.description !== entry.skill.description ||
        skill.disableModelInvocation !== entry.skill.disableModelInvocation || resolve(skill.baseDir) !== dirname(path)) integrityMismatch()
      seen.add(path)
    }
    if (requireAll) for (const [path, entry] of expected) if (!entry.prefix && !seen.has(path) && !collided.has(path)) integrityMismatch()
  }

  return {
    // noSkills disables discovery but still loads additionalSkillPaths in SDK 0.83.0.
    noSkills: true,
    // The SDK invokes this on reload and extendResources, before publishing skills.
    skillsOverride(base) {
      validateBase(base)
      for (const [path, entry] of expected) {
        try {
          const stat = lstatSync(path)
          if (!stat.isFile() || stat.isSymbolicLink() || canonicalEntry(path) !== entry.canonical || stat.dev !== entry.dev || stat.ino !== entry.ino ||
            createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256) integrityMismatch()
          if (entry.manifest) verifyPackageCache(path, entry.manifest)
        } catch { integrityMismatch() }
      }
      return { skills: [...expected].map(([path, entry]) => ({ ...entry.skill, name: aliases.get(path)! })), diagnostics: [] }
    },
  }
}
